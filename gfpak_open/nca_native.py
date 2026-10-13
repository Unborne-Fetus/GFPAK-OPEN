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

import hashlib
import re
import struct
from collections import OrderedDict
from .bucket_tree import BucketTree, BucketTreeError
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

    def __init__(self, path: str | Path | None, title_path: str | Path | None = None):
        self._keys = {}
        # Load locally provided production and title keys together; no key data
        # leaves this process or gets written to settings/logs.
        for source in (path, title_path):
            if not source:
                continue
            file = Path(source)
            if not file.is_file() or file.stat().st_size > 1024 * 1024:
                raise NativeNCAError("A selected local keys file is missing or too large.")
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
    def title_key_count(self):
        """Count rights-ID indexed keys without revealing values."""
        return sum(1 for name, value in self._keys.items()
                   if len(value) == 16 and
                   (re.fullmatch(r"[0-9a-f]{32}", name) or
                    re.fullmatch(r"titlekey_[0-9a-f]{32}", name)))

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


def decode_nca3_header(raw: bytes, keys: Keyset) -> tuple[bytes, bool, str]:
    """Decode only the 0xC00-byte NCA header, shared by reader and diagnostics."""
    if len(raw) < 0xC00:
        raise NativeNCAError("NCA header is incomplete.")
    if raw[0x200:0x204] == b"NCA3":
        return raw[:0xC00], True, "none"
    key = keys.get("nca_header_key", "header_key")
    if not key or len(key) != 32:
        raise NativeNCAError(
            "Encrypted NCA detected. GFPAK-OPEN's built-in reader needs a "
            "compatible user-supplied keys file; no other app is needed."
        )
    for order in ("big", "little"):
        try:
            candidate = b"".join(
                _xts(key, raw[i:i + 0x200], i // 0x200, order)
                for i in range(0, 0xC00, 0x200)
            )
        except ValueError:
            continue
        if candidate[0x200:0x204] == b"NCA3":
            return candidate, False, order
    raise NativeNCAError("The supplied NCA header key could not decode this NCA3 header.")


def inspect_nca3_header(raw: bytes, keys: Keyset) -> dict:
    """Safe metadata-only diagnosis; no rights ID, content key or game bytes returned."""
    header, plaintext, tweak = decode_nca3_header(raw, keys)
    rights = header[0x230:0x240]
    generation = max(header[0x206], header[0x220])
    sections = []
    for i in range(4):
        start, end = struct.unpack_from("<II", header, 0x240 + i * 16)
        if start == 0 and end == 0:
            continue
        fs_header = header[0x400 + i * 0x200:0x600 + i * 0x200]
        expected_hash = header[0x280 + 0x20 * i:0x2A0 + 0x20 * i]
        sections.append({"section": i, "encryption_mode": fs_header[4],
                         "fs_header_revision": fs_header[:2].hex(),
                         "section_header_sha256_valid": (
                             hashlib.sha256(fs_header).digest() == expected_hash
                         )})
    if not any(rights):
        match = "not-rights-managed"
        fingerprint = "none"
    else:
        identifier = rights.hex()
        direct = keys.get("titlekey_" + identifier, identifier)
        reversed_id = rights[::-1].hex()
        reversed_key = keys.get("titlekey_" + reversed_id, reversed_id)
        if direct is not None:
            match = "exact-match" if len(direct) == 16 else "invalid-length"
        elif reversed_key is not None:
            match = "byte-reversed-entry-only (not used for decryption)"
        else:
            match = "missing"
        fingerprint = hashlib.sha256(rights).hexdigest()[:16]
    return {
        "nca_magic": "NCA3",
        "header": "plaintext" if plaintext else "encrypted",
        "header_tweak_endianness": tweak,
        "rights_id_header_offset": "0x230",
        "rights_id_fingerprint_sha256_16": fingerprint,
        "rights_id_key_match": match,
        "key_generation": generation,
        "key_area_type": header[0x207],
        "sections": sections,
    }


def inspect_nca3_entry(analyzer: NSPAnalyzer, index: int, keys: Keyset) -> dict:
    """Read only the first 3072 bytes, even for multi-gigabyte NCA entries."""
    entry = analyzer.get(index)
    if not entry.name.lower().endswith(".nca") or entry.size < 0xC00:
        raise NativeNCAError("Selected entry is not a complete NCA header.")
    with analyzer.path.open("rb") as source:
        source.seek(entry.offset)
        raw = source.read(0xC00)
    details = inspect_nca3_header(raw, keys)
    rights = decode_nca3_header(raw, keys)[0][0x230:0x240]
    if any(rights):
        generation = details["key_generation"]
        revision = max(0, generation - 1)
        _content, source, status, tickets = resolve_title_content_key(
            analyzer, rights, revision, keys
        )
        details["content_key_source"] = source
        details["content_key_status"] = status
        details["package_ticket_entries"] = tickets
        details["package_ticket_inspection"] = inspect_package_tickets(analyzer, rights)
    # Header-only probes on the same readonly reader used by the actual app.
    # A readable ticket never means a filesystem has decrypted successfully.
    try:
        reader = NativeNCA(analyzer, index, keys)
        details["filesystem_header_probes"] = [
            reader.sections[number].probe_filesystem_header()
            for number in sorted(reader.sections)
        ]
    except (OSError, RuntimeError, ValueError) as error:
        details["filesystem_header_probe_error"] = str(error)[:180]
    return details


# Only signature types documented for Switch tickets. The signature padding
# is included in each body offset; no ticket bytes are returned to the UI.
TICKET_BODY_OFFSETS = {
    0x010000: 0x240, 0x010001: 0x140, 0x010002: 0x80,
    0x010003: 0x240, 0x010004: 0x140, 0x010005: 0x80,
    0x010006: 0x40,
}


def _inspect_ticket(raw: bytes) -> tuple[dict | None, str]:
    """Parse bounded ticket fields, with a safe failure reason for diagnostics.

    Signature type is seen in both byte orders in ticket producers. Never
    interpret one without checking the known signature IDs and body bounds.
    """
    if len(raw) < 4:
        return None, "too-short-for-signature"
    signature = raw[:4]
    sig_big = int.from_bytes(signature, "big")
    sig_little = int.from_bytes(signature, "little")
    if sig_big in TICKET_BODY_OFFSETS:
        body, byte_order = TICKET_BODY_OFFSETS[sig_big], "big"
    elif sig_little in TICKET_BODY_OFFSETS:
        body, byte_order = TICKET_BODY_OFFSETS[sig_little], "little"
    else:
        return None, "unrecognized-signature-type"
    if len(raw) < body + 0x170:
        return None, "truncated-ticket-data"
    key_type = raw[body + 0x141]
    if key_type not in (0, 1):
        return None, "unsupported-title-key-type"
    rights = raw[body + 0x160:body + 0x170]
    if not any(rights):
        return None, "missing-rights-id"
    return {
        "rights_id": rights,
        "key_type": key_type,
        "generation": raw[body + 0x145],
        "ticket_version": raw[body + 0x140],
        "signature_byte_order": byte_order,
        "encrypted_key": raw[body + 0x40:body + 0x50] if key_type == 0 else None,
    }, "ok"


def _parse_common_ticket(raw: bytes) -> dict | None:
    """Keep matching and diagnostic parsing on exactly the same code path."""
    ticket, _reason = _inspect_ticket(raw)
    return ticket


def _matching_package_ticket(analyzer: NSPAnalyzer, rights: bytes) -> tuple[dict | None, int]:
    """Search only indexed .tik entries, reading at most 1280 bytes per ticket."""
    entries = getattr(analyzer, "entries", ())
    ticket_entries = [e for e in entries if e.name.lower().endswith(".tik")]
    if not ticket_entries:
        return None, 0
    # Cap per-package work even for deliberately pathological indexes.
    with analyzer.path.open("rb") as source:
        for entry in ticket_entries[:4096]:
            if entry.size < 0x1B0 or entry.size > 1024 * 1024:
                continue
            source.seek(entry.offset)
            ticket = _parse_common_ticket(source.read(min(entry.size, 0x500)))
            if ticket is not None and ticket["rights_id"] == rights:
                return ticket, len(ticket_entries)
    return None, len(ticket_entries)



def inspect_package_tickets(analyzer: NSPAnalyzer, rights: bytes) -> dict:
    """Explain ticket mismatch using bounded metadata reads, never key bytes or IDs.

    A package containing a .tik file is not necessarily licensed for every NCA
    inside it. A parse failure must not be mislabeled as a rights-ID mismatch.
    """
    entries = [e for e in getattr(analyzer, "entries", ())
               if e.name.lower().endswith(".tik")]
    result = {
        "ticket_entries": len(entries),
        "tickets_checked": 0,
        "parsed_tickets": 0,
        "unreadable_or_unsupported_tickets": 0,
        "parse_failure_reasons": {},
        "signature_byte_orders": {"big": 0, "little": 0},
        "exact_rights_matches": 0,
        "same_rights_prefix_different_generation": 0,
        "other_rights_ids": 0,
        "matching_ticket_type": "none",
        "matching_ticket_revision": None,
        "relation": "no-ticket",
    }
    if not entries:
        return result
    with analyzer.path.open("rb") as source:
        for entry in entries[:4096]:
            result["tickets_checked"] += 1
            if not 0x1B0 <= entry.size <= 1024 * 1024:
                result["unreadable_or_unsupported_tickets"] += 1
                failures = result["parse_failure_reasons"]
                failures["invalid-ticket-size"] = failures.get("invalid-ticket-size", 0) + 1
                continue
            source.seek(entry.offset)
            ticket, reason = _inspect_ticket(source.read(min(entry.size, 0x500)))
            if ticket is None:
                result["unreadable_or_unsupported_tickets"] += 1
                failures = result["parse_failure_reasons"]
                failures[reason] = failures.get(reason, 0) + 1
                continue
            result["parsed_tickets"] += 1
            result["signature_byte_orders"][ticket["signature_byte_order"]] += 1
            if ticket["rights_id"] == rights:
                result["exact_rights_matches"] += 1
                result["matching_ticket_type"] = (
                    "common" if ticket["key_type"] == 0 else "personalized"
                )
                result["matching_ticket_revision"] = ticket["generation"]
            elif ticket["rights_id"][:15] == rights[:15]:
                # Only a diagnostic hint: never decrypt with a nonmatching ID.
                result["same_rights_prefix_different_generation"] += 1
            else:
                result["other_rights_ids"] += 1
    if result["exact_rights_matches"]:
        result["relation"] = "exact-match"
    elif result["same_rights_prefix_different_generation"]:
        result["relation"] = "generation-byte-differs"
    elif result["parsed_tickets"]:
        result["relation"] = "ticket-for-different-rights-id"
    else:
        result["relation"] = "ticket-present-but-unreadable-or-unsupported"
    if len(entries) > 4096:
        result["scan_limit_reached"] = True
    return result


def resolve_title_content_key(analyzer: NSPAnalyzer, rights: bytes, revision: int,
                              keys: Keyset) -> tuple[bytes | None, str, str, int]:
    """Resolve locally supplied encrypted title key or a matching common NSP ticket.

    Returns key, source, status and ticket count. No secrets leave this module.
    A personalized ticket cannot be decrypted by the common-ticket path.
    """
    name = rights.hex()
    encrypted = keys.get("titlekey_" + name, name)
    source = "title.keys" if encrypted is not None else "none"
    ticket_count = 0
    if encrypted is None:
        ticket, ticket_count = _matching_package_ticket(analyzer, rights)
        if ticket is None:
            return None, source, "no-matching-titlekey-or-package-ticket", ticket_count
        source = "package-ticket"
        if ticket["key_type"] == 1:
            return None, source, "personalized-ticket-unsupported", ticket_count
        encrypted = ticket["encrypted_key"]
        # Ticket revision is authoritative for its ticket-common key.
        revision = ticket["generation"]
    if len(encrypted) != 16:
        return None, source, "invalid-encrypted-titlekey-length", ticket_count
    titlekek = keys.get(
        f"titlekek_{revision:02x}", f"ticket_commonkey_{revision:02x}"
    )
    if titlekek is None or len(titlekek) != 16:
        return None, source, f"titlekek-unavailable-revision-{revision:02x}", ticket_count
    return _aes_ecb(titlekek, encrypted), source, "resolved-unverified", ticket_count


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: bytes, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]


def _ivfc_data_region(header: bytes) -> tuple[int, int]:
    """Return the last IVFC region without mistaking the master hash for a level.

    The on-disk MaxLayers count includes the external master-hash level.
    For example, a normal Switch RomFS reports 7 levels but has only six
    0x18-byte region descriptors. Region 5, not out-of-bounds region 6,
    contains the real RomFS. All region offsets are 64-bit.
    """
    if header[8:12] != b"IVFC":
        raise NativeNCAError("RomFS IVFC superblock is not supported.")
    levels = _u32(header, 0x14)
    if not 2 <= levels <= 7:
        raise NativeNCAError(
            f"RomFS has an invalid IVFC level count ({levels}); expected 2–7."
        )
    info_at = 0x18 + (levels - 2) * 0x18
    # Six descriptors occupy 0x18 through 0xA7, inside the 0xF8
    # hash-data region. Never read a fabricated seventh descriptor.
    if info_at + 0x18 > 0xA8:
        raise NativeNCAError("RomFS IVFC region descriptor exceeds its header.")
    logical_offset = _u64(header, info_at)
    logical_size = _u64(header, info_at + 8)
    if not logical_size:
        raise NativeNCAError("RomFS IVFC data region has zero length.")
    return logical_offset, logical_size


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
        self.patch_indirect_offset = _u64(fs_header, 0x100)
        self.patch_indirect_size = _u64(fs_header, 0x108)
        self.patch_crypto_offset = _u64(fs_header, 0x120)
        self.patch_crypto_size = _u64(fs_header, 0x128)
        self.sparse_table_offset = _u64(fs_header, 0x148)
        self.sparse_table_size = _u64(fs_header, 0x150)
        self.compression_table_offset = _u64(fs_header, 0x178)
        self.compression_table_size = _u64(fs_header, 0x180)
        self.counter_prefix = fs_header[0x140:0x148][::-1]
        self._fs = None
        self._storage_tree = None
        self._storage_base = 0
        self._storage_kind = None
        self.base_section = None
        self.logical_size = size

    def read(self, relative: int, size: int) -> bytes:
        # A direct section read must not silently bypass a declared compressed,
        # sparse or update mapping merely because the folder tree has not been
        # opened yet. filesystem() installs the map before reading file entries.
        if self._storage_tree is None and self._fs is None and (
            self.patch_indirect_size or self.patch_crypto_size or
            self.sparse_table_size or self.compression_table_size
        ):
            self.filesystem()
        if self._storage_tree is not None:
            if relative < 0 or size < 0 or relative > self.logical_size or size > self.logical_size - relative:
                raise NativeNCAError("Read outside mapped NCA filesystem section.")
            if relative >= self._storage_base:
                offset = relative - self._storage_base
                if self._storage_kind == "compressed":
                    return self._storage_tree.read_compressed(
                        offset, size,
                        lambda physical, count: self._read_regular(self._storage_base + physical, count)
                    )
                if self._storage_kind == "sparse":
                    return self._storage_tree.read_indirect(
                        offset, size,
                        lambda physical, count: self._read_regular(physical, count),
                        sparse=True
                    )
                if self._storage_kind == "patch":
                    return self._storage_tree.read_indirect(
                        offset, size,
                        lambda physical, count: self.base_section.read(physical, count),
                        lambda physical, count: self._read_regular(physical, count),
                    )
        return self._read_regular(relative, size)

    def _read_regular(self, relative: int, size: int) -> bytes:
        if size < 0 or relative < 0 or relative > self.size or size > self.size - relative:
            raise NativeNCAError("Requested data is outside the NCA filesystem section.")
        absolute = self.start + relative
        # A plaintext *header* does not imply plaintext section data.
        # Some extracted NCAs have a decoded header but retain CTR-encrypted
        # filesystem sections. Honor each section's declared encryption mode.
        if self.encryption == 1:
            return self.nca.read_raw(absolute, size)
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

    def probe_filesystem_header(self) -> dict:
        """Check only the first 16-80 decoded filesystem bytes.

        A title-key match alone cannot establish that section decryption worked.
        No decrypted data, keys, counters, or unbounded file reads are returned.
        """
        result = {
            "section": self.number,
            "encryption_mode": self.encryption,
            "filesystem": "RomFS" if self.fs_type in (0, 3) else
                          "PartitionFS" if self.fs_type in (1, 2) else "unknown",
            "status": "unsupported",
        }
        if (self.patch_indirect_size or self.patch_crypto_size or
                self.sparse_table_size or self.compression_table_size or
                self.encryption not in (1, 2, 3)):
            result["status"] = "storage-mapping-requires-separate-validation"
            return result
        try:
            if self.fs_type in (0, 3) or self.hash_type in (3, 6):
                offset, length = _ivfc_data_region(self.fs_header)
                if offset > self.size or length > self.size - offset or length < 0x50:
                    result["status"] = "ivfc-data-bounds-invalid"
                    return result
                decoded = self._read_regular(offset, 0x50)
                result["status"] = (
                    "valid-romfs-header" if len(decoded) == 0x50 and
                    _u64(decoded, 0) == 0x50 else "invalid-decoded-romfs-header"
                )
            elif self.fs_type in (1, 2) and self.hash_type in (0, 1, 2, 5):
                offset = _u64(self.fs_header, 0x40) if self.hash_type in (2, 5) else 0
                if offset > self.size or self.size - offset < 0x10:
                    result["status"] = "partitionfs-data-bounds-invalid"
                    return result
                decoded = self._read_regular(offset, 0x10)
                result["status"] = (
                    "valid-partitionfs-header" if decoded[:4] == b"PFS0" else
                    "invalid-decoded-partitionfs-header"
                )
        except (ValueError, OSError, RuntimeError) as error:
            result["status"] = "probe-failed"
            result["reason"] = str(error)[:180]
        return result

    def compatibility(self) -> dict:
        """Describe NCA storage features without pretending they are decoded."""
        return {
            "section": self.number, "encryption": self.encryption,
            "header_probe_status": self.probe_filesystem_header()["status"],
            "filesystem": "RomFS" if self.fs_type == 0 else
                          "PartitionFS" if self.fs_type == 1 else "Unknown",
            "update_patch": bool(self.patch_indirect_size or self.patch_crypto_size or
                                 self.encryption in (4, 6)),
            "sparse": bool(self.sparse_table_size),
            "compressed_storage": bool(self.compression_table_size),
            "needs_base_nca": bool(self.patch_indirect_size),
            "bucket_tree_supported": (
                not (self.patch_indirect_size or self.patch_crypto_size or self.encryption in (4, 6))
                and not (self.sparse_table_size and self.compression_table_size)
                and (not self.sparse_table_size or self.encryption == 1)
                and (not self.compression_table_size or self.encryption in (1, 3))
            ),
        }

    def filesystem(self):
        if self._fs is not None:
            return self._fs
        header = self.fs_header
        if self.patch_indirect_size or self.patch_crypto_size or self.encryption in (4, 6):
            if not self.base_section:
                raise NativeNCAError(
                    "This update/DLC RomFS needs its matching base NCA. "
                    "Use Link base NCA to supply the unmodified base content."
                )
            if self.patch_crypto_size or self.encryption not in (1,):
                raise NativeNCAError(
                    "Encrypted AES-CTR-Ex BKTR patch overlay cannot yet be decoded; "
                    "the linked base NCA is preserved and unaffected sections remain readable."
                )
            count = _u32(header, 0x118)
            if self.patch_indirect_offset > self.size or self.patch_indirect_size > self.size - self.patch_indirect_offset:
                raise NativeNCAError("BKTR patch table is outside the NCA section.")
            try:
                tree = BucketTree(
                    lambda at, length: self._read_regular(self.patch_indirect_offset + at, length),
                    self.patch_indirect_size, count)
            except BucketTreeError as exc:
                raise NativeNCAError("Malformed BKTR patch table: " + str(exc)) from exc
            self._storage_tree = tree
            self._storage_base = 0
            self._storage_kind = "patch"
            self.logical_size = max(self.size, tree.end)

        if self.sparse_table_size and self.compression_table_size:
            raise NativeNCAError("Combined sparse/compressed NCA layers require a matching patch and are not decoded.")
        if self.encryption not in (1, 2, 3):
            raise NativeNCAError(
                f"Unsupported NCA section encryption type {self.encryption}."
            )
        # Physical storage offsets remain bounded by the real NCA section.
        # BucketTree data maps the virtual filesystem without staging whole
        # NCAs to disk or allocating one large output buffer.
        if self.sparse_table_size:
            if self.encryption != 1:
                raise NativeNCAError(
                    "Sparse remapping currently supports plaintext sections only; "
                    "the encrypted sparse IV generation requires separate validation."
                )
            offset = _u64(header, 0x168) + self.sparse_table_offset
            count = _u32(header, 0x160)
            if not offset or offset + self.sparse_table_size > self.nca.entry.size:
                raise NativeNCAError("Sparse table is outside the NCA.")
            try:
                tree = BucketTree(
                    lambda at, count_bytes: self.nca.read_raw(offset + at, count_bytes),
                    self.sparse_table_size, count)
            except BucketTreeError as exc:
                raise NativeNCAError("Invalid sparse mapping: " + str(exc)) from exc
            self._storage_tree = tree
            self._storage_kind = "sparse"
            self.logical_size = max(self.size, tree.end)
        if self.compression_table_size:
            if self.encryption not in (1, 3):
                raise NativeNCAError("Unsupported compressed section encryption mode.")
            # The hash-target offset is the regular base for compressed blocks.
            # The table itself is stored in the same physical section after
            # that base, so it must be read through the unmapped section.
            if self.fs_type in (1, 2) and self.hash_type in (2, 5):
                base = _u64(header, 0x40)
            elif self.fs_type in (0, 3) or self.hash_type in (3, 6):
                base, _length = _ivfc_data_region(header)
            else:
                raise NativeNCAError("Unsupported compressed filesystem type.")
            table_at = base + self.compression_table_offset
            count = _u32(header, 0x190)
            if table_at > self.size or self.compression_table_size > self.size - table_at:
                raise NativeNCAError("Compressed storage table is outside the section.")
            try:
                tree = BucketTree(
                    lambda at, count_bytes: self._read_regular(table_at + at, count_bytes),
                    self.compression_table_size, count, compressed=True)
            except BucketTreeError as exc:
                raise NativeNCAError("Invalid compressed NCA storage map: " + str(exc)) from exc
            self._storage_tree = tree
            self._storage_base = base
            self._storage_kind = "compressed"
            self.logical_size = max(self.size, base + tree.end)
        if self.fs_type in (1, 2) and self.hash_type in (0, 1, 2, 5):
            # Hierarchical SHA256 hash table followed by real PFS0 data layer.
            file_offset = _u64(header, 0x40) if self.hash_type in (2, 5) else 0
            if file_offset >= self.logical_size:
                raise NativeNCAError("PartitionFS data offset is beyond its section.")
            self._fs = PartitionFS(self, file_offset)
        elif self.fs_type in (0, 3) or self.hash_type in (3, 6):
            # IVFC MaxLayers includes the external master-hash level.
            file_offset, data_length = _ivfc_data_region(header)
            if file_offset >= self.logical_size or data_length > self.logical_size - file_offset:
                raise NativeNCAError("RomFS IVFC data region is outside the readable NCA section.")
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

    def attach_base(self, base: "NativeNCA") -> int:
        """Associate matching section numbers with the user's explicit base NCA."""
        if base is self or base.analyzer.path.resolve() == self.analyzer.path.resolve():
            raise NativeNCAError("A patched NCA cannot use itself as a base.")
        added = 0
        for number, section in self.sections.items():
            original = base.sections.get(number)
            if original and original.fs_type == section.fs_type:
                section.base_section = original
                section._fs = None
                section._storage_tree = None
                section._storage_kind = None
                section.logical_size = section.size
                added += 1
        if not added:
            raise NativeNCAError("The base NCA has no matching filesystem section numbers/types.")
        return added

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
        header, self.plaintext, self.header_tweak = decode_nca3_header(raw, self.keys)
        self.header = header
        old_generation, key_type = header[0x206], header[0x207]
        generation = max(old_generation, header[0x220])
        revision = max(0, generation - 1)
        rights = header[0x230:0x240]
        area = header[0x300:0x340]
        content_keys = None
        if any(section_header[4] in (2, 3, 4, 5, 6)
               for section_header in (header[0x400+i*0x200:0x600+i*0x200]
                                      for i in range(4))):
            if any(rights):
                content, key_source, key_status, ticket_count = resolve_title_content_key(
                    self.analyzer, rights, revision, self.keys
                )
                if content is not None:
                    content_keys = (content, content, content, content)
                else:
                    raise NativeNCAError(
                        "Rights-managed NCA: content key unavailable "
                        f"({key_status}). Loaded {self.keys.title_key_count} title keys "
                        f"and found {ticket_count} ticket entries in this package. "
                        "The app never displays key values."
                    )
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
            if encryption not in (1, 2, 3, 4, 5, 6):
                raise NativeNCAError(
                    f"NCA section {i} uses unknown encryption mode {encryption}."
                )
            if encryption in (2, 3) and content_keys is None:
                raise NativeNCAError(
                    "NCA key-area key unavailable for this title's key generation "
                    f"(revision {revision:02x}, area type {key_type}). "
                    "The supplied keys file may be missing this revision's key-area key."
                )
            key = None
            if encryption == 3:
                key = content_keys[2]
            elif encryption == 2:
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
        if table_length > getattr(section, "logical_size", section.size) - offset - 16:
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
            if begin > getattr(section, "logical_size", section.size) - data_start or length > getattr(section, "logical_size", section.size) - data_start - begin:
                raise NativeNCAError("PFS0 entry exceeds NCA section bounds.")
            if name in self.files:
                raise NativeNCAError("Duplicate PFS0 entry name.")
            self.files[name] = FileInfo(name, name, data_start + begin, length)

    def children_page(self, folder: str = "", cursor: str | None = None,
                      limit: int = 250) -> dict:
        if folder:
            raise NativeNCAError("PartitionFS has no nested directories.")
        if not isinstance(limit, int) or not 1 <= limit <= 500:
            raise NativeNCAError("Invalid PartitionFS page size.")
        if cursor is None:
            start = 0
        else:
            if not isinstance(cursor, str) or not re.fullmatch(r"p:[0-9a-f]{8}", cursor):
                raise NativeNCAError("Invalid PartitionFS page cursor.")
            start = int(cursor[2:], 16)
            if start > len(self.files):
                raise NativeNCAError("PartitionFS page cursor exceeds the file count.")
        files = list(self.files.values())
        subset = files[start:start + limit]
        next_at = start + len(subset)
        return {
            "entries": [{"name": f.name, "path": f.path, "type": "file", "size": f.size}
                        for f in subset],
            "next_cursor": f"p:{next_at:08x}" if next_at < len(files) else None,
        }

    def children(self, folder: str = "") -> list[dict]:
        # Existing small-folder callers keep working, while the UI uses pages.
        if folder:
            raise NativeNCAError("PartitionFS has no nested directories.")
        return [{"name": f.name, "path": f.path, "type": "file", "size": f.size}
                for f in self.files.values()]

    def file(self, name: str) -> FileInfo:
        if name not in self.files:
            raise NativeNCAError("PFS0 file is no longer in the selected section.")
        return self.files[name]


class _RomFSMetadataTable:
    """Random-access RomFS metadata, cached in a bounded number of 64 KiB pages.

    RomFS file/directory tables can be hundreds of MiB in large games. Do not
    load the entire table, even once; only fetch the bytes needed to display the
    current directory, and reuse those pages for sibling entries.
    """

    PAGE_BYTES = 64 * 1024
    CACHE_PAGES = 32

    def __init__(self, section: NativeSection, offset: int, size: int):
        if size < 0 or offset < 0 or offset > getattr(section, "logical_size", section.size) or size > getattr(section, "logical_size", section.size) - offset:
            raise NativeNCAError("RomFS metadata table exceeds its NCA section.")
        self.section = section
        self.offset = offset
        self.size = size
        self._pages: OrderedDict[int, bytes] = OrderedDict()

    def _page(self, page: int) -> bytes:
        if page in self._pages:
            self._pages.move_to_end(page)
            return self._pages[page]
        start = page * self.PAGE_BYTES
        length = min(self.PAGE_BYTES, self.size - start)
        data = self.section.read(self.offset + start, length)
        if len(data) != length:
            raise NativeNCAError("Truncated RomFS metadata page.")
        self._pages[page] = data
        if len(self._pages) > self.CACHE_PAGES:
            self._pages.popitem(last=False)
        return data

    def read(self, at: int, size: int) -> bytes:
        if at < 0 or size < 0 or at > self.size or size > self.size - at:
            raise NativeNCAError("RomFS metadata entry is outside its table.")
        pieces = []
        remaining = size
        while remaining:
            page, column = divmod(at, self.PAGE_BYTES)
            block = self._page(page)
            take = min(remaining, len(block) - column)
            if take <= 0:
                raise NativeNCAError("Invalid RomFS metadata page boundary.")
            pieces.append(block[column:column + take])
            at += take
            remaining -= take
        return b"".join(pieces)


class RomFS:
    """On-demand RomFS filesystem traversal with a paginated directory tree.

    A section's *size* is not a reason to reject it. All metadata comes from
    bounded page reads; directories containing more than 3,000 entries expose
    continuation cursors instead of being rejected or silently truncated.
    """

    PAGE_SIZE = 250
    MAX_PAGE_SIZE = 500
    MAX_VISITED_ENTRIES = 2_000_000

    def __init__(self, section: NativeSection, offset: int):
        self.section = section
        self.offset = offset
        header = section.read(offset, 0x50)
        if len(header) != 0x50:
            raise NativeNCAError("Truncated RomFS header.")
        (header_size, dir_hash_off, dir_hash_size, dir_table_off, dir_table_size,
         file_hash_off, file_hash_size, file_table_off, file_table_size, data_off) = (
            struct.unpack("<10Q", header))
        if header_size != 0x50:
            raise NativeNCAError(
                "Decrypted RomFS header is invalid (expected a 0x50-byte header). "
                "The NCA header and ticket can be readable while the section's "
                "AES-CTR data is still incorrect. Use Copy NCA Diagnostics to "
                "check this section's filesystem header before attempting extraction."
            )
        if offset < 0 or offset > getattr(section, "logical_size", section.size):
            raise NativeNCAError("RomFS image begins outside the NCA section.")
        remaining = getattr(section, "logical_size", section.size) - offset
        for begin, length in ((dir_hash_off, dir_hash_size),
                              (dir_table_off, dir_table_size),
                              (file_hash_off, file_hash_size),
                              (file_table_off, file_table_size)):
            if begin > remaining or length > remaining - begin:
                raise NativeNCAError("RomFS metadata is outside the section.")
        if dir_table_size < 0x18:
            raise NativeNCAError("RomFS directory metadata is incomplete.")
        if data_off > remaining:
            raise NativeNCAError("RomFS file data area lies outside the section.")
        self.dir_table_off, self.dir_table_size = offset + dir_table_off, dir_table_size
        self.file_table_off, self.file_table_size = offset + file_table_off, file_table_size
        self.file_data_off = offset + data_off
        self._directory_table = _RomFSMetadataTable(
            section, self.dir_table_off, self.dir_table_size)
        self._file_table = _RomFSMetadataTable(
            section, self.file_table_off, self.file_table_size)
        self._directories: dict[str, int] = {"": 0}
        self._files: dict[str, FileInfo] = {}
        # Only pages requested by the user are remembered, not complete folders.
        self._page_cache: dict[tuple[str, str], dict] = {}
        self._issued: dict[str, set[str]] = {}
        self._seen: dict[str, dict[str, set[int]]] = {}

    def _directory(self, at: int):
        if at == NONE or at < 0 or at > self.dir_table_size - 24:
            raise NativeNCAError("Invalid RomFS directory table pointer.")
        data = self._directory_table.read(at, 24)
        parent, sibling, child_dir, child_file, hashed, name_size = struct.unpack(
            "<6I", data)
        if name_size > 4096 or 24 + name_size > self.dir_table_size - at:
            raise NativeNCAError("Invalid RomFS directory name size.")
        name = self._directory_table.read(at + 24, name_size)
        return (_filename(name) if name else "", sibling, child_dir, child_file)

    def _file(self, at: int):
        if at == NONE or at < 0 or at > self.file_table_size - 32:
            raise NativeNCAError("Invalid RomFS file table pointer.")
        data = self._file_table.read(at, 32)
        parent, sibling, begin, size, hashed, name_length = struct.unpack(
            "<IIQQII", data)
        if name_length > 4096 or 32 + name_length > self.file_table_size - at:
            raise NativeNCAError("Invalid RomFS filename length.")
        name = _filename(self._file_table.read(at + 32, name_length))
        if (self.file_data_off > getattr(self.section, "logical_size", self.section.size) or
                begin > getattr(self.section, "logical_size", self.section.size) - self.file_data_off or
                size > getattr(self.section, "logical_size", self.section.size) - self.file_data_off - begin):
            raise NativeNCAError("RomFS file extends beyond NCA section.")
        return name, sibling, self.file_data_off + begin, size

    def children_page(self, folder: str = "", cursor: str | None = None,
                      limit: int = PAGE_SIZE) -> dict:
        """Return one bounded page and an opaque continuation cursor, if any."""
        if folder not in self._directories:
            raise NativeNCAError("Unknown RomFS folder.")
        if not isinstance(limit, int) or not 1 <= limit <= self.MAX_PAGE_SIZE:
            raise NativeNCAError("Invalid RomFS page size.")
        if cursor is not None and (
            not isinstance(cursor, str) or cursor not in self._issued.get(folder, set())
        ):
            raise NativeNCAError("Invalid or expired RomFS directory cursor.")
        key = (folder, cursor or "")
        if key in self._page_cache:
            cached = self._page_cache[key]
            return {"entries": list(cached["entries"]),
                    "next_cursor": cached["next_cursor"]}

        _, _, first_dir, first_file = self._directory(self._directories[folder])
        if cursor is None:
            phase = "d" if first_dir != NONE else "f"
            offset = first_dir if phase == "d" else first_file
        else:
            phase, encoded = cursor.split(":", 1)
            if phase not in ("d", "f") or len(encoded) != 8:
                raise NativeNCAError("Invalid RomFS page cursor.")
            try:
                offset = int(encoded, 16)
            except ValueError as error:
                raise NativeNCAError("Invalid RomFS page cursor.") from error

        seen = self._seen.setdefault(folder, {"d": set(), "f": set()})
        listing = []
        while len(listing) < limit:
            if phase == "d" and offset == NONE:
                phase, offset = "f", first_file
            if offset == NONE:
                break
            if offset in seen[phase]:
                raise NativeNCAError("RomFS directory contains a cycle in its entry pointers.")
            if len(seen["d"]) + len(seen["f"]) >= self.MAX_VISITED_ENTRIES:
                raise NativeNCAError("RomFS folder has an unsupported number of entries.")
            seen[phase].add(offset)
            if phase == "d":
                name, sibling, _, _ = self._directory(offset)
                if not name:
                    raise NativeNCAError("Unexpected unnamed nested RomFS directory.")
                child_path = (folder + "/" + name).strip("/")
                if child_path in self._directories:
                    raise NativeNCAError("RomFS directory contains duplicate entries.")
                self._directories[child_path] = offset
                listing.append({"name": name, "path": child_path,
                                "type": "directory", "size": 0})
            else:
                name, sibling, begin, size = self._file(offset)
                child_path = (folder + "/" + name).strip("/")
                if child_path in self._files:
                    raise NativeNCAError("RomFS folder contains duplicate filenames.")
                self._files[child_path] = FileInfo(name, child_path, begin, size)
                listing.append({"name": name, "path": child_path,
                                "type": "file", "size": size})
            offset = sibling

        if phase == "d" and offset == NONE:
            phase, offset = "f", first_file
        next_cursor = f"{phase}:{offset:08x}" if offset != NONE else None
        if next_cursor:
            self._issued.setdefault(folder, set()).add(next_cursor)
        response = {"entries": listing, "next_cursor": next_cursor}
        self._page_cache[key] = response
        return {"entries": list(listing), "next_cursor": next_cursor}

    def children(self, folder: str = "") -> list[dict]:
        """Compatibility API: return first page; use children_page to continue."""
        return self.children_page(folder)["entries"]

    def file(self, name: str) -> FileInfo:
        if name not in self._files:
            parent = name.rpartition("/")[0]
            cursor = None
            while True:
                page = self.children_page(parent, cursor)
                if name in self._files:
                    break
                cursor = page["next_cursor"]
                if cursor is None:
                    break
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
