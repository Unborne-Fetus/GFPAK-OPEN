"""Bounded NCZ decompressor for NSZ/XCZ archives.

Supports common zstandard stream and NCZBLOCK variants. Source data is
obtained only from a user-opened local package; original archives are never
modified, and only explicitly opened NCZ members are restored in a session
cache. No external executable or downloaded game keys are required.
"""
from __future__ import annotations

import contextlib
import io
import os
import struct
from dataclasses import dataclass
from pathlib import Path

HEADER_SIZE = 0x4000
MAX_NCZ_SECTIONS = 128
MAX_EXPANDED_BYTES = 64 * 1024 ** 3
MAX_BLOCK_BYTES = 16 * 1024 * 1024
MAX_BLOCKS = 500000
CHUNK = 1024 * 1024


class NCZError(ValueError):
    pass


@dataclass(frozen=True)
class NCZSection:
    offset: int
    size: int
    crypto_type: int
    key: bytes
    counter: bytes


@dataclass(frozen=True)
class NCZHeader:
    sections: tuple[NCZSection, ...]
    compressed_offset: int
    is_block: bool
    block_size: int
    block_sizes: tuple[int, ...]
    expanded_size: int


class LimitedReader:
    """Restrict all reads to exactly one file inside NSP/XCI."""
    def __init__(self, source, offset: int, size: int):
        self.source = source
        self.start = offset
        self.end = offset + size
        self.pos = offset
        source.seek(offset)

    def read(self, n=-1):
        if n is None or n < 0:
            n = min(CHUNK, self.end - self.pos)
        data = self.source.read(min(n, max(0, self.end - self.pos)))
        self.pos += len(data)
        return data

    def tell(self):
        return self.pos - self.start

    def seek(self, offset, whence=0):
        target = self.start + offset if whence == 0 else (
            self.pos + offset if whence == 1 else self.end + offset)
        if target < self.start or target > self.end:
            raise NCZError("NCZ seek outside selected compressed member")
        self.pos = target
        self.source.seek(target)
        return self.pos - self.start

    def read_exact(self, count):
        data = self.read(count)
        if len(data) != count:
            raise NCZError("Truncated NCZ header or compressed data")
        return data


def _zstd():
    try:
        import zstandard
        return zstandard
    except ImportError as error:
        raise NCZError("Built-in zstandard decoder missing. Update the GFPAK-OPEN EXE.") from error


def parse_ncz(reader: LimitedReader) -> NCZHeader:
    if reader.end - reader.start < HEADER_SIZE + 16:
        raise NCZError("NCZ is too small to contain an NCA header and NCZSECTN")
    reader.seek(HEADER_SIZE)
    if reader.read_exact(8) != b"NCZSECTN":
        raise NCZError("Not an NCZSECTN archive")
    count = struct.unpack("<Q", reader.read_exact(8))[0]
    if not 1 <= count <= MAX_NCZ_SECTIONS:
        raise NCZError("Invalid NCZ section count")
    sections = []
    finish = HEADER_SIZE
    for _ in range(count):
        offset, size, mode, reserved = struct.unpack("<4Q", reader.read_exact(32))
        key = reader.read_exact(16)
        counter = reader.read_exact(16)
        if size <= 0 or offset < finish or size > MAX_EXPANDED_BYTES - offset:
            raise NCZError("NCZ section order or size invalid")
        if mode not in (0, 1, 3, 4):
            raise NCZError(f"NCZ encryption type {mode} is not supported")
        if mode in (3, 4) and (offset & 15):
            raise NCZError("Unaligned encrypted NCZ section")
        # Standard NCZ inserts an unencrypted fake section for an initial gap.
        if offset != finish:
            if finish != HEADER_SIZE:
                raise NCZError("Discontiguous NCZ sections are not supported")
            sections.append(NCZSection(finish, offset - finish, 1, b"", b""))
        sections.append(NCZSection(offset, size, mode, key, counter))
        finish = offset + size
    pos = reader.tell()
    block = reader.read(8) == b"NCZBLOCK"
    reader.seek(pos)
    blocksize = 0
    blocks = ()
    if block:
        reader.read_exact(8)
        version, block_type, unused, exponent = struct.unpack("<4B", reader.read_exact(4))
        count_blocks, size = struct.unpack("<IQ", reader.read_exact(12))
        if version not in (1, 2) or not 14 <= exponent <= 24:
            raise NCZError("Unsupported NCZBLOCK version or block exponent")
        blocksize = 1 << exponent
        if not 1 <= count_blocks <= MAX_BLOCKS or size != finish - HEADER_SIZE:
            raise NCZError("NCZBLOCK output length/count inconsistent with NCZ sections")
        if count_blocks != (size + blocksize - 1) // blocksize:
            raise NCZError("NCZBLOCK count inconsistent with decompressed size")
        sizes = reader.read_exact(count_blocks * 4)
        blocks = tuple(struct.unpack_from("<I", sizes, i * 4)[0]
                       for i in range(count_blocks))
        if any(x <= 0 or x > blocksize for x in blocks):
            raise NCZError("Invalid compressed NCZ block size")
        if sum(blocks) > reader.end - reader.pos:
            raise NCZError("NCZ compressed blocks overrun selected package entry")
    return NCZHeader(tuple(sections), reader.tell(), block, blocksize, blocks, finish)


def _reencrypt(section: NCZSection, position: int, data: bytes) -> bytes:
    if section.crypto_type not in (3, 4):
        return data
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    if len(section.key) != 16 or len(section.counter) != 16:
        raise NCZError("Invalid NCZ section key/CTR")
    aligned = position & ~15
    skip = position - aligned
    iv = section.counter[:8] + (aligned // 16).to_bytes(8, "big")
    ctx = Cipher(algorithms.AES(section.key), modes.CTR(iv)).encryptor()
    return (ctx.update(b"\0" * skip + data) + ctx.finalize())[skip:]


def restore_ncz(package: str | Path, source_offset: int, source_size: int,
                destination: str | Path) -> Path:
    """Restore a single NCZ as a session-owned NCA, never altering the archive.

    The output remains encrypted where the original NCA used encrypted sections.
    Exclusive-file creation and cleanup prevent overwrites and partial caches.
    """
    package = Path(package)
    destination = Path(destination)
    if destination.resolve() == package.resolve():
        raise NCZError("Cannot overwrite source game archive")
    if not destination.parent.is_dir():
        raise NCZError("Destination folder does not exist")
    if source_offset < 0 or source_size < HEADER_SIZE:
        raise NCZError("Invalid compressed member range")
    if source_offset > package.stat().st_size or source_size > package.stat().st_size - source_offset:
        raise NCZError("Compressed member is outside the package")
    with package.open("rb") as infile:
        limited = LimitedReader(infile, source_offset, source_size)
        initial = limited.read_exact(HEADER_SIZE)
        header = parse_ncz(limited)
        sections = header.sections
        if header.expanded_size > MAX_EXPANDED_BYTES:
            raise NCZError("Expanded NCZ would exceed size limit")
        with destination.open("xb") as out:
            try:
                out.write(initial)
                section_index = 0
                pos = HEADER_SIZE

                def emit(decoded):
                    nonlocal pos, section_index
                    position = 0
                    while position < len(decoded):
                        if section_index >= len(sections):
                            raise NCZError("NCZ stream expanded beyond its declared sections")
                        section = sections[section_index]
                        if pos < section.offset:
                            raise NCZError("NCZ data is missing a section")
                        cap = section.offset + section.size - pos
                        if cap <= 0:
                            section_index += 1
                            continue
                        part = decoded[position:position + cap]
                        out.write(_reencrypt(section, pos, part))
                        pos += len(part)
                        position += len(part)
                        if pos == section.offset + section.size:
                            section_index += 1

                zstd = _zstd()
                decoder = zstd.ZstdDecompressor(max_window_size=32 * 1024 * 1024)
                if header.is_block:
                    for i, compressed_size in enumerate(header.block_sizes):
                        compressed = limited.read_exact(compressed_size)
                        expected = min(header.block_size,
                                       header.expanded_size - HEADER_SIZE -
                                       i * header.block_size)
                        if compressed_size == expected:
                            data = compressed
                        else:
                            try:
                                data = decoder.decompress(compressed, max_output_size=expected)
                            except zstd.ZstdError as error:
                                raise NCZError("NCZBLOCK zstandard decompression failed") from error
                        if len(data) != expected:
                            raise NCZError("NCZBLOCK decoded an unexpected number of bytes")
                        emit(data)
                else:
                    with contextlib.closing(decoder.stream_reader(limited)) as stream:
                        while pos < header.expanded_size:
                            try:
                                data = stream.read(min(CHUNK, header.expanded_size - pos))
                            except zstd.ZstdError as error:
                                raise NCZError("NCZ zstandard stream decompression failed") from error
                            if not data:
                                raise NCZError("NCZ zstandard stream ended before declared output")
                            emit(data)
                if pos != header.expanded_size:
                    raise NCZError("NCZ decoded byte count mismatch")
            except BaseException:
                out.close()
                destination.unlink(missing_ok=True)
                raise
    return destination
