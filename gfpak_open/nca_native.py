"""Built-in, read-only Nintendo Switch NCA3 filesystem reader.

No subprocesses, other installed programs, network, automatic key collection,
or unbounded whole-NCA staging. The user's own optional keyset is never
serialized to logs or the browser. Reads are bounded to the selected NSP entry.

Supports NCA3 headers (plaintext or AES-XTS with a provided header key),
unpatched none/AES-CTR filesystem sections, PartitionFS and RomFS.
Unsupported revisions, patched/sparse/compressed sections and rights-managed
titles without a supplied content key fail explicitly.
"""
from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

from .nsp_explorer import NSPAnalyzer

MAX_META = 16 * 1024 * 1024
MAX_FILES = 100000
MAX_CHILDREN = 3000
NONE = 0xFFFFFFFF
CHUNK = 1024 * 1024
KEY_PATTERN = re.compile(r"^\s*([a-zA-Z0-9_]+)\s*=\s*([0-9a-fA-F]+)\s*(?:[;#].*)?$")


class NativeNCAError(ValueError):
    """Unsupported, invalid or inaccessible NCA data."""


def _crypto():
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        return Cipher, algorithms, modes
    except ImportError as error:
        raise NativeNCAError(
            "The integrated NCA crypto package is missing from this build. "
            "Rebuild GFPAK-OPEN with its bundled Python dependencies."
        ) from error


class Keyset:
    """A locally chosen keys text file. Values never leave the Python process."""

    def __init__(self, path: str | Path | None):
        self._keys = {}
        if not path:
            return
        file = Path(path)
        if not file.is_file() or file.stat().st_size > 1024 * 1024:
            raise NativeNCAError("The selected local keys file is missing or too large.")
        for line in file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            match = KEY_PATTERN.match(line)
            if not match:
                continue
            name, value = match.groups()
            if len(value) in (32, 64):
                try:
                    self._keys[name.lower()] = bytes.fromhex(value)
                except ValueError:
                    continue

    def get(self, *names: str) -> bytes | None:
        for name in names:
            value = self._keys.get(name.lower())
            if value:
                return value
        return None

    @property
    def has_header(self):
        key = self.get("nca_header_key", "header_key")
        return key is not None and len(key) == 32


def _aes_ecb(key: bytes, encrypted: bytes) -> bytes:
    Cipher, algorithms, modes = _crypto()
    if len(key) != 16 or len(encrypted) % 16:
        raise NativeNCAError("Invalid AES-ECB key or key area length.")
    ctx = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return ctx.update(encrypted) + ctx.finalize()


def _xts(key: bytes, block: bytes, sector: int, endian: str) -> bytes:
    Cipher, algorithms, modes = _crypto()
    ctx = Cipher(algorithms.AES(key), modes.XTS(sector.to_bytes(16, endian))).decryptor()
    return ctx.update(block) + ctx.finalize()


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: bytes, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]


def _filename(name: bytes) -> str:
    try:
        decoded = name.decode("utf-8")
    except UnicodeDecodeError as error:
        raise NativeNCAError("Invalid UTF-8 in filesystem directory.") from error
    if not decoded or decoded in {".", ".."} or "/" in decoded or "\\" in decoded or "\0" in decoded:
        raise NativeNCAError("Unsafe or empty filesystem filename.")
    return decoded


@dataclass(frozen=True)
class FileInfo:
    name: str
    path: str
    offset: int
    size: int


class NativeSection:
    def __init__(self, nca: "NativeNCA", number: int, start: int,
                 size: int, fs_header: bytes, encryption: int, key: bytes | None):
        self.nca = nca
        self.number = number
        self.start = start
        self.size = size
        self.fs_header = fs_header
        self.encryption = encryption
        self.key = key
        self.fs_type = fs_header[2]
        self.hash_type = fs_header[3]
        self.counter_prefix = fs_header[0x140:0x148][::-1]
        self._fs = None

    def read(self, relative: int, size: int) -> bytes:
        if size < 0 or relative < 0 or relative > self.size or size > self.size - relative:
            raise NativeNCAError("Requested data is outside the NCA filesystem section.")
        absolute = self.start + relative
        payload = self.nca.read_raw(absolute, size)
        if self.encryption == 1 or self.nca.plaintext:
            return payload
        if self.encryption == 3:
            if not self.key:
                raise NativeNCAError("The encrypted section needs a compatible content key.")
            Cipher, algorithms, modes = _crypto()
            aligned = absolute & ~15
            leading = absolute - aligned
            # AES CTR advances in 16-byte blocks relative to the NCA, not NSP.
            full = self.nca.read_raw(aligned, size + leading)
            iv = self.counter_prefix + (aligned // 16).to_bytes(8, "big")
            ctx = Cipher(algorithms.AES(self.key), modes.CTR(iv)).decryptor()
            decrypted = ctx.update(full) + ctx.finalize()
            return decrypted[leading:leading + size]
        if self.encryption == 2:
            if not self.key or len(self.key) != 32:
                raise NativeNCAError("AES-XTS section key was not available.")
            sector_size = 0x200
            beginning = relative // sector_size * sector_size
            last = (relative + size + sector_size - 1) // sector_size * sector_size
            raw = self.nca.read_raw(self.start + beginning, last - beginning)
            pieces = []
            for position in range(0, len(raw), sector_size):
                pieces.append(_xts(self.key, raw[position:position + sector_size],
                                   (beginning + position) // sector_size,
                                   self.nca.header_tweak))
            return b"".join(pieces)[relative - beginning:relative - beginning + size]
        raise NativeNCAError(
            "This section uses patch, sparse or newer encryption which the native reader "
            "cannot interpret safely."
        )

    def filesystem(self):
        if self._fs is not None:
            return self._fs
        header = self.fs_header
        if self.fs_type in (1, 2) and self.hash_type in (0, 1, 2, 5):
            # Hierarchical SHA256 hash table followed by real PFS0 data layer.
            file_offset = _u64(header, 0x40) if self.hash_type in (2, 5) else 0
            if file_offset >= self.size:
                raise NativeNCAError("PartitionFS data offset is beyond its section.")
            self._fs = PartitionFS(self, file_offset)
        elif self.fs_type in (0, 3) or self.hash_type in (3, 6):
            # IVFC highest-level region is the actual RomFS image.
            if header[8:12] != b"IVFC":
                raise NativeNCAError("RomFS IVFC superblock is not supported.")
            layers = _u32(header, 0x14)
            if not 1 <= layers <= 6:
                raise NativeNCAError("RomFS contains an invalid IVFC layer count.")
            file_offset = _u64(header, 0x18 + (layers - 1) * 0x18)
            if file_offset >= self.size:
                raise NativeNCAError("RomFS data offset is outside the NCA section.")
            self._fs = RomFS(self, file_offset)
        else:
            raise NativeNCAError("Unsupported NCA section filesystem format.")
        return self._fs


class NativeNCA:
    def __init__(self, analyzer: NSPAnalyzer, index: int, keys: Keyset | None = None):
        self.analyzer = analyzer
        self.entry = analyzer.get(index)
        if not self.entry.name.lower().endswith(".nca"):
            raise NativeNCAError("Selected NSP entry is not an NCA.")
        self.keys = keys or Keyset(None)
        self.plaintext = False
        self.header_tweak = "big"
        self.sections: dict[int, NativeSection] = {}
        self._parse()

    def read_raw(self, offset: int, size: int) -> bytes:
        if size < 0 or offset < 0 or offset > self.entry.size or size > self.entry.size - offset:
            raise NativeNCAError("NCA read outside package entry.")
        with self.analyzer.path.open("rb") as source:
            source.seek(self.entry.offset + offset)
            data = source.read(size)
        if len(data) != size:
            raise NativeNCAError("Truncated NCA entry.")
        return data

    def _parse(self):
        if self.entry.size < 0xC00:
            raise NativeNCAError("NCA header is incomplete.")
        raw = self.read_raw(0, 0xC00)
        if raw[0x200:0x204] == b"NCA3":
            header = raw
            self.plaintext = True
        else:
            key = self.keys.get("nca_header_key", "header_key")
            if not key or len(key) != 32:
                raise NativeNCAError(
                    "Encrypted NCA detected. GFPAK-OPEN's built-in reader needs a "
                    "compatible user-supplied keys file; no other app is needed."
                )
            header = None
            for order in ("big", "little"):
                try:
                    candidate = b"".join(
                        _xts(key, raw[i:i + 0x200], i // 0x200, order)
                        for i in range(0, 0xC00, 0x200)
                    )
                except ValueError:
                    continue
                if candidate[0x200:0x204] == b"NCA3":
                    header = candidate
                    self.header_tweak = order
                    break
            if header is None:
                raise NativeNCAError("The supplied NCA header key could not decode this NCA3 header.")
        self.header = header
        old_generation, key_type = header[0x206], header[0x207]
        generation = max(old_generation, header[0x220])
        revision = max(0, generation - 1)
        rights = header[0x230:0x240]
        area = header[0x300:0x340]
        content_keys = None
        if not self.plaintext:
            if any(rights):
                name = rights.hex()
                content = self.keys.get("titlekey_" + name, name)
                if content and len(content) == 16:
                    content_keys = (content, content, content, content)
            else:
                suffix = ("application", "ocean", "system")
                if key_type > 2:
                    raise NativeNCAError("Unsupported NCA key area type.")
                area_key = self.keys.get(
                    "nca_key_area_key_" + suffix[key_type] + f"_{revision:02x}",
                    "key_area_key_" + suffix[key_type] + f"_{revision:02x}",
                )
                if area_key and len(area_key) == 16:
                    plain = _aes_ecb(area_key, area)
                    content_keys = tuple(plain[i:i + 16] for i in range(0, 64, 16))
        for i in range(4):
            start, end = struct.unpack_from("<II", header, 0x240 + i * 16)
            if not start and not end:
                continue
            offset, boundary = start * 0x200, end * 0x200
            if offset < 0xC00 or boundary <= offset or boundary > self.entry.size:
                raise NativeNCAError(f"NCA section {i} has invalid storage bounds.")
            fs = header[0x400 + i * 0x200:0x600 + i * 0x200]
            if fs[:2] not in (b"\x02\x00", b"\x00\x00"):
                raise NativeNCAError(f"NCA section {i} uses an unsupported header revision.")
            encryption = fs[4]
            if encryption not in (1, 2, 3):
                raise NativeNCAError(
                    f"NCA section {i} uses unsupported encryption mode {encryption}. "
                    "Patch/BKTR and compressed sections require separate support."
                )
            if not self.plaintext and encryption != 1 and content_keys is None:
                raise NativeNCAError(
                    "NCA filesystem content key is unavailable. Choose a compatible "
                    "locally supplied keys file. Rights-managed titles may also need "
                    "a matching title content key."
                )
            if any(fs[0x100:0x140]) or any(fs[0x148:0x1a0]):
                raise NativeNCAError(
                    f"NCA section {i} contains patch, sparse or compression metadata "
                    "that the integrated reader cannot safely apply."
                )
            key = None
            if not self.plaintext and encryption == 3:
                key = content_keys[2]
            elif not self.plaintext and encryption == 2:
                key = content_keys[0] + content_keys[1]
            self.sections[i] = NativeSection(self, i, offset, boundary - offset,
                                             fs, encryption, key)
        if not self.sections:
            raise NativeNCAError("NCA does not contain readable filesystem sections.")


class PartitionFS:
    """Bounded plaintext/decrypted PFS0 inside a selected NCA section."""

    def __init__(self, section: NativeSection, offset: int):
        self.section = section
        self.offset = offset
        header = section.read(offset, 16)
        if header[:4] != b"PFS0":
            raise NativeNCAError("PartitionFS magic was not found at the declared data layer.")
        count, names_length = struct.unpack_from("<II", header, 4)
        if count > MAX_FILES or names_length > MAX_META:
            raise NativeNCAError("PFS0 file table is too large.")
        table_length = count * 24 + names_length
        if table_length > section.size - offset - 16:
            raise NativeNCAError("PFS0 file table exceeds section bounds.")
        index = section.read(offset + 16, table_length)
        string_table = index[count * 24:]
        data_start = offset + 16 + table_length
        self.files: dict[str, FileInfo] = {}
        for i in range(count):
            begin, length, at, reserved = struct.unpack_from("<QQII", index, i * 24)
            if at >= len(string_table):
                raise NativeNCAError("PFS0 filename offset exceeds its string table.")
            end = string_table.find(b"\0", at)
            if end < 0:
                raise NativeNCAError("Unterminated PFS0 filename.")
            name = _filename(string_table[at:end])
            if begin > section.size - data_start or length > section.size - data_start - begin:
                raise NativeNCAError("PFS0 entry exceeds NCA section bounds.")
            if name in self.files:
                raise NativeNCAError("Duplicate PFS0 entry name.")
            self.files[name] = FileInfo(name, name, data_start + begin, length)

    def children(self, folder: str = "") -> list[dict]:
        if folder:
            raise NativeNCAError("PartitionFS has no nested directories.")
        return [{"name": f.name, "path": f.path, "type": "file", "size": f.size}
                for f in self.files.values()]

    def file(self, name: str) -> FileInfo:
        if name not in self.files:
            raise NativeNCAError("PFS0 file is no longer in the selected section.")
        return self.files[name]


class RomFS:
    """Lazy Nintendo Switch RomFS directory/file tables with loop protection."""

    def __init__(self, section: NativeSection, offset: int):
        self.section = section
        self.offset = offset
        header = section.read(offset, 0x50)
        fields = struct.unpack_from("<10Q", header)
        (header_size, dir_hash_off, dir_hash_size, dir_table_off, dir_table_size,
         file_hash_off, file_hash_size, file_table_off, file_table_size, data_off) = fields
        if header_size != 0x50:
            raise NativeNCAError("RomFS header does not have the expected 0x50-byte structure.")
        for begin, length in ((dir_hash_off, dir_hash_size),
                              (dir_table_off, dir_table_size),
                              (file_hash_off, file_hash_size),
                              (file_table_off, file_table_size)):
            if begin > section.size - offset or length > section.size - offset - begin:
                raise NativeNCAError("RomFS metadata is outside the section.")
        if dir_table_size < 0x18 or dir_table_size > MAX_META or file_table_size > MAX_META:
            raise NativeNCAError("RomFS directory tables exceed safety limits.")
        if data_off > section.size - offset:
            raise NativeNCAError("RomFS file data area lies outside the section.")
        self.dir_table_off, self.dir_table_size = offset + dir_table_off, dir_table_size
        self.file_table_off, self.file_table_size = offset + file_table_off, file_table_size
        self.file_data_off = offset + data_off
        # Cache only the small bounded filesystem tables, not gigabytes of
        # encrypted model/texture payload. Tree expansion is much faster.
        self._directory_table = section.read(self.dir_table_off, self.dir_table_size)
        self._file_table = section.read(self.file_table_off, self.file_table_size)
        self._directories = {"": 0}
        self._files: dict[str, FileInfo] = {}
        self._children: dict[str, list[dict]] = {}

    def _directory(self, at: int):
        if at == NONE or at > self.dir_table_size - 24:
            raise NativeNCAError("Invalid RomFS directory table pointer.")
        data = self._directory_table
        parent, sibling, child_dir, child_file, hashed, name_size = struct.unpack_from("<6I", data, at)
        if name_size > 4096 or 24 + name_size > self.dir_table_size - at:
            raise NativeNCAError("Invalid RomFS directory name size.")
        name = data[at + 24:at + 24 + name_size]
        return (_filename(name) if name else "", sibling, child_dir, child_file)

    def _file(self, at: int):
        if at == NONE or at > self.file_table_size - 32:
            raise NativeNCAError("Invalid RomFS file table pointer.")
        data = self._file_table
        parent, sibling, begin, size, hashed, name_length = struct.unpack_from("<IIQQII", data, at)
        if name_length > 4096 or 32 + name_length > self.file_table_size - at:
            raise NativeNCAError("Invalid RomFS filename length.")
        name = _filename(data[at + 32:at + 32 + name_length])
        if (self.file_data_off > self.section.size or
                begin > self.section.size - self.file_data_off or
                size > self.section.size - self.file_data_off - begin):
            raise NativeNCAError("RomFS file extends beyond NCA section.")
        return name, sibling, self.file_data_off + begin, size

    def children(self, folder: str = "") -> list[dict]:
        if folder in self._children:
            return list(self._children[folder])
        if folder not in self._directories:
            raise NativeNCAError("Unknown RomFS folder.")
        _, _, first_dir, first_file = self._directory(self._directories[folder])
        listing = []
        seen = set()
        cursor = first_dir
        while cursor != NONE:
            if cursor in seen or len(seen) >= MAX_CHILDREN:
                raise NativeNCAError("RomFS directory chain is cyclic or too large.")
            seen.add(cursor)
            name, sibling, _, _ = self._directory(cursor)
            if not name:
                raise NativeNCAError("Unexpected empty nested RomFS directory.")
            child_path = (folder + "/" + name).strip("/")
            self._directories[child_path] = cursor
            listing.append({"name": name, "path": child_path, "type": "directory", "size": 0})
            cursor = sibling
        seen.clear()
        cursor = first_file
        while cursor != NONE:
            if cursor in seen or len(seen) + len(listing) >= MAX_CHILDREN:
                raise NativeNCAError("RomFS file chain is cyclic or too large.")
            seen.add(cursor)
            name, sibling, begin, size = self._file(cursor)
            child_path = (folder + "/" + name).strip("/")
            self._files[child_path] = FileInfo(name, child_path, begin, size)
            listing.append({"name": name, "path": child_path, "type": "file", "size": size})
            cursor = sibling
        self._children[folder] = listing
        return list(listing)

    def file(self, name: str) -> FileInfo:
        if name not in self._files:
            parent = name.rpartition("/")[0]
            self.children(parent)
        if name not in self._files:
            raise NativeNCAError("RomFS file is not part of the selected directory.")
        return self._files[name]


def read_file(fs, name: str, offset: int = 0, length: int = 512) -> bytes:
    file = fs.file(name)
    if offset < 0 or length < 0 or offset > file.size:
        raise NativeNCAError("Invalid virtual file read offset.")
    return fs.section.read(file.offset + offset, min(length, file.size - offset))


def copy_file(fs, name: str, target: str | Path) -> Path:
    """Stream exactly one selected file. Never overwrite or extract whole games."""
    file = fs.file(name)
    dest = Path(target)
    if not dest.parent.is_dir():
        raise NativeNCAError("Destination folder does not exist.")
    with dest.open("xb") as output:
        try:
            written = 0
            while written < file.size:
                chunk = fs.section.read(file.offset + written,
                                        min(CHUNK, file.size - written))
                if not chunk:
                    raise NativeNCAError("Unexpected end of NCA filesystem file.")
                output.write(chunk)
                written += len(chunk)
        except BaseException:
            output.close()
            dest.unlink(missing_ok=True)
            raise
    return dest
