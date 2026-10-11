"""Read-only GFLXPACK / GFPAK index reader and bounded resource extraction.

Game assets, hash dictionaries, and proprietary decoders are not bundled.
"""
from __future__ import annotations

import ctypes
import os
import re
import shutil
import json
import struct
from dataclasses import asdict, dataclass
from pathlib import Path


class GFPakError(ValueError):
    """Invalid archive or unavailable decompression backend."""


@dataclass(frozen=True)
class Resource:
    index: int
    level: int
    compression: int
    size: int
    packed_size: int
    offset: int
    path_hash: str
    folder: int | None
    folder_hash: str | None
    file_hash: str | None

    @property
    def filename(self) -> str:
        return f"{self.index:04d}_{self.path_hash}.bin"

    @property
    def folder_name(self) -> str:
        return f"folder_{self.folder:02d}_{self.folder_hash}" if self.folder is not None else "unassigned"


class GFPak:
    MAX_FILES = 250_000
    MAX_SINGLE_FILE = 512 * 1024 * 1024

    def __init__(self, source: str | Path):
        self.source = Path(source)
        self._bytes = self.source.read_bytes()
        self.version = 0
        self.relocated = 0
        self.resources: list[Resource] = []
        self.folder_count = 0
        self._parse()

    def _read(self, fmt: str, at: int) -> tuple:
        size = struct.calcsize(fmt)
        if at < 0 or at + size > len(self._bytes):
            raise GFPakError(f"Invalid archive: out-of-bounds structure at 0x{at:X}")
        return struct.unpack_from(fmt, self._bytes, at)

    def _parse(self) -> None:
        if self._bytes[:8] != b"GFLXPACK":
            raise GFPakError("Not a GFLXPACK archive")
        if len(self._bytes) < 40:
            raise GFPakError("Truncated GFLXPACK header")
        self.version, self.relocated, count, self.folder_count = self._read("<4I", 8)
        if count > self.MAX_FILES or self.folder_count > self.MAX_FILES:
            raise GFPakError("Archive declares an unreasonable number of entries")
        table_offset, paths_offset = self._read("<QQ", 24)
        folder_offsets = [self._read("<Q", 40 + i * 8)[0] for i in range(self.folder_count)]
        global_hashes = [self._read("<Q", paths_offset + i * 8)[0] for i in range(count)]

        associations: dict[int, tuple[int, int, int]] = {}
        for folder_number, offset in enumerate(folder_offsets):
            folder_hash, folder_files, _ = self._read("<QII", offset)
            if folder_files > count:
                raise GFPakError("Folder references more files than the archive contains")
            for i in range(folder_files):
                file_hash, index, _ = self._read("<QII", offset + 16 + i * 16)
                if index >= count or index in associations:
                    raise GFPakError("Duplicate or invalid file index in folder table")
                associations[index] = (folder_number, folder_hash, file_hash)

        for index in range(count):
            level, compression, size, packed_size, _, offset, _ = self._read(
                "<HHIIIII", table_offset + 24 * index
            )
            if size > self.MAX_SINGLE_FILE:
                raise GFPakError(f"Resource {index} exceeds 512 MiB safety limit")
            if offset > len(self._bytes) or packed_size > len(self._bytes) - offset:
                raise GFPakError(f"Resource {index} extends beyond the archive")
            folder = associations.get(index)
            self.resources.append(Resource(
                index, level, compression, size, packed_size, offset,
                f"{global_hashes[index]:016x}",
                folder[0] if folder else None,
                f"{folder[1]:016x}" if folder else None,
                f"{folder[2]:016x}" if folder else None,
            ))

    def summary(self) -> dict:
        compression_counts: dict[str, int] = {}
        for r in self.resources:
            key = str(r.compression)
            compression_counts[key] = compression_counts.get(key, 0) + 1
        return {
            "archive": self.source.name,
            "version": f"0x{self.version:04X}",
            "file_count": len(self.resources),
            "folder_count": self.folder_count,
            "compression_types": compression_counts,
            "packed_bytes": sum(r.packed_size for r in self.resources),
            "unpacked_bytes": sum(r.size for r in self.resources),
        }

    def report(self) -> dict:
        return {"summary": self.summary(), "resources": [asdict(r) for r in self.resources]}

    def save_report(self, output: str | Path) -> None:
        Path(output).write_text(json.dumps(self.report(), indent=2), encoding="utf-8")

    def read_resource(self, resource: Resource, *, oodle_dll: str | Path | None = None,
                      packed: bool = False) -> bytes:
        if not 0 <= resource.index < len(self.resources) or self.resources[resource.index] != resource:
            raise GFPakError("Resource does not belong to this archive")
        block = self._bytes[resource.offset:resource.offset + resource.packed_size]
        if packed:
            return block
        if resource.compression == 0:
            if len(block) != resource.size:
                raise GFPakError("Stored resource size mismatch")
            return block
        if resource.compression == 2:
            try:
                import lz4.block
            except ImportError as exc:
                raise GFPakError("LZ4 resource requires: pip install lz4") from exc
            try:
                data = lz4.block.decompress(block, uncompressed_size=resource.size)
            except Exception as exc:
                raise GFPakError(f"LZ4 decompression failed for resource {resource.index}: {exc}") from exc
        elif resource.compression == 3:
            dll_error = None
            data = None
            if oodle_dll:
                try:
                    data = decompress_oodle(block, resource.size, Path(oodle_dll))
                except GFPakError as exc:
                    dll_error = exc
            if data is None:
                # pyooz is a separate open-source decoder. Falling back to it
                # also handles locally selected DLLs that cannot decode a block.
                try:
                    import ooz
                except ImportError as exc:
                    if dll_error is not None:
                        raise GFPakError(
                            f"Oodle DLL failed: {dll_error}. Install pyooz as a fallback."
                        ) from dll_error
                    raise GFPakError(
                        "Oodle decoder missing. Install pyooz (pip install pyooz==0.0.8) "
                        "or select an existing compatible oo2core_*.dll."
                    ) from exc
                try:
                    data = ooz.decompress(block, resource.size)
                except Exception as exc:
                    raise GFPakError(
                        f"No available Oodle backend decoded resource {resource.index}: "
                        f"{exc}" + (f" (DLL also failed: {dll_error})" if dll_error else "")
                    ) from exc
        else:
            raise GFPakError(f"Unsupported compression type: {resource.compression}")
        if len(data) != resource.size:
            raise GFPakError(f"Resource {resource.index}: decompressed size mismatch")
        return data

    def extract(self, target: str | Path, resources: list[Resource] | None = None,
                *, oodle_dll: str | Path | None = None,
                packed: bool = False) -> list[Path]:
        target = Path(target)
        selected = resources if resources is not None else self.resources
        paths: list[Path] = []
        for resource in selected:
            contents = self.read_resource(resource, oodle_dll=oodle_dll, packed=packed)
            dest = target / resource.folder_name / (resource.filename + (".packed" if packed else ""))
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(contents)
            paths.append(dest)
        return paths



def find_oodle_dll(archive: str | Path | None = None) -> Path | None:
    """Find a locally installed Oodle runtime without downloading proprietary files.

    Search only explicit settings, PATH, and nearby standard installation folders.
    This deliberately avoids a slow recursive search of the entire computer.
    """
    roots: list[Path] = []
    explicit = os.environ.get("GFPAK_OODLE_DLL")
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_file() and re.fullmatch(r"oo2core_.*[.]dll", candidate.name, re.I):
            return candidate.resolve()
        if candidate.is_dir():
            roots.append(candidate)
    if archive is not None:
        root = Path(archive).expanduser().resolve()
        roots.extend((root.parent, root.parent / "bin", root.parent / "tools",
                      root.parent.parent, root.parent.parent / "bin"))
    roots.append(Path.cwd())
    roots.extend(Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p)
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        parent = os.environ.get(env)
        if parent:
            roots.append(Path(parent) / "GFPAK-OPEN")
    seen = set()
    for folder in roots:
        if str(folder).lower() in seen:
            continue
        seen.add(str(folder).lower())
        try:
            candidates = sorted(folder.glob("oo2core_*.dll"), reverse=True)
            for candidate in candidates:
                if candidate.is_file():
                    return candidate.resolve()
        except (OSError, ValueError):
            continue
    return None


def decompress_oodle(packed: bytes, expected_size: int, dll: Path) -> bytes:
    """Use a user-provided official Oodle runtime. Never download or distribute DLLs."""
    if not dll.is_file():
        raise GFPakError(f"Oodle DLL not found: {dll}")
    if expected_size < 0 or expected_size > GFPak.MAX_SINGLE_FILE:
        raise GFPakError("Invalid output size")
    try:
        library = ctypes.CDLL(str(dll.resolve()))
        func = library.OodleLZ_Decompress
        func.argtypes = [ctypes.c_void_p, ctypes.c_ssize_t,
                         ctypes.c_void_p, ctypes.c_ssize_t,
                         ctypes.c_int, ctypes.c_int, ctypes.c_int,
                         ctypes.c_void_p, ctypes.c_ssize_t,
                         ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_ssize_t, ctypes.c_int]
        func.restype = ctypes.c_ssize_t
        src = ctypes.create_string_buffer(packed)
        dst = ctypes.create_string_buffer(max(expected_size, 1))
        n = func(src, len(packed), dst, expected_size,
                 1, 0, 0, None, 0, None, None, None, 0, 3)
    except (OSError, AttributeError) as exc:
        raise GFPakError(f"Cannot load compatible Oodle DLL: {exc}") from exc
    if n != expected_size:
        raise GFPakError(f"Oodle decoded {n} bytes, expected {expected_size}")
    return dst.raw[:n]
