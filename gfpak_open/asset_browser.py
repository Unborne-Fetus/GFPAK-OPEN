"""Read-only local asset explorer for extracted game folders and archive metadata.

No console keys, decryption, or game downloads. NSP support is limited to its
outer PFS0 file table; encrypted NCA contents are not represented as decoded.
GFPAK resource types are inferred only when known hash relations establish
them. The original assets are never modified.
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import struct
import tempfile
import uuid
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

from .core import GFPak, GFPakError
from .nsp_explorer import NSPAnalyzer
from .nca_sections import LocalNCASections
from .model_discovery import infer_model_resources
from .converter import (HashDictionary, discover_dictionary, read_resource_names,
                        fnv1a64, REFERENCE_RE, safe_path, ConversionError)

MODEL = {".trmdl", ".gfbmdl", ".glb", ".gltf", ".fbx", ".obj", ".dae"}
MESH = {".trmsh", ".trmbf"}
ANIMATION = {".tranm", ".gfbanm", ".bck", ".bca", ".tracn", ".tracp", ".tracr", ".tracs"}
TEXTURE = {".bntx", ".png", ".dds", ".tga", ".jpg", ".jpeg", ".webp", ".trtex", ".bfttf"}
SKELETON = {".trskl"}
METADATA = {".tik", ".cert", ".xml", ".json", ".cnmt"}
MATERIAL = {".trmtr", ".trmmt", ".mtl"}
ARCHIVE = {".gfpak", ".zip", ".nsp", ".xci"}
PREVIEW = {".trmdl", ".gfbmdl", ".glb", ".gfpak"}
MAX_ENTRIES = 2000
MAX_NSP_FILES = 50000
MAX_STRING_TABLE = 8 * 1024 * 1024


def classify(filename: str) -> str:
    """Conservative type detection; unknown hashes aren't claimed as textures."""
    p = Path(filename)
    ext = p.suffix.lower()
    if ext in MODEL:
        return "model"
    if ext in MESH:
        return "mesh"
    if ext in ANIMATION:
        return "animation"
    if ext in TEXTURE:
        return "texture"
    if ext in SKELETON:
        return "skeleton"
    if ext in METADATA:
        return "metadata"
    if ext in MATERIAL:
        return "material"
    if ext in ARCHIVE:
        if ext == ".gfpak" and re.match(r"^pm\d{4}", p.name, re.I):
            return "model archive"
        return "archive"
    if ext == ".nca":
        return "encrypted container"
    return "other"


def pfs0_entries(source: Path) -> list[dict]:
    """Backward-compatible outer package file table from full NSP analyzer."""
    reader = NSPAnalyzer(source)
    return [{"name": item.name, "type": classify(item.name),
             "size": item.size, "offset": item.offset}
            for item in reader.entries]


class AssetBrowser:
    def __init__(self, nca_workspace: Path | None = None):
        self._nodes: dict[str, dict] = {}
        self._keys: dict[tuple, str] = {}
        self._archives: dict[Path, GFPak] = {}
        self._zip_lists: dict[Path, tuple[list[str], dict[str, zipfile.ZipInfo]]] = {}
        self._inferred: dict[Path, dict[int, str]] = {}
        self._pfs: dict[Path, NSPAnalyzer] = {}
        self.root_id: str | None = None
        self.root_path: Path | None = None
        self._linked_extracted: dict | None = None
        self._nca_sections = LocalNCASections(nca_workspace or Path(tempfile.mkdtemp(prefix='GFPAK-nca-')))
        self._section_nodes: dict[str, tuple[int, int]] = {}

    def _node(self, kind: str, path: Path, *, inner: str = "",
              index: int = -1, name: str | None = None,
              size: int | None = None) -> dict:
        key = (kind, str(path), inner, index)
        if key in self._keys:
            return self._nodes[self._keys[key]]
        id_ = uuid.uuid4().hex
        if name is None:
            name = path.name
        category = ("folder" if kind in {"directory", "zipdir", "linked_dir"} else
                    classify(name) if kind != "gfpak_resource" else classify(name))
        result = {"id": id_, "kind": kind, "path": str(path), "name": name,
                  "category": category, "size": size if size is not None else 0,
                  "inner": inner, "index": index,
                  "expandable": kind in {"directory", "linked_dir", "nca_section", "gfpak", "zip", "zipdir", "nsp"}}
        self._keys[key] = id_
        self._nodes[id_] = result
        return result

    def configure_nca_reader(self, executable: str | Path = "", keyset: str | Path = ""):
        self._nca_sections.configure(executable, keyset)

    def open(self, path: str | Path) -> dict:
        candidate = Path(path).expanduser().resolve(strict=True)
        if not candidate.is_dir() and not candidate.is_file():
            raise ValueError("Select a file or directory")
        self._nodes.clear()
        self._keys.clear()
        self._archives.clear()
        self._zip_lists.clear()
        self._inferred.clear()
        self._pfs.clear()
        self._section_nodes.clear()
        self._linked_extracted = None
        self.root_path = candidate
        root = self._fs_node(candidate)
        self.root_id = root["id"]
        return self._public(root)

    def _fs_node(self, path: Path) -> dict:
        if path.is_dir():
            return self._node("directory", path, name=path.name)
        ext = path.suffix.lower()
        kind = {".gfpak": "gfpak", ".zip": "zip", ".nsp": "nsp"}.get(ext, "file")
        return self._node(kind, path, size=path.stat().st_size)

    @staticmethod
    def _public(node: dict) -> dict:
        # Expose metadata but not hidden backing paths.
        values = {key: node[key] for key in
                  ("id", "name", "kind", "category", "size", "expandable")}
        for field in ("role", "format", "offset", "content_id"):
            if field in node:
                values[field] = node[field]
        return values

    def node(self, id_: str) -> dict:
        if not isinstance(id_, str) or id_ not in self._nodes:
            raise ValueError("Unknown asset node; reopen your file browser")
        return self._nodes[id_]

    def _archive(self, path: Path) -> GFPak:
        if path not in self._archives:
            self._archives[path] = GFPak(path)
        return self._archives[path]

    def _known_names(self, path: Path) -> dict[int, str]:
        if path not in self._inferred:
            archive = self._archive(path)
            names = infer_model_resources(archive.resources, path.stem)
            dictionary = discover_dictionary(path)
            if dictionary:
                try:
                    names.update(read_resource_names(archive, HashDictionary(dictionary)))
                except (OSError, ValueError):
                    # A bad optional dictionary should not disable browsing.
                    pass
            # Decode only known model descriptors/materials. Their verified file
            # references can identify texture/skeleton/animation entries that
            # are otherwise indistinguishable hashed FlatBuffer resources.
            hashes = {}
            for resource in archive.resources:
                for key in (resource.path_hash, resource.file_hash):
                    if key:
                        hashes.setdefault(key, []).append(resource)
            for index, guessed in list(names.items()):
                if Path(guessed).suffix.lower() not in {".trmdl", ".trmtr", ".trmsh"}:
                    continue
                resource = archive.resources[index]
                if resource.size > 16 * 1024 * 1024:
                    continue
                try:
                    content = archive.read_resource(resource)
                except (GFPakError, OSError, ImportError):
                    continue
                for match in set(REFERENCE_RE.findall(content)):
                    try:
                        original = safe_path(match.decode("ascii")).as_posix()
                    except (UnicodeError, ConversionError):
                        continue
                    basename = original.rsplit("/", 1)[-1]
                    found = {}
                    for value in (fnv1a64(original), fnv1a64(basename)):
                        for target in hashes.get(value, []):
                            found[target.index] = target
                    if len(found) == 1:
                        target = next(iter(found.values()))
                        names.setdefault(target.index, original)
            self._inferred[path] = names
        return self._inferred[path]

    def _zip_data(self, path: Path):
        if path not in self._zip_lists:
            with zipfile.ZipFile(path) as zf:
                items = {}
                for row in zf.infolist():
                    filename = row.filename.replace("\\", "/")
                    p = PurePosixPath(filename)
                    if p.is_absolute() or ".." in p.parts or "\0" in filename:
                        continue
                    if not row.is_dir():
                        items[filename] = row
                self._zip_lists[path] = (sorted(items), items)
        return self._zip_lists[path]

    def attach_extracted(self, path: str | Path) -> dict:
        """Attach a user-chosen, already-extracted directory under an NSP root.

        This does not decrypt NCA data or claim these files came from one
        particular NCA section. Only the directory chosen by the user is read.
        """
        if self.root_path is None or self.root_path.suffix.lower() != ".nsp":
            raise ValueError("Open an NSP package before linking extracted game files")
        folder = Path(path).expanduser().resolve(strict=True)
        if not folder.is_dir():
            raise ValueError("The linked extraction must be a directory")
        node = self._node("linked_dir", folder,
                          name="Extracted game files (linked)")
        node["category"] = "folder"
        node["linked"] = True
        self._linked_extracted = node
        return self._public(node)

    def nsp_page(self, id_: str, page: int = 0, query: str = '',
                 category: str = 'all', limit: int = 250) -> dict:
        """Paginate/filter all NSP entries, including those past the UI row cap."""
        node = self.node(id_)
        if node['kind'] != 'nsp':
            raise ValueError('Select an NSP package for index browsing')
        reader = self.nsp_reader(Path(node['path']))
        page, limit = int(page), int(limit)
        if page < 0 or not 1 <= limit <= 500:
            raise ValueError('Invalid NSP page parameters')
        query = str(query).strip().lower()[:128]
        category = str(category).lower()[:64]
        valid = {'all', 'encrypted container', 'metadata', 'texture', 'archive',
                 'model archive', 'model', 'other'}
        if category not in valid:
            category = 'all'
        matches, counts = [], Counter()
        for entry in reader.entries:
            kind = classify(entry.name)
            counts[kind] += 1
            searchable = entry.name.lower() + ' ' + entry.role.lower() + ' ' + entry.format.lower()
            if query and query not in searchable:
                continue
            if category != 'all' and category != kind:
                continue
            matches.append(entry)
        total = len(matches)
        pages = max(1, (total + limit - 1) // limit)
        page = min(page, pages - 1)
        first = page * limit
        output = []
        for entry in matches[first:first + limit]:
            item = self._node('nspfile', Path(node['path']), index=entry.index,
                              name=entry.name, size=entry.size)
            item['category'] = classify(entry.name)
            item['expandable'] = entry.name.lower().endswith('.nca')
            item['role'] = entry.role
            item['format'] = entry.format
            item['content_id'] = entry.content_id
            item['offset'] = entry.offset
            output.append(self._public(item))
        if self._linked_extracted and page == 0 and not query and category == "all":
            output.insert(0, self._public(self._linked_extracted))
            counts["folder"] += 1
        return {'root': self._public(node), 'entries': output,
                'counts': dict(counts), 'truncated': total > limit,
                'pagination': {'page': page, 'pages': pages, 'page_size': limit,
                               'total': total, 'first': first + 1 if total else 0,
                               'last': first + len(output)},
                'note': 'Outer PFS0 only. NCA payloads remain encrypted.'}
    def children(self, id_: str) -> dict:
        node = self.node(id_)
        kind = node["kind"]
        path = Path(node["path"])
        if kind == "nsp":
            return self.nsp_page(id_)
        if kind == "nspfile" and node["name"].lower().endswith(".nca"):
            return self._nca_children(node)
        if kind == "nca_section":
            return self._section_children(node)
        results = []
        if kind in {"directory", "linked_dir"}:
            for entry in sorted(path.iterdir(),
                                key=lambda item: (not item.is_dir(), item.name.lower())):
                if entry.is_symlink():
                    continue
                if len(results) >= MAX_ENTRIES:
                    break
                try:
                    results.append(self._fs_node(entry))
                except (OSError, PermissionError):
                    continue
        elif kind == "gfpak":
            archive = self._archive(path)
            names = self._known_names(path)
            for resource in archive.resources[:MAX_ENTRIES]:
                label = names.get(resource.index)
                if label:
                    basename = label.rsplit("/", 1)[-1]
                    name = f"{resource.index:04d} · {basename}"
                    detected = classify(basename)
                else:
                    name = f"{resource.index:04d} · {resource.path_hash[:12]}… (unidentified)"
                    detected = "unknown"
                child = self._node("gfpak_resource", path, index=resource.index,
                                   name=name, size=resource.size)
                child["category"] = detected
                child["compression"] = resource.compression
                child["hash"] = resource.path_hash
                results.append(child)
        elif kind in {"zip", "zipdir"}:
            paths, meta = self._zip_data(path)
            prefix = node["inner"]
            names = {}
            for full in paths:
                if not full.startswith(prefix):
                    continue
                rest = full[len(prefix):]
                if not rest:
                    continue
                first, sep, tail = rest.partition("/")
                isdir = bool(sep)
                identifier = prefix + first + ("/" if isdir else "")
                if identifier in names:
                    continue
                names[identifier] = self._node(
                    "zipdir" if isdir else "zipfile", path,
                    inner=identifier, name=first,
                    size=0 if isdir else meta[full].file_size
                )
                if len(names) >= MAX_ENTRIES:
                    break
            results = sorted(names.values(),
                             key=lambda item: (not item["expandable"], item["name"].lower()))

        counts = dict(Counter(row["category"] for row in results))
        return {"root": self._public(node), "entries": [self._public(c) for c in results],
                "counts": counts, "truncated": len(results) >= MAX_ENTRIES,
                "note": ("NSP shows only outer PFS0 entries. NCA game content is encrypted "
                         "and is not automatically decrypted or rendered."
                         if kind == "nsp" else
                         "Only hash-verified GFPAK resource types are labeled; unknown entries "
                         "may contain additional textures or animations."
                         if kind == "gfpak" else "")}

    def nsp_reader(self, path: Path | None = None) -> NSPAnalyzer:
        if path is None:
            if self.root_path is None or self.root_path.suffix.lower() != ".nsp":
                raise ValueError("Open an NSP before using the NSP analyzer")
            path = self.root_path
        path = Path(path)
        if path not in self._pfs:
            self._pfs[path] = NSPAnalyzer(path)
        return self._pfs[path]

    def nsp_entry(self, node_id: str) -> tuple[NSPAnalyzer, int]:
        node = self.node(node_id)
        if node["kind"] != "nspfile":
            raise ValueError("Select an individual NSP file first")
        return self.nsp_reader(Path(node["path"])), node["index"]

    def nsp_inspect(self, node_id: str, offset: int = 0, length: int = 256) -> dict:
        analyzer, index = self.nsp_entry(node_id)
        return analyzer.inspect(index, offset=offset, length=length)

    def export_item(self, id_: str, target: str | Path) -> Path:
        """Export an explicitly selected supported member without modifying sources.

        Existing destination files cannot be overwritten. Zip and filesystem
        members are streamed; GFPAK members are decoded only if safely sized.
        """
        node = self.node(id_)
        kind = node["kind"]
        source = Path(node["path"])
        dest = Path(target)
        if not dest.parent.is_dir():
            raise ValueError("Choose an existing destination directory")
        if kind not in {"file", "zipfile", "gfpak_resource", "nspfile"}:
            raise ValueError("Select a file or resource, not a folder")
        if kind == "file" and dest.resolve() == source.resolve():
            raise ValueError("Cannot replace the source file")
        if kind == "nspfile":
            reader, index = self.nsp_entry(id_)
            return reader.export_raw(index, dest)
        with dest.open("xb") as output:
            try:
                if kind == "file":
                    with source.open("rb") as stream:
                        shutil.copyfileobj(stream, output, length=1024 * 1024)
                elif kind == "zipfile":
                    with zipfile.ZipFile(source) as archive:
                        member = archive.getinfo(node["inner"])
                        if member.file_size > 1024 * 1024 * 1024:
                            raise ValueError("ZIP member too large for this exporter")
                        with archive.open(member) as stream:
                            shutil.copyfileobj(stream, output, length=1024 * 1024)
                elif kind == "gfpak_resource":
                    archive = self._archive(source)
                    resource = archive.resources[node["index"]]
                    if resource.size > 256 * 1024 * 1024:
                        raise ValueError("GFPAK member too large for in-memory decoding")
                    output.write(archive.read_resource(resource))
            except Exception:
                output.close()
                dest.unlink(missing_ok=True)
                raise
        return dest

    def item_details(self, id_: str) -> dict:
        """Bounded content sniffing for the selected file in the native tree."""
        node = self.node(id_)
        kind = node["kind"]
        path = Path(node["path"])
        result = {
            "name": node["name"],
            "kind": kind,
            "category": node["category"],
            "size": node.get("size", 0),
            "location": str(path if kind in {"file", "directory", "linked_dir"} else path.name),
            "hex_lines": [],
            "signature": "",
            "thumbnail": None,
            "notes": [],
        }
        if kind in {"directory", "linked_dir", "zipdir", "nca_section", "nca_locked"}:
            result["notes"].append("Directory - expand it to inspect files.")
            return result
        if kind == "nspfile":
            inspected = self.nsp_inspect(id_, length=256)
            result.update({
                "size": inspected["size"], "hex_lines": inspected["hex_lines"],
                "signature": inspected["signature"],
                "notes": [inspected["note"]],
            })
            return result
        data = b""
        try:
            if kind == "gfpak_resource":
                resource = self._archive(path).resources[node["index"]]
                result["size"] = resource.size
                result["compression"] = resource.compression
                result["hash"] = resource.path_hash
                if resource.size <= 8 * 1024 * 1024:
                    data = self._archive(path).read_resource(resource)[:512]
                else:
                    result["notes"].append("Resource too large for inline preview.")
            elif kind == "zipfile":
                with zipfile.ZipFile(path) as archive:
                    entry = archive.getinfo(node["inner"])
                    if entry.file_size > 256 * 1024 * 1024:
                        result["notes"].append("Large ZIP member - preview limited.")
                    with archive.open(entry) as stream:
                        data = stream.read(512)
            elif kind == "file":
                with path.open("rb") as stream:
                    data = stream.read(512)
            else:
                result["notes"].append("Select a contained file for inspection.")
                return result
        except (OSError, ValueError, GFPakError, zipfile.BadZipFile) as exc:
            result["notes"].append("Preview unavailable: " + str(exc)[:250])
            return result
        for i in range(0, min(len(data), 256), 16):
            segment = data[i:i+16]
            result["hex_lines"].append({
                "offset": i,
                "hex": " ".join(f"{part:02X}" for part in segment),
                "ascii": "".join(chr(part) if 32 <= part < 127 else "." for part in segment),
            })
        signatures = [
            (b"GFLXPACK", "Game Freak GFPAK archive"),
            (b"PFS0", "Nintendo Switch PFS0 file table"),
            (b"glTF", "Binary glTF model"),
            (b"\x89PNG\r\n\x1a\n", "PNG image"),
            (b"\xff\xd8\xff", "JPEG image"),
            (b"DDS ", "DDS texture"),
            (b"BNTX", "BNTX texture container"),
            (b"PK\x03\x04", "ZIP container"),
        ]
        result["signature"] = next((name for magic, name in signatures
                                    if data.startswith(magic)), "Unrecognized binary data")
        if node["category"] == "texture" and kind == "file" and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            if path.stat().st_size < 2 * 1024 * 1024:
                mime = {"png": "image/png", "jpg": "image/jpeg",
                        "jpeg": "image/jpeg", "webp": "image/webp"}[path.suffix.lower()[1:]]
                result["thumbnail"] = "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")
        return result

    def preview_source(self, id_: str) -> Path:
        node = self.node(id_)
        kind = node["kind"]
        source = Path(node["path"])
        if kind in {"gfpak", "file"} and source.suffix.lower() in PREVIEW:
            return source
        if kind == "gfpak_resource" and node["category"] == "model":
            return source
        raise ValueError(
            "This entry cannot be previewed directly yet. Choose a .gfpak, .trmdl, "
            ".gfbmdl or .glb from an extracted directory. Encrypted NSP/NCA contents "
            "and standalone animations/textures are inspection-only."
        )

    def scan(self, limit: int = 40000, max_results: int = 1200) -> dict:
        """Bounded recursive metadata scan of a user-selected extracted directory."""
        if not self.root_path:
            raise ValueError("Select a folder first")
        if not self.root_path.is_dir():
            return {"counts": {}, "assets": [], "scanned": 0, "truncated": False}
        limit = min(max(int(limit), 1), 80000)
        counts = Counter()
        assets = []
        scanned = 0
        for base, dirs, files in os.walk(self.root_path, followlinks=False):
            dirs[:] = sorted(name for name in dirs if not (Path(base) / name).is_symlink())
            for name in sorted(files):
                item = Path(base) / name
                if item.is_symlink():
                    continue
                scanned += 1
                kind = classify(name)
                if kind != "other":
                    counts[kind] += 1
                    if len(assets) < max_results:
                        try:
                            node = self._fs_node(item)
                            row = self._public(node)
                            row["relative"] = str(item.relative_to(self.root_path)).replace("\\", "/")
                            assets.append(row)
                        except OSError:
                            pass
                if scanned >= limit:
                    return {"counts": dict(counts), "assets": assets,
                            "scanned": scanned, "truncated": True}
        return {"counts": dict(counts), "assets": assets,
                "scanned": scanned, "truncated": len(assets) >= max_results}
