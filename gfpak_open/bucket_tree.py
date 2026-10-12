"""Read-only Nintendo Switch BucketTree storage layers.

Entry nodes are loaded one at a time instead of loading the complete table.
No key material, external utilities, or writable game content is involved.
Unrecognized table layouts and compression codecs fail closed.
"""
from __future__ import annotations

import bisect
import struct
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable

NODE = 0x4000
MAX_ENTRIES = 250_000
MAX_BLOCK = 64 * 1024 * 1024
# Keep frequently accessed RomFS metadata in memory without retaining
# enormous game assets. A cache belongs to one immutable source NCA.
MAX_CACHE_BLOCK = 8 * 1024 * 1024
MAX_CACHE_TOTAL = 24 * 1024 * 1024


class BucketTreeError(ValueError):
    pass


@dataclass(frozen=True)
class IndirectEntry:
    virtual: int
    physical: int
    storage: int


@dataclass(frozen=True)
class CompressedEntry:
    virtual: int
    physical: int
    codec: int
    level: int
    size: int


class BucketTree:
    """Parses a Nintendo 0x4000-byte bucket index into bounded, sorted entries."""

    def __init__(self, read_table: Callable[[int, int], bytes], table_size: int,
                 entry_count: int, *, compressed: bool = False):
        self.compressed = compressed
        self._lz4_cache: OrderedDict[tuple[int, int, int], bytes] = OrderedDict()
        self._cache_bytes = 0
        width = 24 if compressed else 20
        if not 1 <= entry_count <= MAX_ENTRIES:
            raise BucketTreeError("Unsupported BucketTree entry count")
        count_per_node = (NODE - 16) // width
        entry_nodes = (entry_count + count_per_node - 1) // count_per_node
        offset_count = (NODE - 16) // 8
        # The optional second-level offset nodes reside between the root and
        # entry nodes; these nodes don't change the sequential entry-node layout.
        l2 = 0 if entry_nodes <= offset_count else (
            (entry_nodes - (offset_count - ((entry_nodes + offset_count - 1) // offset_count - 1))
             + offset_count - 1) // offset_count
        )
        self.node_region = (1 + l2) * NODE
        required = self.node_region + entry_nodes * NODE
        if table_size < required:
            raise BucketTreeError("BucketTree table is truncated")
        header = read_table(0, 16)
        if len(header) != 16:
            raise BucketTreeError("Truncated BucketTree root")
        root_idx, root_count, end = struct.unpack("<IIQ", header)
        if root_idx != 0 or root_count != entry_nodes or end <= 0:
            raise BucketTreeError("Invalid BucketTree root header")
        self.end = end
        rows = []
        for node in range(entry_nodes):
            data = read_table(self.node_region + node * NODE, NODE)
            if len(data) != NODE:
                raise BucketTreeError("Truncated BucketTree entry node")
            idx, count, _next = struct.unpack_from("<IIQ", data, 0)
            if idx != node or not 1 <= count <= count_per_node or len(rows) + count > entry_count:
                raise BucketTreeError("Invalid BucketTree entry-node header")
            for index in range(count):
                at = 16 + index * width
                if compressed:
                    virt, phys, codec, level, _reserved, size = struct.unpack_from("<qqBb2sI", data, at)
                    if virt < 0 or phys < 0 or codec not in (0, 1, 3) or (
                        codec != 3 and level != 0) or (codec == 3 and not 0 <= level <= 16):
                        raise BucketTreeError("Invalid compressed storage entry")
                    if (codec == 0 and size != 0xFFFFFFFF) or (
                        codec != 0 and size == 0xFFFFFFFF):
                        raise BucketTreeError("Invalid compressed storage length")
                    rows.append(CompressedEntry(virt, phys, codec, level, size))
                else:
                    virt, phys, storage = struct.unpack_from("<QQI", data, at)
                    if storage not in (0, 1):
                        raise BucketTreeError("Unknown indirect storage index")
                    rows.append(IndirectEntry(virt, phys, storage))
        if len(rows) != entry_count or rows[0].virtual != 0:
            raise BucketTreeError("BucketTree entry count/start mismatch")
        self.entries = rows
        self.offsets = [row.virtual for row in rows]
        if any(b <= a for a, b in zip(self.offsets, self.offsets[1:])) or self.offsets[-1] >= end:
            raise BucketTreeError("BucketTree offsets must increase within logical storage")

    def locate(self, at: int):
        if at < 0 or at >= self.end:
            raise BucketTreeError("Read beyond logical BucketTree storage")
        idx = bisect.bisect_right(self.offsets, at) - 1
        if idx < 0:
            raise BucketTreeError("Unmapped BucketTree offset")
        return self.entries[idx], self.offsets[idx + 1] if idx + 1 < len(self.entries) else self.end

    def read_indirect(self, offset: int, size: int, original, patched=None, *, sparse=False) -> bytes:
        self._bounds(offset, size)
        out = bytearray()
        while len(out) < size:
            at = offset + len(out)
            entry, end = self.locate(at)
            count = min(size - len(out), end - at)
            if entry.storage == 1 and sparse:
                out.extend(bytes(count))
            else:
                read = original if entry.storage == 0 else patched
                if read is None:
                    raise BucketTreeError("Patch entry needs its matching original/updated NCA storage")
                data = read(entry.physical + at - entry.virtual, count)
                if len(data) != count:
                    raise BucketTreeError("Truncated indirect storage read")
                out.extend(data)
        return bytes(out)

    def read_compressed(self, offset: int, size: int, read_data) -> bytes:
        self._bounds(offset, size)
        out = bytearray()
        while len(out) < size:
            at = offset + len(out)
            entry, end = self.locate(at)
            count = min(size - len(out), end - at)
            if entry.codec == 1:
                out.extend(bytes(count))
            elif entry.codec == 0:
                data = read_data(entry.physical + at - entry.virtual, count)
                if len(data) != count:
                    raise BucketTreeError("Truncated uncompressed BucketTree block")
                out.extend(data)
            elif entry.codec == 3:
                expanded = end - entry.virtual
                if expanded > MAX_BLOCK or entry.size > MAX_BLOCK:
                    raise BucketTreeError("Compressed block exceeds the 64 MiB safe decoding limit")
                try:
                    import lz4.block
                except ImportError as exc:
                    raise BucketTreeError("LZ4 NCA blocks need the optional lz4 Python package") from exc
                cache_key = (entry.physical, entry.size, expanded)
                decoded = self._lz4_cache.get(cache_key)
                if decoded is None:
                    packed = read_data(entry.physical, entry.size)
                    if len(packed) != entry.size:
                        raise BucketTreeError("Truncated compressed BucketTree block")
                    try:
                        decoded = lz4.block.decompress(packed, uncompressed_size=expanded)
                    except Exception as exc:
                        raise BucketTreeError("Invalid LZ4-compressed BucketTree block") from exc
                    if len(decoded) != expanded:
                        raise BucketTreeError("Compressed BucketTree block size mismatch")
                    if expanded <= MAX_CACHE_BLOCK:
                        while self._lz4_cache and self._cache_bytes + expanded > MAX_CACHE_TOTAL:
                            _, removed = self._lz4_cache.popitem(last=False)
                            self._cache_bytes -= len(removed)
                        self._lz4_cache[cache_key] = decoded
                        self._cache_bytes += expanded
                else:
                    self._lz4_cache.move_to_end(cache_key)
                out.extend(decoded[at-entry.virtual:at-entry.virtual+count])
            else:
                raise BucketTreeError("Unsupported BucketTree compression type")
        return bytes(out)

    def _bounds(self, offset, size):
        if not isinstance(offset, int) or not isinstance(size, int) or (
            offset < 0 or size < 0 or offset > self.end or size > self.end - offset
        ):
            raise BucketTreeError("Read beyond BucketTree storage")
