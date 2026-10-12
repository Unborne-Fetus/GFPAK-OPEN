"""Self-contained NSP NCA section navigation.

The integrated reader uses native Python plus bundled cryptography. There are
no subprocesses and no separately installed NCA utilities. NCA header/key
handling and RomFS/PFS0 traversal are performed directly against the NSP with
bounded random-access reads. User-provided keys are optional until an encrypted
section is selected; no key material is included with the program.
"""
from __future__ import annotations

from pathlib import Path

from .nca_native import Keyset, NativeNCA, NativeNCAError, copy_file, read_file
from .nsp_explorer import NSPAnalyzer

SECTION_RE = None  # Legacy external console-output parsing is no longer used.


class LocalNCASections:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.keyset: Path | None = None
        self._keys = Keyset(None)
        self._readers: dict[tuple, NativeNCA] = {}

    def configure(self, keyset: str | Path = ""):
        self.keyset = Path(keyset) if keyset else None
        self._keys = Keyset(self.keyset)
        self._readers.clear()

    def available(self) -> bool:
        """The native reader is always available, including for plaintext NCAs."""
        return True

    def key_ready(self) -> bool:
        return self._keys.has_header

    def _reader(self, analyzer: NSPAnalyzer, index: int) -> NativeNCA:
        entry = analyzer.get(index)
        source = analyzer.path.resolve()
        stat = source.stat()
        # An XCI may hold multiple HFS0 partitions, each with entry index 0.
        # Identifying an NCA only by (path, index) reuses the wrong NCA.
        # Include its absolute byte range and the source revision.
        identifier = (str(source), index, entry.offset, entry.size,
                      stat.st_size, stat.st_mtime_ns)
        if identifier not in self._readers:
            # Forget stale revisions of the same underlying file.
            stale = [key for key in self._readers
                     if key[0] == str(source) and
                     (key[4], key[5]) != (stat.st_size, stat.st_mtime_ns)]
            for key in stale:
                del self._readers[key]
            self._readers[identifier] = NativeNCA(analyzer, index, self._keys)
        return self._readers[identifier]

    def attach_base(self, analyzer: NSPAnalyzer, index: int,
                    base_analyzer: NSPAnalyzer, base_index: int) -> int:
        """Attach a selected original NCA to a compatible plaintext BKTR patch."""
        updated = self._reader(analyzer, index)
        original = self._reader(base_analyzer, base_index)
        return updated.attach_base(original)

    def sections(self, analyzer: NSPAnalyzer, index: int) -> list[int]:
        return sorted(self._reader(analyzer, index).sections)

    def section_info(self, analyzer: NSPAnalyzer, index: int, section: int) -> dict:
        reader = self._reader(analyzer, index)
        if section not in reader.sections:
            raise NativeNCAError("Selected NCA section does not exist")
        return reader.sections[section].compatibility()

    def filesystem(self, analyzer: NSPAnalyzer, index: int, section: int):
        nca = self._reader(analyzer, index)
        if section not in nca.sections:
            raise NativeNCAError("This section does not exist in the NCA.")
        return nca.sections[section].filesystem()

    def file_info(self, analyzer: NSPAnalyzer, index: int, section: int, name: str):
        return self.filesystem(analyzer, index, section).file(name)

    def preview_bytes(self, analyzer: NSPAnalyzer, index: int,
                      section: int, name: str, count: int = 512):
        fs = self.filesystem(analyzer, index, section)
        return read_file(fs, name, length=min(512, max(0, count)))

    def extract_one(self, analyzer: NSPAnalyzer, index: int, section: int,
                    name: str, target: Path):
        fs = self.filesystem(analyzer, index, section)
        return copy_file(fs, name, target)
