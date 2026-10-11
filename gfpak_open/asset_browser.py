"""Read-only local asset explorer for extracted game folders and archive metadata.

No console keys, decryption, or game downloads. NSP support is limited to its
outer PFS0 file table; encrypted NCA contents are not represented as decoded.
GFPAK resource types are inferred only when known hash relations establish
them. The original assets are never modified.
"""
from __future__ import annotations

import os
import re
import struct
import uuid
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

from .core import GFPak, GFPakError
from .nsp_explorer import NSPAnalyzer
from .model_discovery import infer_model_resources
from .converter import (HashDictionary, discover_dictionary, read_resource_names,
                        fnv1a64, REFERENCE_RE, safe_path, ConversionError)

MODEL = {".trmdl", ".gfbmdl", ".glb", ".gltf", ".fbx", ".obj", ".dae"}
MESH = {".trmsh", ".trmbf"}
ANIMATION = {".tranm", ".gfbanm", ".bck", ".bca", ".tracn", ".tracp", ".tracr", ".tracs"}
TEXTURE = {".bntx", ".png", ".dds", ".tga", ".jpg", ".jpeg", ".webp", ".trtex", ".bfttf"}
SKELETON = {".trskl"}
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
    def __init__(self):
        self._nodes: dict[str, dict] = {}
        self._keys: dict[tuple, str] = {}
        self._archives: dict[Path, GFPak] = {}
        self._zip_lists: dict[Path, tuple[list[str], dict[str, zipfile.ZipInfo]]] = {}
        self._inferred: dict[Path, dict[int, str]] = {}
        self._pfs: dict[Path, NSPAnalyzer] = {}
        self.root_id: str | None = None
        self.root_path: Path | None = None

    def _node(self, kind: str, path: Path, *, inner: str = "",
              index: int = -1, name: str | None = None,
              size: int | None = None) -> dict:
        key = (kind, str(path), inner, index)
        if key in self._keys:
            return self._nodes[self._keys[key]]
        id_ = uuid.uuid4().hex
        if name is None:
            name = path.name
        category = ("folder" if kind in {"directory", "zipdir"} else
                    classify(name) if kind != "gfpak_resource" else classify(name))
        result = {"id": id_, "kind": kind, "path": str(path), "name": name,
                  "category": category, "size": size if size is not None else 0,
                  "inner": inner, "index": index,
                  "expandable": kind in {"directory", "gfpak", "zip", "zipdir", "nsp"}}
        self._keys[key] = id_
        self._nodes[id_] = result
        return result

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

    def children(self, id_: str) -> dict:
        node = self.node(id_)
        kind = node["kind"]
        path = Path(node["path"])
        results = []
        if kind == "directory":
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
        elif kind == "nsp":
            if path not in self._pfs:
                self._pfs[path] = pfs0_entries(path)
            for i, entry in enumerate(self._pfs[path][:MAX_ENTRIES]):
                child = self._node("nspfile", path, index=i,
                                   name=entry["name"], size=entry["size"])
                child["category"] = entry["type"]
                results.append(child)
        counts = dict(Counter(row["category"] for row in results))
        return {"root": self._public(node), "entries": [self._public(c) for c in results],
                "counts": counts, "truncated": len(results) >= MAX_ENTRIES,
                "note": ("NSP shows only outer PFS0 entries. NCA game content is encrypted "
                         "and is not automatically decrypted or rendered."
                         if kind == "nsp" else
                         "Only hash-verified GFPAK resource types are labeled; unknown entries "
                         "may contain additional textures or animations."
                         if kind == "gfpak" else "")}

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
