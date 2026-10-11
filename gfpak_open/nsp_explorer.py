"""Read-only Nintendo Switch NSP (PFS0) package analysis.

This inspects the *outer*, plaintext PFS0 file table. It deliberately cannot
decrypt, mount or modify NCA contents and does not load console keys. All large
payload reads and SHA-256 computations stream from disk.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_ENTRIES = 50000
MAX_STRINGS = 8 * 1024 * 1024
MAX_HEADER = 16 + MAX_ENTRIES * 24 + MAX_STRINGS
CHUNK = 2 * 1024 * 1024
MAX_HEX_BYTES = 1024
CONTENT_ID_RE = re.compile(r"^([0-9a-fA-F]{32})(?:\.cnmt)?\.nca$", re.I)


def describe_entry(name: str) -> tuple[str, str]:
    """Return a descriptive role and a conservative format label."""
    lower = name.lower().split("/")[-1]
    if lower.endswith(".cnmt.nca"):
        return ("Content metadata NCA", "Encrypted NCA")
    if lower.endswith(".nca"):
        return ("Content archive NCA", "Encrypted NCA")
    if lower.endswith(".tik"):
        return ("Ticket", "Ticket")
    if lower.endswith(".cert"):
        return ("Certificate", "Certificate")
    if lower.endswith(".xml") or lower.endswith(".json"):
        return ("Manifest / metadata", "Text metadata")
    if lower.endswith(".jpg") or lower.endswith(".jpeg") or lower.endswith(".png"):
        return ("Artwork", "Image")
    if lower.endswith(".nsp") or lower.endswith(".pfs0"):
        return ("Nested package", "PFS0 candidate")
    if lower.endswith(".gfpak"):
        return ("GFPAK asset archive", "GFLXPACK candidate")
    if lower.endswith(".ncz"):
        return ("Compressed NCA (NCZ)", "Zstandard NCZ")
    if lower.endswith(".nsz"):
        return ("Compressed package", "NSP/NSZ")
    return ("Other resource", "Unknown")


@dataclass(frozen=True)
class NSPEntry:
    index: int
    name: str
    offset: int
    size: int
    relative_offset: int
    name_offset: int
    role: str
    format: str
    content_id: str | None = None

    def info(self) -> dict:
        return {"index": self.index, "name": self.name,
                "offset": self.offset, "size": self.size,
                "relative_offset": self.relative_offset,
                "role": self.role, "format": self.format,
                "content_id": self.content_id}


class NSPAnalyzer:
    """Parse bounds-checked PFS0 metadata and analyze entries without decrypting."""

    def __init__(self, filename: str | Path):
        self.path = Path(filename)
        self.size = self.path.stat().st_size
        self.entries: list[NSPEntry] = []
        self.data_start = 0
        self.table_bytes = 0
        self.warnings: list[str] = []
        self._read_index()

    def _read_index(self):
        with self.path.open("rb") as handle:
            header = handle.read(16)
            if len(header) != 16 or header[:4] != b"PFS0":
                raise ValueError("Not a standard PFS0 NSP package. Encrypted NCA or XCI data cannot be read as PFS0.")
            count, string_size, reserved = struct.unpack_from("<III", header, 4)
            if count > MAX_ENTRIES or string_size > MAX_STRINGS:
                raise ValueError("NSP index exceeds configured safe file/string-table limits")
            table_end = 16 + count * 24 + string_size
            if table_end > self.size:
                raise ValueError("NSP PFS0 table extends beyond the file")
            records = handle.read(count * 24)
            strings = handle.read(string_size)
            if len(records) != count * 24 or len(strings) != string_size:
                raise ValueError("NSP index was truncated while reading")
        self.data_start = table_end
        self.table_bytes = table_end
        if reserved:
            self.warnings.append("Nonzero reserved PFS0 header field; verify that this is a standard NSP.")
        if not count:
            self.warnings.append("NSP contains no indexed files.")
        names = set()
        intervals = []
        for i in range(count):
            relative, size, name_at, unused = struct.unpack_from("<QQII", records, i * 24)
            if name_at >= len(strings):
                raise ValueError(f"NSP entry {i} has an invalid name offset")
            end = strings.find(b"\0", name_at)
            if end < 0:
                raise ValueError(f"NSP entry {i} is missing its name terminator")
            rawname = strings[name_at:end]
            if not rawname:
                raise ValueError(f"NSP entry {i} has an empty filename")
            name = rawname.decode("utf-8", errors="replace")
            if relative > self.size - self.data_start or size > self.size - self.data_start - relative:
                raise ValueError(f"NSP entry {i} points outside the package")
            if name in names and len(self.warnings) < 100:
                self.warnings.append(f"Duplicate entry name: {name[:120]}")
            names.add(name)
            role, format_ = describe_entry(name)
            found = CONTENT_ID_RE.match(name.split("/")[-1])
            content_id = found.group(1).lower() if found else None
            self.entries.append(NSPEntry(i, name, self.data_start + relative, size,
                                         relative, name_at, role, format_, content_id))
            if unused and len(self.warnings) < 100:
                self.warnings.append(f"Entry {i} has a nonzero reserved field")
            if size:
                intervals.append((relative, relative + size, i))
        intervals.sort()
        finish = 0
        for start, end, i in intervals:
            if start < finish:
                if len(self.warnings) < 100:
                    self.warnings.append(f"Entry {i} overlaps an earlier data range")
            finish = max(finish, end)
        if finish and finish < self.size - self.data_start:
            self.warnings.append("Unindexed trailing bytes detected after the PFS0 payload.")
        if len(strings) and strings[-1] != 0:
            self.warnings.append("PFS0 string table does not end with a NUL byte.")

    def get(self, index: int) -> NSPEntry:
        if not isinstance(index, int) or index < 0 or index >= len(self.entries):
            raise ValueError("Invalid package entry index")
        return self.entries[index]

    def plaintext_content_metadata(self, max_files: int = 8) -> list[dict]:
        """Inspect small, already-plaintext CNMT XML metadata when present.

        NSP packages do not always contain XML; encrypted NCA metadata cannot
        be read here. XML entities and DTD declarations are refused.
        """
        results = []
        for entry in self.entries:
            if len(results) >= max_files:
                break
            if not entry.name.lower().endswith(".cnmt.xml") or entry.size > 2 * 1024 * 1024:
                continue
            with self.path.open("rb") as handle:
                handle.seek(entry.offset)
                data = handle.read(entry.size)
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                continue
            try:
                root = ET.fromstring(data)
            except (ET.ParseError, ValueError):
                continue

            def local(tag: str) -> str:
                return tag.rsplit("}", 1)[-1]

            def field(element, candidates):
                for item in element:
                    if local(item.tag).lower() in candidates:
                        return (item.text or "").strip()[:128]
                return ""

            title_id = field(root, {"id", "titleid", "title_id"})
            version = field(root, {"version"})
            category = field(root, {"type", "contentmetatype"})
            required = field(root, {"requiredsystemversion", "requiredappversion",
                                    "requiredapplicationversion"})
            children = []
            for element in root:
                if local(element.tag).lower() != "content":
                    continue
                content_id = field(element, {"id"})
                if not re.fullmatch(r"[a-f0-9]{32}", content_id, re.I):
                    continue
                children.append({
                    "content_id": content_id.lower(),
                    "role": field(element, {"type"}),
                    "size": field(element, {"size"}),
                })
                if len(children) >= 300:
                    break
            results.append({
                "filename": entry.name,
                "title_id": title_id, "version": version,
                "type": category, "required_system_version": required,
                "contents": children,
            })
        return results

    def summary(self) -> dict:
        roles = Counter(e.role for e in self.entries)
        formats = Counter(e.format for e in self.entries)
        role_bytes = Counter()
        for e in self.entries:
            role_bytes[e.role] += e.size
        content = sum(e.size for e in self.entries)
        return {
            "filename": self.path.name, "bytes": self.size,
            "header_bytes": self.table_bytes,
            "payload_bytes": content, "files": len(self.entries),
            "roles": dict(roles), "formats": dict(formats),
            "role_bytes": dict(role_bytes),
            "content_ids": sum(e.content_id is not None for e in self.entries),
            "plaintext_cnmt": self.plaintext_content_metadata(),
            "warnings": list(self.warnings),
            "encryption": "NCA payloads are opaque/encrypted. No NCA keys are used.",
            "capabilities": ["PFS0 directory", "size and offset analysis",
                             "bounded hex inspector", "SHA-256 checksum",
                             "raw file export", "JSON manifest"],
        }

    def inspect(self, index: int, offset: int = 0, length: int = 256) -> dict:
        entry = self.get(index)
        if not isinstance(offset, int) or offset < 0 or offset > entry.size:
            raise ValueError("Hex preview offset is outside this entry")
        if not isinstance(length, int) or length < 1 or length > MAX_HEX_BYTES:
            raise ValueError(f"Hex preview length must be between 1 and {MAX_HEX_BYTES}")
        count = min(length, entry.size - offset)
        # Tickets can hold encryption material; show their metadata without a raw hex dump.
        if entry.role == "Ticket":
            return {**entry.info(), "sample_offset": offset,
                    "sample_size": 0, "hex_lines": [],
                    "signature": "Ticket payload hidden in inspector",
                    "note": "Ticket bytes are not displayed. Raw extraction copies the file unchanged."}
        with self.path.open("rb") as handle:
            handle.seek(entry.offset + offset)
            block = handle.read(count)
        lines = []
        for i in range(0, len(block), 16):
            row = block[i:i + 16]
            lines.append({
                "offset": offset + i, "hex": " ".join(f"{b:02X}" for b in row),
                "ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in row)
            })
        signature = self._signature(block, offset, entry)
        return {**entry.info(), "sample_offset": offset,
                "sample_size": len(block), "hex_lines": lines,
                "signature": signature,
                "note": ("This is an encrypted NCA. The preview contains raw encrypted bytes, "
                         "not decrypted game files." if entry.role.endswith("NCA") else
                         "Raw file bytes; no decryption or format conversion is performed.")}

    @staticmethod
    def _signature(data: bytes, offset: int, entry: NSPEntry) -> str:
        if entry.role.endswith("NCA"):
            return "Encrypted NCA (opaque; header cannot be decoded here)"
        if offset:
            return "File interior (signature detection at byte 0 only)"
        if data.startswith(b"GFLXPACK"):
            return "GFLXPACK asset archive"
        if data.startswith(b"PFS0"):
            return "PFS0 package"
        if data.startswith(b"HFS0"):
            return "HFS0 archive"
        if data.startswith(b"glTF"):
            return "glTF binary model"
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "PNG image"
        if data.startswith(b"DDS "):
            return "DDS texture"
        if data.startswith(b"BNTX"):
            return "BNTX texture container"
        if data.startswith(b"PK\x03\x04"):
            return "ZIP archive"
        if data.startswith(b"<?xml"):
            return "XML metadata"
        if data.startswith(b"{") or data.startswith(b"["):
            return "Possible JSON metadata"
        return "No recognized plaintext signature"

    def sha256(self, index: int, progress: Callable[[int, int], None] | None = None) -> dict:
        entry = self.get(index)
        digest = hashlib.sha256()
        done = 0
        with self.path.open("rb") as handle:
            handle.seek(entry.offset)
            while done < entry.size:
                block = handle.read(min(CHUNK, entry.size - done))
                if not block:
                    raise OSError("NSP was truncated while computing SHA-256")
                digest.update(block)
                done += len(block)
                if progress:
                    progress(done, entry.size)
        hex_ = digest.hexdigest()
        # NCA content identifiers frequently encode the first 16 digest bytes;
        # report this comparison as advisory, not a universal corruption verdict.
        comparison = None
        if entry.content_id:
            comparison = "matches" if hex_.startswith(entry.content_id) else "differs"
        return {"index": index, "sha256": hex_,
                "content_id_comparison": comparison,
                "bytes_hashed": done}

    def export_raw(self, index: int, target: str | Path,
                   progress: Callable[[int, int], None] | None = None) -> Path:
        """Stream raw bytes into an explicitly chosen *new* destination file."""
        entry = self.get(index)
        target = Path(target)
        source_resolved = self.path.resolve()
        if target.resolve() == source_resolved:
            raise ValueError("Cannot replace the source NSP")
        if not target.parent.is_dir():
            raise ValueError("Destination folder does not exist")
        with target.open("xb") as output:
            try:
                done = 0
                with self.path.open("rb") as source:
                    source.seek(entry.offset)
                    while done < entry.size:
                        block = source.read(min(CHUNK, entry.size - done))
                        if not block:
                            raise OSError("NSP was truncated while exporting")
                        output.write(block)
                        done += len(block)
                        if progress:
                            progress(done, entry.size)
            except Exception:
                output.close()
                target.unlink(missing_ok=True)
                raise
        return target

    def manifest(self) -> dict:
        return {"summary": self.summary(),
                "entries": [entry.info() for entry in self.entries],
                "note": "NSP outer index only; encrypted NCAs are not decrypted."}

    def write_manifest(self, target: str | Path) -> Path:
        dest = Path(target)
        with dest.open("x", encoding="utf-8") as handle:
            json.dump(self.manifest(), handle, ensure_ascii=False, indent=2)
        return dest
