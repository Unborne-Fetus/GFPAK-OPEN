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
from .nsp_explorer import NSPAnalyzer, NSPEntry
from .ncz_native import restore_ncz
from .xci_explorer import XCIImage, XCIPartition
from .nca_sections import LocalNCASections
from .model_discovery import infer_model_resources
from .pokemon_assets import group_related, pokemon_id
from .converter import (HashDictionary, discover_dictionary, read_resource_names,
                        fnv1a64, REFERENCE_RE, safe_path, ConversionError)

MODEL = {".trmdl", ".gfbmdl", ".glb", ".gltf", ".fbx", ".obj", ".dae"}
MESH = {".trmsh", ".trmbf"}
ANIMATION = {".tranm", ".gfbanm", ".bck", ".bca", ".tracn", ".tracp", ".tracr", ".tracs"}
TEXTURE = {".bntx", ".png", ".dds", ".tga", ".jpg", ".jpeg", ".webp", ".trtex", ".bfttf"}
SKELETON = {".trskl"}
METADATA = {".tik", ".cert", ".xml", ".json", ".cnmt"}
MATERIAL = {".trmtr", ".trmmt", ".mtl"}
ARCHIVE = {".gfpak", ".zip", ".nsp", ".nsz", ".xci", ".xcz"}
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
    if ext == ".ncz":
        return "compressed container"
    return "other"


def pfs0_entries(source: Path) -> list[dict]:
    """Backward-compatible outer package file table from full NSP analyzer."""
    reader = NSPAnalyzer(source)
    return [{"name": item.name, "type": classify(item.name),
             "size": item.size, "offset": item.offset}
            for item in reader.entries]


class _StandaloneNCA:
    """Adapter exposing one cached NCZ-restored NCA to the native NCA reader."""
    def __init__(self, path: Path):
        self.path = path
        self.entry = NSPEntry(0, path.name, 0, path.stat().st_size, 0, 0,
                              "Content archive NCA", "NCA", None)

    def get(self, index: int):
        if index != 0:
            raise ValueError("Invalid restored NCA index")
        return self.entry


class AssetBrowser:
    def __init__(self, nca_workspace: Path | None = None):
        self._nodes: dict[str, dict] = {}
        self._keys: dict[tuple, str] = {}
        self._archives: dict[Path, GFPak] = {}
        self._zip_lists: dict[Path, tuple[list[str], dict[str, zipfile.ZipInfo]]] = {}
        self._inferred: dict[Path, dict[int, str]] = {}
        self._pfs: dict[Path, NSPAnalyzer] = {}
        self._xci_images: dict[Path, XCIImage] = {}
        self._xci_partitions: dict[str, XCIPartition] = {}
        self._nca_sources: dict[str, NSPAnalyzer] = {}
        self._ncz_restored: dict[str, object] = {}
        self.root_id: str | None = None
        self.root_path: Path | None = None
        self._linked_extracted: dict | None = None
        self._linked_nca: dict[str, dict] = {}
        self._linked_base_nca: dict[str, Path] = {}
        self._nca_sections = LocalNCASections(nca_workspace or Path(tempfile.mkdtemp(prefix='GFPAK-nca-')))
        self._section_nodes: dict[str, tuple[int, int]] = {}
        self._nca_virtual_nodes: dict[str, tuple[int, int, str]] = {}

    def _node(self, kind: str, path: Path, *, inner: str = "",
              index: int = -1, name: str | None = None,
              size: int | None = None) -> dict:
        key = (kind, str(path), inner, index)
        if key in self._keys:
            return self._nodes[self._keys[key]]
        id_ = uuid.uuid4().hex
        if name is None:
            name = path.name
        category = ("folder" if kind in {"directory", "zipdir", "linked_dir", "nca_dir"} else
                    classify(name) if kind != "gfpak_resource" else classify(name))
        result = {"id": id_, "kind": kind, "path": str(path), "name": name,
                  "category": category, "size": size if size is not None else 0,
                  "inner": inner, "index": index,
                  "expandable": kind in {"directory", "linked_dir", "nca_section", "nca_dir", "gfpak", "zip", "zipdir", "nsp", "xci", "xci_partition"}}
        self._keys[key] = id_
        self._nodes[id_] = result
        return result

    def configure_nca_reader(self, keyset: str | Path = ""):
        self._nca_sections.configure(keyset)

    def open(self, path: str | Path) -> dict:
        candidate = Path(path).expanduser().resolve(strict=True)
        if not candidate.is_dir() and not candidate.is_file():
            raise ValueError("Select a file or directory")
        # Switching between giant compressed packages must not retain
        # gigabytes of session-only restored NCZ files or model previews.
        # Only these two app-owned directories may be cleared; never the NSP.
        for subfolder in ("ncz", "preview"):
            staged = self._nca_sections.workspace / subfolder
            if staged.is_dir():
                try:
                    shutil.rmtree(staged)
                except OSError:
                    # A concurrent converter or antivirus scanner may still
                    # hold a cached preview open on Windows. Do not prevent
                    # another game from opening; the session owns the cache.
                    pass
        self._nca_sections._readers.clear()
        for archive in self._archives.values():
            archive.close()
        self._nodes.clear()
        self._keys.clear()
        self._archives.clear()
        self._zip_lists.clear()
        self._inferred.clear()
        self._pfs.clear()
        self._xci_images.clear()
        self._xci_partitions.clear()
        self._nca_sources.clear()
        self._ncz_restored.clear()
        self._section_nodes.clear()
        self._nca_virtual_nodes.clear()
        self._linked_extracted = None
        self._linked_nca.clear()
        self._linked_base_nca.clear()
        self.root_path = candidate
        root = self._fs_node(candidate)
        self.root_id = root["id"]
        return self._public(root)

    def _fs_node(self, path: Path) -> dict:
        if path.is_dir():
            return self._node("directory", path, name=path.name)
        ext = path.suffix.lower()
        kind = {".gfpak": "gfpak", ".zip": "zip", ".nsp": "nsp",
                ".nsz": "nsp", ".xci": "xci", ".xcz": "xci"}.get(ext, "file")
        return self._node(kind, path, size=path.stat().st_size)

    @staticmethod
    def _public(node: dict) -> dict:
        # Expose metadata but not hidden backing paths.
        values = {key: node[key] for key in
                  ("id", "name", "kind", "category", "size", "expandable")}
        for field in ("role", "format", "offset", "content_id", "capabilities"):
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

    def attach_extracted_nca(self, node_id: str, path: str | Path) -> dict:
        """Link an existing extracted filesystem under its selected NCA entry.

        The folder contents come from the user's chosen directory, not from
        automatic NCA decryption. Do not fabricate section numbers.
        """
        node = self.node(node_id)
        if node["kind"] != "nspfile" or not node["name"].lower().endswith(".nca"):
            raise ValueError("Select an NCA from the file tree")
        folder = Path(path).expanduser().resolve(strict=True)
        if not folder.is_dir():
            raise ValueError("The linked extracted content must be an existing folder")
        linked = self._node("linked_dir", folder,
                            inner="nca-" + node_id,
                            name="Extracted files (linked)")
        linked["category"] = "folder"
        self._linked_nca[node_id] = linked
        return self._public(linked)

    def attach_base_nca(self, node_id: str, path: str | Path) -> dict:
        """Link a local standalone base NCA to a selected update NCA.

        The link is kept in memory only. No file is patched or overwritten.
        """
        node = self.node(node_id)
        if node["kind"] != "nspfile" or not node["name"].lower().endswith((".nca", ".ncz")):
            raise ValueError("Select the update NCA entry first")
        candidate = Path(path).expanduser().resolve(strict=True)
        if not candidate.is_file() or candidate.suffix.lower() != ".nca":
            raise ValueError("Choose an existing original .nca file")
        updated_reader, updated_index = self.nsp_entry(node_id)
        if node["name"].lower().endswith(".ncz"):
            # Expanding the NCZ first reconstructs the temporary NCA using
            # the same bounded, disk-space-checked path as normal browsing.
            if node_id not in self._ncz_restored:
                self._nca_children(node)
            updated_reader = self._ncz_restored[node_id]
            updated_index = 0
        base_reader = _StandaloneNCA(candidate)
        count = self._nca_sections.attach_base(updated_reader, updated_index, base_reader, 0)
        self._linked_base_nca[node_id] = candidate
        return {"basename": candidate.name, "matching_sections": count,
                "note": "Linked locally for compatible plaintext BKTR sections only."}

    def _xci_image(self, path: Path) -> XCIImage:
        if path not in self._xci_images:
            self._xci_images[path] = XCIImage(path)
        return self._xci_images[path]

    def _xci_root_children(self, node: dict) -> dict:
        image = self._xci_image(Path(node["path"]))
        entries = []
        for partition in image.partitions:
            child = self._node("xci_partition", image.path, inner=partition.name,
                               name=partition.name, size=partition.size)
            child["category"] = "folder"
            entries.append(child)
        return {
            "root": self._public(node),
            "entries": [self._public(item) for item in entries],
            "counts": {"folder": len(entries)},
            "truncated": False,
            "note": "Native XCI game-card HFS0 partitions. Expand secure to browse available NCA files.",
        }

    @staticmethod
    def _archive_page_start(cursor: str | None, count: int) -> int:
        if cursor is None:
            return 0
        if not isinstance(cursor, str) or not re.fullmatch(r"o:[0-9a-f]{8}", cursor):
            raise ValueError("Invalid archive directory pagination cursor")
        start = int(cursor[2:], 16)
        if start > count:
            raise ValueError("Archive directory cursor is outside its entries")
        return start

    def _xci_partition_children(self, node: dict, cursor: str | None = None) -> dict:
        part_id = node["id"]
        if part_id not in self._xci_partitions:
            image = self._xci_image(Path(node["path"]))
            self._xci_partitions[part_id] = image.open_partition(node["inner"])
        reader = self._xci_partitions[part_id]
        rows = []
        start = self._archive_page_start(cursor, len(reader.entries))
        limit = 250
        for entry in reader.entries[start:start + limit]:
            child = self._node("nspfile", reader.path,
                               inner=f"xci:{node['inner']}:{entry.index}",
                               index=entry.index, name=entry.name, size=entry.size)
            child["category"] = classify(entry.name)
            child["expandable"] = entry.name.lower().endswith((".nca", ".ncz"))
            child["role"] = entry.role
            child["format"] = entry.format
            child["offset"] = entry.offset
            self._nca_sources[child["id"]] = reader
            rows.append(child)
        next_start = start + len(rows)
        more = f"o:{next_start:08x}" if next_start < len(reader.entries) else None
        return {"root": self._public(node),
                "entries": [self._public(item) for item in rows],
                "counts": dict(Counter(row["category"] for row in rows)),
                "next_cursor": more, "truncated": bool(more),
                "note": "XCI HFS0 partition: load additional pages to browse every indexed file."}

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
        valid = {'all', 'encrypted container', 'compressed container', 'metadata', 'texture', 'archive',
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
            item['expandable'] = entry.name.lower().endswith(('.nca', '.ncz'))
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
    def children(self, id_: str, cursor: str | None = None) -> dict:
        node = self.node(id_)
        kind = node["kind"]
        path = Path(node["path"])
        if kind == "nsp":
            return self.nsp_page(id_)
        if kind == "xci":
            return self._xci_root_children(node)
        if kind == "xci_partition":
            return self._xci_partition_children(node, cursor)
        if kind == "nspfile" and node["name"].lower().endswith((".nca", ".ncz")):
            return self._nca_children(node)
        if kind == "nca_section":
            return self._section_children(node, cursor)
        if kind == "nca_dir":
            return self._virtual_nca_children(node, cursor)
        results = []
        limit = 250
        more = None
        if kind in {"directory", "linked_dir"}:
            paths = sorted((entry for entry in path.iterdir() if not entry.is_symlink()),
                           key=lambda entry: (not entry.is_dir(), entry.name.lower()))
            start = self._archive_page_start(cursor, len(paths))
            for entry in paths[start:start + limit]:
                try:
                    results.append(self._fs_node(entry))
                except (OSError, PermissionError):
                    continue
            end = min(len(paths), start + limit)
            more = f"o:{end:08x}" if end < len(paths) else None
        elif kind == "gfpak":
            archive = self._archive(path)
            names = self._known_names(path)
            start = self._archive_page_start(cursor, len(archive.resources))
            for resource in archive.resources[start:start + limit]:
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
            end = start + len(results)
            more = f"o:{end:08x}" if end < len(archive.resources) else None
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
            sorted_nodes = sorted(names.values(),
                                  key=lambda item: (not item["expandable"], item["name"].lower()))
            start = self._archive_page_start(cursor, len(sorted_nodes))
            results = sorted_nodes[start:start + limit]
            end = start + len(results)
            more = f"o:{end:08x}" if end < len(sorted_nodes) else None

        counts = dict(Counter(row["category"] for row in results))
        return {"root": self._public(node), "entries": [self._public(c) for c in results],
                "counts": counts, "next_cursor": more, "truncated": bool(more),
                "note": ("Loaded 250-item pages; use Load more for additional files. "
                         "Unknown resource types stay unidentified until verified."
                         if kind == "gfpak" else
                         "Loaded a directory page; use Load more to browse the remaining items.")}

    def _nca_children(self, node: dict) -> dict:
        reader = self._nca_sources.get(node["id"]) or self.nsp_reader(Path(node["path"]))
        index = node["index"]
        if node["name"].lower().endswith(".ncz"):
            if node["id"] not in self._ncz_restored:
                compressed = reader.get(index)
                cache = self._nca_sections.workspace / "ncz"
                cache.mkdir(parents=True, exist_ok=True)
                output = cache / (uuid.uuid4().hex + ".nca")
                restore_ncz(reader.path, compressed.offset, compressed.size, output)
                self._ncz_restored[node["id"]] = _StandaloneNCA(output)
            reader = self._ncz_restored[node["id"]]
            index = 0
        entries = []
        linked = self._linked_nca.get(node["id"])
        if linked:
            # An optional linked extraction must never hide sections that the
            # built-in reader can already browse from this NCA.
            entries.append(linked)
        try:
            for number in self._nca_sections.sections(reader, index):
                child = self._node("nca_section", reader.path, inner=node["id"],
                                   index=number, name=f"Section {number}")
                child["category"] = "folder"
                child["capabilities"] = self._nca_sections.section_info(reader, index, number)
                self._section_nodes[child["id"]] = (index, number)
                self._nca_sources[child["id"]] = reader
                entries.append(child)
            message = ("Identified " + str(len(entries) - int(bool(linked))) +
                       " NCA sections with the built-in reader." +
                       (" Linked files remain available separately." if linked else "") +
                       (" Base NCA: " + self._linked_base_nca[node["id"]].name
                        if node["id"] in self._linked_base_nca else ""))
        except (OSError, RuntimeError, ValueError) as error:
            message = str(error)
        if not entries:
            locked = self._node("nca_locked", reader.path, inner=node["id"],
                                name="Sections unavailable")
            locked["category"] = "locked"
            locked["error"] = message
            entries.append(locked)
        return {"root": self._public(node),
                "entries": [self._public(entry) for entry in entries],
                "counts": dict(Counter(entry["category"] for entry in entries)),
                "note": message, "truncated": False}


    def _section_children(self, node: dict, cursor: str | None = None) -> dict:
        pair = self._section_nodes.get(node["id"])
        if not pair:
            raise ValueError("This section does not exist in the selected NCA")
        index, section = pair
        return self._virtual_children(index, section, "", node, cursor)

    def _virtual_nca_children(self, node: dict, cursor: str | None = None) -> dict:
        position = self._nca_virtual_nodes.get(node["id"])
        if not position:
            raise ValueError("Unknown native NCA directory")
        index, section, path = position
        return self._virtual_children(index, section, path, node, cursor)

    def _virtual_children(self, index: int, section: int, folder: str,
                          parent: dict, cursor: str | None = None) -> dict:
        reader = self._nca_sources.get(parent["id"]) or self.nsp_reader(Path(parent["path"]))
        fs = self._nca_sections.filesystem(reader, index, section)
        # Real pagination rather than discarding all entries after a fixed cap.
        page = fs.children_page(folder, cursor=cursor, limit=250)
        rows = []
        for child in page["entries"]:
            is_dir = child["type"] == "directory"
            kind = "nca_dir" if is_dir else "nca_file"
            inner = f"{parent['id']}:{index}:{section}:{child['path']}"
            item = self._node(kind, reader.path, inner=inner, name=child["name"],
                              size=child["size"])
            item["category"] = "folder" if is_dir else classify(child["name"])
            self._nca_virtual_nodes[item["id"]] = (index, section, child["path"])
            self._nca_sources[item["id"]] = reader
            rows.append(item)
        more = page["next_cursor"]
        return {
            "root": self._public(parent),
            "entries": [self._public(item) for item in rows],
            "counts": dict(Counter(item["category"] for item in rows)),
            "note": ("Browsing a large NCA section in pages of 250. "
                     "Use Load more to continue; files are read directly "
                     "without extracting the full game."),
            "next_cursor": more,
            "truncated": more is not None,
        }

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
        return self._nca_sources.get(node["id"]) or self.nsp_reader(Path(node["path"])), node["index"]

    def nsp_inspect(self, node_id: str, offset: int = 0, length: int = 256) -> dict:
        analyzer, index = self.nsp_entry(node_id)
        return analyzer.inspect(index, offset=offset, length=length)

    def _nca_virtual_file(self, node: dict):
        position = self._nca_virtual_nodes.get(node["id"])
        if not position:
            raise ValueError("The selected NCA file is no longer available")
        index, section, name = position
        reader = self._nca_sources.get(node["id"]) or self.nsp_reader(Path(node["path"]))
        return reader, index, section, name

    def export_item(self, id_: str, target: str | Path, *, packed: bool = False) -> Path:
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
        if kind not in {"file", "zipfile", "gfpak_resource", "nspfile", "nca_file"}:
            raise ValueError("Select a file or resource, not a folder")
        if packed and kind != "gfpak_resource":
            raise ValueError("Packed export is supported for GFPAK resources only")
        if kind == "file" and dest.resolve() == source.resolve():
            raise ValueError("Cannot replace the source file")
        if kind == "nspfile":
            reader, index = self.nsp_entry(id_)
            return reader.export_raw(index, dest)
        if kind == "nca_file":
            reader, index, section, name = self._nca_virtual_file(node)
            return self._nca_sections.extract_one(reader, index, section, name, dest)
        if kind == "gfpak_resource":
            archive = self._archive(source)
            return archive.copy_resource(archive.resources[node["index"]], dest, packed=packed)
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
            except Exception:
                output.close()
                dest.unlink(missing_ok=True)
                raise
        return dest

    def asset_family(self, id_: str) -> dict:
        """Related assets currently discovered by browsing real game resources."""
        node = self.node(id_)
        def display_path(item: dict) -> str:
            if item["kind"] in {"nca_file", "nca_dir"}:
                return self._nca_virtual_nodes[item["id"]][2]
            if item["kind"] == "file":
                return str(item["path"])
            return item["name"].split(" · ", 1)[-1]
        selected = display_path(node)
        known = [display_path(item) for item in self._nodes.values()
                 if item["kind"] in {"file", "nca_file", "gfpak_resource", "zipfile"}]
        return group_related(selected, known)

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
        if kind == "nca_locked":
            result["notes"].append(node.get("error") or
                                   "The NCA sections cannot be read with the current configuration.")
            return result
        if kind in {"directory", "linked_dir", "zipdir", "nca_section", "nca_dir"}:
            features = node.get("capabilities")
            if features:
                statuses = []
                if features["update_patch"]:
                    statuses.append("BKTR update/DLC patch data detected; base NCA overlay not yet implemented")
                if features["sparse"]:
                    statuses.append("Sparse BucketTree detected; plaintext mappings work, encrypted sparse IV handling remains limited")
                if features["compressed_storage"]:
                    statuses.append("Compressed BucketTree detected; stored, zero and LZ4 blocks supported for compatible unpatched sections")
                result["notes"].extend(statuses or ["Compatible filesystem section"])
                result["capabilities"] = features
            else:
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
            if kind == "nca_file":
                reader, index, section, name = self._nca_virtual_file(node)
                data = self._nca_sections.preview_bytes(reader, index, section, name)
                result["notes"].append("Read directly from NCA filesystem without bulk extraction.")
            elif kind == "gfpak_resource":
                resource = self._archive(path).resources[node["index"]]
                result["size"] = resource.size
                result["compression"] = resource.compression
                result["hash"] = resource.path_hash
                result["packed_size"] = resource.packed_size
                result["offset"] = resource.offset
                data, decoded = self._archive(path).peek_resource(resource)
                if not decoded:
                    result["notes"].append("Showing packed bytes; decoded preview exceeds the safe limit.")
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
        # Give the built-in properties pane the same small-image previews
        # whether assets are loose files, ZIP members or native NCA files.
        ext = Path(node["name"]).suffix.lower()
        mimes = {".png": "image/png", ".jpg": "image/jpeg",
                 ".jpeg": "image/jpeg", ".webp": "image/webp"}
        if node["category"] == "texture" and ext in mimes:
            maximum = 2 * 1024 * 1024
            picture = None
            if kind == "file" and path.stat().st_size <= maximum:
                picture = path.read_bytes()
            elif kind == "nca_file":
                reader, index, section, name = self._nca_virtual_file(node)
                fs = self._nca_sections.filesystem(reader, index, section)
                meta = fs.file(name)
                if meta.size <= maximum:
                    from .nca_native import read_file
                    picture = read_file(fs, name, length=meta.size)
            elif kind == "zipfile":
                with zipfile.ZipFile(path) as archive:
                    entry = archive.getinfo(node["inner"])
                    if entry.file_size <= maximum:
                        with archive.open(entry) as stream:
                            picture = stream.read(maximum + 1)
            if picture and len(picture) <= maximum:
                result["thumbnail"] = (
                    "data:" + mimes[ext] + ";base64," +
                    base64.b64encode(picture).decode("ascii")
                )
        return result

    def fast_texture_item(self, id_: str) -> dict:
        """Safely prepare a single texture for the integrated viewer.

        The selected asset stays in its original source archive; the local
        HTTP stream accesses its bytes only when the user requests a preview.
        """
        selected = self.node(id_)
        kind = selected["kind"]
        if selected["category"] != "texture":
            raise ValueError("Select a recognized texture first")
        if kind == "file":
            source = Path(selected["path"])
            name = source.name
            size = source.stat().st_size
            descriptor = ("file", source)
        elif kind == "zipfile":
            source = Path(selected["path"])
            name = selected["inner"]
            _, members = self._zip_data(source)
            size = members[name].file_size
            descriptor = ("zip", source, name)
        elif kind == "nca_file":
            reader, index, section, name = self._nca_virtual_file(selected)
            size = self._nca_sections.file_info(reader, index, section, name).size
            descriptor = ("nca", reader, index, section, name)
        elif kind == "gfpak_resource":
            source = Path(selected["path"])
            archive = self._archive(source)
            resource = archive.resources[selected["index"]]
            name = self._known_names(source).get(selected["index"], "")
            size = resource.size
            descriptor = ("gfpak", source, selected["index"])
        else:
            raise ValueError("Texture is not available as a readable file")
        if Path(name).suffix.lower() not in {
            ".bntx", ".dds", ".png", ".jpg", ".jpeg", ".webp"
        }:
            raise ValueError("Only compatible BNTX, DDS and image previews are supported")
        if size <= 0 or size > 256 * 1024 * 1024:
            raise ValueError("Texture exceeds the 256 MiB safe preview limit")
        return {"path": name, "size": size, "source": descriptor}

    def _fast_gfpak_preview_items(self, selected: dict) -> dict:
        """Expose resolved GFPAK resources as lazy native assets, without Blender.

        Decoded data is streamed only when requested by the browser viewer.
        Do not extract the whole archive or guess unresolved hashed filenames.
        """
        archive = self._archive(Path(selected["path"]))
        known = self._known_names(Path(selected["path"]))
        models = sorted(
            ((index, name) for index, name in known.items()
             if Path(name).suffix.lower() in {".trmdl", ".gfbmdl"}
             and index < len(archive.resources)),
            key=lambda item: (Path(item[1]).suffix.lower() != ".trmdl", item[0]))
        if selected["kind"] == "gfpak_resource":
            models = [row for row in models if row[0] == selected["index"]]
        if not models:
            raise ValueError(
                "No resolved native GFBMDL/TRMDL resource was found. "
                "The original converter can still attempt this GFPAK.")
        selected_index, selected_name = models[0]
        from .pokemon_assets import pokemon_id
        family = pokemon_id(selected_name)
        allowed = MODEL | MESH | ANIMATION | TEXTURE | SKELETON | MATERIAL | {".bin", ".mtl"}
        entries = []
        selected_resource = archive.resources[selected_index]
        if selected_resource.size > 450 * 1024 * 1024:
            raise ValueError("Native model is too large for the direct browser preview")
        entries.append({
            "path": selected_name, "size": selected_resource.size,
            "source": ("gfpak", archive.source, selected_index)
        })
        used_paths = {selected_name.lower()}
        for index, name in sorted(known.items()):
            if index == selected_index or not 0 <= index < len(archive.resources):
                continue
            if Path(name).suffix.lower() not in allowed:
                continue
            resource = archive.resources[index]
            if resource.size > 128 * 1024 * 1024 or resource.size < 0:
                continue
            if family and pokemon_id(name) not in ("", family):
                continue
            if name.lower() in used_paths:
                continue
            used_paths.add(name.lower())
            entries.append({
                "path": name, "size": resource.size,
                "source": ("gfpak", archive.source, index)
            })
            if len(entries) >= 400:
                break
        return {
            "label": selected["name"], "selected": selected_name, "items": entries
        }

    def fast_preview_items(self, id_: str) -> dict:
        """Identify lazy, read-only browser-native model dependencies.

        Only filenames and byte lengths are indexed here. No Blender process,
        full NCA extraction, GFPAK unpack or texture decompression occurs until
        the web-native decoder requests a particular selected file.
        """
        selected = self.node(id_)
        if selected["kind"] in {"gfpak", "gfpak_resource"}:
            return self._fast_gfpak_preview_items(selected)
        if selected["kind"] not in {"file", "nca_file", "zipfile"}:
            raise ValueError("This archive requires the fallback converter")
        model_name = selected["name"] if selected["kind"] != "zipfile" else selected["inner"]
        if Path(model_name).suffix.lower() not in {
            ".glb", ".gltf", ".fbx", ".obj", ".dae",
            ".trmdl", ".trmsh", ".gfbmdl",
        }:
            raise ValueError("This format requires the fallback converter")
        allowed = MODEL | MESH | ANIMATION | TEXTURE | SKELETON | MATERIAL | {".bin", ".mtl"}
        from .pokemon_assets import pokemon_id
        token = pokemon_id(model_name)
        parent = model_name.replace("\\", "/").rpartition("/")[0]
        entries = []
        def include(name: str, size: int, location: tuple):
            if Path(name).suffix.lower() not in allowed or size < 0 or size > 450 * 1024 * 1024:
                return
            if token and pokemon_id(name) not in ("", token):
                return
            entries.append({"path": name, "size": size, "source": location})

        if selected["kind"] == "file":
            source = Path(selected["path"])
            include(source.name, source.stat().st_size, ("file", source))
            for sibling in source.parent.iterdir():
                if len(entries) >= 400:
                    break
                if sibling == source or not sibling.is_file() or sibling.is_symlink():
                    continue
                if sibling.suffix.lower() not in allowed:
                    continue
                include(sibling.name, sibling.stat().st_size, ("file", sibling))
        elif selected["kind"] == "zipfile":
            path = Path(selected["path"])
            _, members = self._zip_data(path)
            full = selected["inner"]
            parent = full.rpartition("/")[0]
            if full not in members:
                raise ValueError("Selected ZIP member no longer exists")
            include(full, members[full].file_size, ("zip", path, full))
            for filename, meta in members.items():
                if len(entries) >= 400:
                    break
                if filename == full or filename.rpartition("/")[0] != parent:
                    continue
                include(filename, meta.file_size, ("zip", path, filename))
        else:
            reader, index, section, full = self._nca_virtual_file(selected)
            model_name = full
            parent = full.rpartition("/")[0]
            fs = self._nca_sections.filesystem(reader, index, section)
            info = fs.file(full)
            include(full, info.size, ("nca", reader, index, section, full))
            cursor = None
            for _ in range(32):
                page = fs.children_page(parent, cursor=cursor, limit=250)
                for row in page["entries"]:
                    if len(entries) >= 400:
                        break
                    if row["type"] != "file" or row["path"] == full:
                        continue
                    include(row["path"], row["size"],
                            ("nca", reader, index, section, row["path"]))
                cursor = page["next_cursor"]
                if not cursor or len(entries) >= 400:
                    break
        if not entries or entries[0]["path"] != model_name:
            raise ValueError("The selected native model is not readable")
        return {"label": selected["name"], "selected": model_name, "items": entries}

    def stream_fast_preview_item(self, descriptor: tuple):
        """Return the byte length and bounded chunk generator for a whitelisted file."""
        kind = descriptor[0]
        if kind == "gfpak":
            archive = self._archive(Path(descriptor[1]))
            index = descriptor[2]
            if not 0 <= index < len(archive.resources):
                raise ValueError("Unknown GFPAK preview resource")
            resource = archive.resources[index]
            if resource.size > 450 * 1024 * 1024:
                raise ValueError("GFPAK preview resource is too large")
            def chunks():
                # Directly stream stored files without extra copies. Compressed
                # resources are decoded one at a time, never unpacking the
                # complete archive or invoking Blender for compatible models.
                if resource.compression == 0:
                    remaining = resource.packed_size
                    if resource.size != remaining:
                        raise ValueError("Stored GFPAK resource size mismatch")
                    with archive.source.open("rb") as file:
                        file.seek(resource.offset)
                        while remaining:
                            part = file.read(min(1024 * 1024, remaining))
                            if not part:
                                raise ValueError("GFPAK resource ended unexpectedly")
                            yield part
                            remaining -= len(part)
                else:
                    decoded = archive.read_resource(resource)
                    for at in range(0, len(decoded), 1024 * 1024):
                        yield decoded[at:at + 1024 * 1024]
            return resource.size, chunks()
        if kind == "file":
            file = descriptor[1]
            size = file.stat().st_size
            def chunks():
                with file.open("rb") as handle:
                    while part := handle.read(1024 * 1024):
                        yield part
            return size, chunks()
        if kind == "zip":
            _, archive, name = descriptor
            with zipfile.ZipFile(archive) as zf:
                size = zf.getinfo(name).file_size
            def chunks():
                with zipfile.ZipFile(archive) as zf, zf.open(name) as handle:
                    while part := handle.read(1024 * 1024):
                        yield part
            return size, chunks()
        if kind == "nca":
            _, reader, index, section, name = descriptor
            fs = self._nca_sections.filesystem(reader, index, section)
            info = fs.file(name)
            def chunks():
                for offset in range(0, info.size, 1024 * 1024):
                    yield fs.section.read(
                        info.offset + offset, min(1024 * 1024, info.size - offset))
            return info.size, chunks()
        raise ValueError("Unsupported native asset stream")

    def preview_source(self, id_: str) -> Path:
        node = self.node(id_)
        kind = node["kind"]
        source = Path(node["path"])
        if kind in {"gfpak", "file"} and source.suffix.lower() in PREVIEW:
            return source
        if kind == "gfpak_resource" and node["category"] == "model":
            return source
        if kind == "nca_file" and Path(node["name"]).suffix.lower() in PREVIEW:
            reader, index, section, name = self._nca_virtual_file(node)
            info = self._nca_sections.file_info(reader, index, section, name)
            if info.size > 512 * 1024 * 1024:
                raise ValueError("Model is too large for temporary preview; export it explicitly.")
            directory = self._nca_sections.workspace / "preview" / uuid.uuid4().hex
            directory.mkdir(parents=True, exist_ok=False)
            # Preserve the actual filename so the native model importer can
            # recognize Pokémon IDs and resource families during preview.
            target = directory / Path(node["name"]).name
            output = self._nca_sections.extract_one(reader, index, section, name, target)
            # When the selected model is a loose TRMDL/GFBMDL file inside an
            # NSP/XCI/NSZ, prepare its real sibling resources so Blender can
            # resolve the referenced meshes, materials, textures and clips.
            ext = target.suffix.lower()
            if ext in {".trmdl", ".gfbmdl"}:
                from .pokemon_assets import pokemon_id
                token = pokemon_id(name)
                if token:
                    try:
                        fs = self._nca_sections.filesystem(reader, index, section)
                        parent = name.rpartition("/")[0]
                        companion_types = {
                            ".trmsh", ".trmbf", ".trmtr", ".trskl", ".tranm",
                            ".gfbanm", ".dds", ".png", ".jpg", ".webp", ".bntx"
                        }
                        total = 0
                        added = 0
                        # Walk bounded directory pages, not just the first
                        # 250 files; model companions often sort much later.
                        cursor = None
                        for _ in range(32):
                            batch = fs.children_page(parent, cursor=cursor, limit=250)
                            for row in batch["entries"]:
                                if added >= 48 or total >= 128 * 1024 * 1024:
                                    break
                                if row["type"] != "file" or row["path"] == name:
                                    continue
                                if pokemon_id(row["path"]) != token:
                                    continue
                                companion_name = row["name"]
                                if Path(companion_name).suffix.lower() not in companion_types:
                                    continue
                                size = row["size"]
                                if (size <= 0 or size > 64 * 1024 * 1024 or
                                        total + size > 128 * 1024 * 1024):
                                    continue
                                sibling_target = directory / companion_name
                                if sibling_target.is_file():
                                    continue
                                try:
                                    self._nca_sections.extract_one(
                                        reader, index, section, row["path"], sibling_target)
                                except (OSError, ValueError):
                                    continue
                                total += size
                                added += 1
                            cursor = batch["next_cursor"]
                            if not cursor or added >= 48 or total >= 128 * 1024 * 1024:
                                break
                    except (OSError, ValueError):
                        pass
            return output
        raise ValueError(
            "This entry cannot be previewed directly yet. Choose a .gfpak, .trmdl, "
            ".gfbmdl or .glb from an extracted directory. Encrypted NSP/NCA contents "
            "and standalone animations/textures are inspection-only."
        )

    def scan_nca_assets(self, node_id: str, limit: int = 40000,
                        max_results: int = 1200) -> dict:
        """Locate native model/texture/animation names across a RomFS subtree.

        Uses only directory metadata (no file payloads, Blender, or archive
        extraction). Traversal and returned nodes have independent bounds.
        Newly discovered files remain real navigable virtual-NCA nodes.
        """
        node = self.node(node_id)
        if node["kind"] == "nca_section":
            if node_id not in self._section_nodes:
                raise ValueError("Selected NCA section has expired")
            index, section = self._section_nodes[node_id]
            folder = ""
        elif node["kind"] == "nca_dir":
            index, section, folder = self._nca_virtual_nodes[node_id]
        else:
            raise ValueError("Choose a readable NCA section or directory")
        reader = self._nca_sources.get(node_id) or self.nsp_reader(Path(node["path"]))
        fs = self._nca_sections.filesystem(reader, index, section)
        limit = min(max(1, int(limit)), 80000)
        max_results = min(max(1, int(max_results)), 5000)
        pending = [folder]
        found = []
        counts = Counter()
        scanned = 0
        truncated = False
        while pending:
            current = pending.pop()
            cursor = None
            while True:
                page = fs.children_page(current, cursor=cursor, limit=250)
                for entry in page["entries"]:
                    scanned += 1
                    if entry["type"] == "directory":
                        # Keep traversal bounded even with huge nested RomFS trees.
                        pending.append(entry["path"])
                    else:
                        category = classify(entry["name"])
                        if category in ("model", "model archive", "mesh",
                                        "texture", "animation"):
                            counts[category] += 1
                            if len(found) < max_results:
                                inner = f"{node_id}:{index}:{section}:{entry['path']}"
                                child = self._node("nca_file", reader.path, inner=inner,
                                                   name=entry["name"], size=entry["size"])
                                child["category"] = category
                                self._nca_virtual_nodes[child["id"]] = (
                                    index, section, entry["path"])
                                self._nca_sources[child["id"]] = reader
                                row = self._public(child)
                                row["relative"] = entry["path"]
                                found.append(row)
                    if scanned >= limit:
                        truncated = True
                        break
                if truncated or not page["next_cursor"]:
                    break
                cursor = page["next_cursor"]
            if truncated:
                break
        return {
            "counts": dict(counts), "assets": found, "scanned": scanned,
            "truncated": truncated or sum(counts.values()) > max_results,
            "unresolved": counts.get("model archive", 0) > 0 or counts.get("archive", 0) > 0,
            "source": "RomFS", "source_node": node_id
        }

    def scan_gfpak_assets(self, node_id: str, max_results: int = 1200) -> dict:
        """Categorize every indexed GFPAK member, not merely the first page.

        Names are accepted only from hash validation, model-family inference or
        decoded references. Unknown hashes remain visible as unidentified.
        Resource bodies are not unpacked during this catalog pass.
        """
        node = self.node(node_id)
        if node["kind"] != "gfpak":
            raise ValueError("Select a GFPAK archive for its resource catalog")
        archive = self._archive(Path(node["path"]))
        names = self._known_names(Path(node["path"]))
        counts = Counter()
        assets = []
        for resource in archive.resources:
            known = names.get(resource.index, "")
            category = classify(known) if known else "unknown"
            counts[category] += 1
            if len(assets) >= max_results or category not in (
                    "model", "mesh", "model archive", "texture", "animation"):
                continue
            display = f"{resource.index:04d} · {known.rsplit('/', 1)[-1]}"
            item = self._node("gfpak_resource", archive.source, index=resource.index,
                              name=display, size=resource.size)
            item["category"] = category
            item["compression"] = resource.compression
            row = self._public(item)
            row["relative"] = known
            assets.append(row)
        return {
            "counts": dict(counts), "assets": assets,
            "scanned": len(archive.resources),
            "truncated": sum(counts[k] for k in (
                "model", "mesh", "model archive", "texture", "animation")) > max_results,
            "unresolved": bool(counts.get("unknown", 0)),
            "source": "GFPAK",
            "note": (f"{counts.get('unknown', 0)} resource hashes remain unidentified. "
                     "Their types cannot be verified from the archive index alone.")
        }

    def scan_game_assets(self, node_id: str, limit: int = 40000,
                         max_results: int = 1200, max_ncas: int = 64) -> dict:
        """Inventory readable NCA sections across a selected NSP/XCI source.

        This is a bounded metadata-only scan. Inaccessible encrypted content
        and nested GFPAK payload types are reported as unresolved, never zero.
        """
        root = self.node(node_id)
        if root["kind"] not in {"nsp", "xci", "xci_partition", "nspfile"}:
            raise ValueError("Choose a game package or an NCA")
        if root["kind"] == "nspfile":
            packages = [(self._nca_sources.get(node_id) or self.nsp_reader(Path(root["path"])),
                         [root["index"]], root["name"])]
        elif root["kind"] == "nsp":
            reader = self.nsp_reader(Path(root["path"]))
            packages = [(reader,
                         [row.index for row in reader.entries
                          if row.name.lower().endswith((".nca", ".ncz"))],
                         root["name"])]
        elif root["kind"] == "xci_partition":
            image = self._xci_image(Path(root["path"]))
            reader = self._xci_partitions.get(node_id) or image.open_partition(root["inner"])
            self._xci_partitions[node_id] = reader
            packages = [(reader,
                         [row.index for row in reader.entries
                          if row.name.lower().endswith((".nca", ".ncz"))],
                         root["inner"])]
        else:
            image = self._xci_image(Path(root["path"]))
            packages = []
            for partition in image.partitions:
                reader = image.open_partition(partition.name)
                packages.append((reader,
                                 [row.index for row in reader.entries
                                  if row.name.lower().endswith((".nca", ".ncz"))],
                                 partition.name))
        counts, assets, warnings = Counter(), [], []
        inspected = 0
        scanned_ncas = 0
        total_ncas = sum(len(indices) for _, indices, _ in packages)
        max_ncas = max(1, min(int(max_ncas), 128))
        for reader, indices, partition in packages:
            for index in indices:
                if scanned_ncas >= max_ncas or inspected >= limit or len(assets) >= max_results:
                    break
                entry = reader.get(index)
                scanned_ncas += 1
                if entry.name.lower().endswith(".ncz"):
                    warnings.append(entry.name + ": compressed NCZ requires opening its restored NCA first")
                    continue
                inner = f"catalog:{partition}:{index}"
                item = self._node("nspfile", reader.path, inner=inner,
                                  index=index, name=entry.name, size=entry.size)
                self._nca_sources[item["id"]] = reader
                try:
                    sections = self._nca_children(item)["entries"]
                except (OSError, RuntimeError, ValueError) as exc:
                    warnings.append(entry.name + ": " + str(exc)[:100])
                    continue
                for section in sections:
                    if section["kind"] == "nca_locked":
                        warnings.append(entry.name + ": " +
                                        section["name"] + " (decryption or format unavailable)")
                        continue
                    if section["kind"] != "nca_section":
                        continue
                    if inspected >= limit or len(assets) >= max_results:
                        break
                    try:
                        result = self.scan_nca_assets(
                            section["id"], limit=limit-inspected,
                            max_results=max_results-len(assets))
                    except (OSError, RuntimeError, ValueError) as exc:
                        warnings.append(entry.name + "/" + section["name"] +
                                        ": " + str(exc)[:110])
                        continue
                    inspected += result["scanned"]
                    counts.update(result["counts"])
                    assets.extend(result["assets"])
                    if result["truncated"]:
                        warnings.append("Scan limit reached inside " + entry.name)
                        break
            if scanned_ncas >= max_ncas or inspected >= limit or len(assets) >= max_results:
                break
        if scanned_ncas < total_ncas:
            warnings.append(f"Inspected {scanned_ncas} of {total_ncas} NCAs; use individual sections to refine.")
        return {
            "counts": dict(counts), "assets": assets, "scanned": inspected,
            "source": "Game package", "scanned_ncas": scanned_ncas,
            "total_ncas": total_ncas,
            "truncated": inspected >= limit or len(assets) >= max_results or
                         scanned_ncas < total_ncas,
            "unresolved": bool(warnings) or counts.get("model archive", 0) > 0 or
                          counts.get("archive", 0) > 0,
            "warnings": warnings[:16],
            "note": ("Some NCA sections may require keys, base updates or unsupported decoding. "
                     "GFPAK archives are listed; their internal hashed files are not "
                     "assumed to be textures or animations.")
        }

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
