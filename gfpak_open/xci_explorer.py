"""Read-only XCI game-card HFS0 index support.

Parses plaintext game-card and HFS0 partition tables in-place. Does not
attempt to bypass encryption or fabricate missing partitions. The secure,
normal, update and logo partitions expose indexed NCA files through the same
bounded reader used for NSP. The program's keys (if provided) are held only in
the existing native NCA bridge.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

from .nsp_explorer import NSPAnalyzer, NSPEntry, describe_entry, MAX_ENTRIES, MAX_STRINGS

MAX_SIZE = (1 << 63) - 1
HFS0_RECORD_SIZE = 0x40


@dataclass(frozen=True)
class PartitionEntry:
    name: str
    offset: int
    size: int


def read_hfs0(path: Path, offset: int, extent: int) -> tuple[list[PartitionEntry], int]:
    """Return absolute files in one HFS0, enforcing all containment bounds."""
    if offset < 0 or extent < 0 or extent > MAX_SIZE:
        raise ValueError("Invalid HFS0 bounds")
    available = path.stat().st_size
    if offset > available or extent > available - offset or extent < 0x10:
        raise ValueError("HFS0 partition extends beyond the XCI")
    with path.open("rb") as handle:
        handle.seek(offset)
        head = handle.read(0x10)
        if head[:4] != b"HFS0":
            raise ValueError("Expected an HFS0 partition header")
        count, names_size, reserved = struct.unpack_from("<III", head, 4)
        if count > MAX_ENTRIES or names_size > MAX_STRINGS:
            raise ValueError("HFS0 index exceeds safety limits")
        prefix = 0x10 + count * HFS0_RECORD_SIZE + names_size
        if prefix > extent:
            raise ValueError("HFS0 index extends beyond its partition")
        records = handle.read(count * HFS0_RECORD_SIZE)
        names = handle.read(names_size)
    if len(records) != count * HFS0_RECORD_SIZE or len(names) != names_size:
        raise ValueError("HFS0 index is truncated")
    output: list[PartitionEntry] = []
    seen_names = set()
    for i in range(count):
        rel, length, name_at, hash_length = struct.unpack_from("<QQII", records, i * HFS0_RECORD_SIZE)
        if name_at >= names_size:
            raise ValueError("HFS0 filename offset out of range")
        end = names.find(b"\0", name_at)
        if end < 0:
            raise ValueError("Unterminated HFS0 filename")
        try:
            name = names[name_at:end].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Invalid HFS0 UTF-8 filename") from exc
        if not name or "/" in name or "\\" in name or name in (".", ".."):
            raise ValueError("Unsafe HFS0 filename")
        if name in seen_names:
            raise ValueError("Duplicate HFS0 filename")
        seen_names.add(name)
        if rel > extent - prefix or length > extent - prefix - rel:
            raise ValueError("HFS0 file range exceeds the parent partition")
        output.append(PartitionEntry(name, offset + prefix + rel, length))
    return output, prefix


class XCIImage:
    """Discover game card root partitions with no external executable."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.size = self.path.stat().st_size
        with self.path.open("rb") as handle:
            handle.seek(0x100)
            header = handle.read(0x50)
        if len(header) < 0x50 or header[:4] != b"HEAD":
            raise ValueError("Not a valid game-card XCI (missing HEAD header)")
        root_offset, root_header_size = struct.unpack_from("<QQ", header, 0x30)
        if root_offset < 0x200 or root_offset >= self.size:
            raise ValueError("Invalid XCI root HFS0 location")
        self.root_offset = root_offset
        self.header_size = root_header_size
        self.partitions, parsed_size = read_hfs0(
            self.path, root_offset, self.size - root_offset
        )
        if root_header_size and root_header_size != parsed_size:
            # Some producers include alignment in the declared header size.
            if root_header_size < parsed_size or root_header_size > self.size - root_offset:
                raise ValueError("XCI root HFS0 header size mismatch")
        self.partition_map = {row.name: row for row in self.partitions}

    def open_partition(self, name: str) -> "XCIPartition":
        if name not in self.partition_map:
            raise ValueError("Selected XCI partition does not exist")
        return XCIPartition(self.path, self.partition_map[name])


class XCIPartition(NSPAnalyzer):
    """Expose XCI HFS0 entries with the NSP analyzer's bounded file API."""

    def __init__(self, path: str | Path, partition: PartitionEntry):
        self.partition = partition
        super().__init__(path)

    def _read_index(self):
        rows, prefix = read_hfs0(self.path, self.partition.offset, self.partition.size)
        self.data_start = self.partition.offset + prefix
        self.table_bytes = prefix
        self.entries = []
        for i, entry in enumerate(rows):
            role, format_ = describe_entry(entry.name)
            self.entries.append(NSPEntry(i, entry.name, entry.offset, entry.size,
                                         entry.offset - self.data_start, 0,
                                         role, format_, None))
        self.warnings = []
