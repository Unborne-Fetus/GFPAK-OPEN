"""Optional local NCA section browser for the integrated Switch package tree.

The NSP index itself is readable without a tool. For encrypted NCA section
filesystems, use an independently installed compatible hactool/hactoolnet
executable and a user-selected local keyset. No keys or external tools are
downloaded, embedded, discovered from private locations or exported.

All extracted data lives in a temporary session folder and is deleted on app
exit. Work is lazy: opening an NCA stages just that one file, and opening an
individual section extracts only that section. Source files are read-only.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

from .nsp_explorer import NSPAnalyzer

SECTION_RE = re.compile(r"^\s*(?:section|partition)\s*([0-3])\s*:", re.IGNORECASE | re.MULTILINE)
MAX_LOG = 128_000
COPY_CHUNK = 2 * 1024 * 1024


def find_local_nca_reader() -> str:
    """Only trust an explicitly available executable on PATH."""
    for name in ("hactoolnet.exe", "hactool.exe", "hactoolnet", "hactool"):
        match = shutil.which(name)
        if match:
            return str(Path(match).resolve())
    return ""


def _validate_inputs(tool: str | Path, keyset: str | Path):
    if not tool or not Path(tool).is_file():
        raise ValueError(
            "No local NCA reader selected. Select an installed hactool or "
            "hactoolnet executable in the NSP browser."
        )
    if not keyset or not Path(keyset).is_file():
        raise ValueError(
            "NCA section access requires a locally available keyset. "
            "Select your own keyset file; GFPAK-OPEN does not provide or download keys."
        )


def _run_reader(tool: Path, keyset: Path, arguments: list[str], timeout: int) -> str:
    # No shell, no text fields from the archive interpolated into commands, and
    # no raw diagnostic output exposed: tools can inadvertently print key data.
    command = [str(tool), "-k", str(keyset), "-t", "nca",
               "--suppresskeys", *arguments]
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("The local NCA reader timed out.") from exc
    except OSError as exc:
        raise RuntimeError("Unable to launch the selected NCA reader.") from exc
    output = (result.stdout + b"\n" + result.stderr)[:MAX_LOG].decode(
        "utf-8", errors="replace"
    )
    if result.returncode:
        # Do not include raw subprocess output, which may contain key material.
        raise RuntimeError(
            "The NCA reader could not open this content archive. Check that "
            "the reader supports the game and your local keys are compatible."
        )
    return output


class LocalNCASections:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.tool: Path | None = None
        self.keyset: Path | None = None
        self._entries: dict[tuple[str, int], dict] = {}

    def configure(self, tool: str | Path = "", keyset: str | Path = ""):
        # A changed reader/keyset must not reuse results from another keyset.
        self.tool = Path(tool) if tool else None
        self.keyset = Path(keyset) if keyset else None
        self._entries.clear()

    def available(self) -> bool:
        return bool(self.tool and self.keyset and
                    self.tool.is_file() and self.keyset.is_file())

    def _entry_key(self, analyzer: NSPAnalyzer, index: int) -> tuple[str, int]:
        return (str(analyzer.path.resolve()), index)

    def _stage(self, analyzer: NSPAnalyzer, index: int) -> dict:
        _validate_inputs(self.tool, self.keyset)
        entry = analyzer.get(index)
        if not entry.name.lower().endswith(".nca"):
            raise ValueError("Only NCA archive entries contain Switch filesystem sections")
        key = self._entry_key(analyzer, index)
        current = self._entries.get(key)
        if current and current["path"].is_file():
            return current
        # A local NCA can be multiple GiB. Do not attempt it when disk space is
        # clearly inadequate, and do not accidentally overwrite any previous file.
        if shutil.disk_usage(self.workspace).free < entry.size + 128 * 1024 * 1024:
            raise RuntimeError(
                "Not enough free temporary disk space to index this NCA. "
                "Use a locally extracted folder instead."
            )
        target = self.workspace / (uuid.uuid4().hex + ".nca")
        try:
            analyzer.export_raw(index, target)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        current = {"path": target, "sections": None, "extracted": {}}
        self._entries[key] = current
        return current

    def sections(self, analyzer: NSPAnalyzer, index: int) -> list[int]:
        state = self._stage(analyzer, index)
        if state["sections"] is None:
            output = _run_reader(
                self.tool, self.keyset,
                ["-i", str(state["path"])], timeout=150,
            )
            sections = sorted({int(match) for match in SECTION_RE.findall(output)})
            if not sections:
                raise RuntimeError(
                    "The local NCA reader did not report any accessible sections. "
                    "The NCA might need different keys or a newer reader."
                )
            state["sections"] = sections
        return list(state["sections"])

    def extract_section(self, analyzer: NSPAnalyzer, index: int,
                        section: int) -> Path:
        if section not in range(4):
            raise ValueError("Invalid NCA section number")
        state = self._stage(analyzer, index)
        if section not in self.sections(analyzer, index):
            raise ValueError("That section was not reported by the NCA reader")
        if section in state["extracted"]:
            return state["extracted"][section]
        output = state["path"].parent / (state["path"].stem + f"-section-{section}")
        output.mkdir(parents=True, exist_ok=False)
        try:
            _run_reader(self.tool, self.keyset, [
                "--section" + str(section) + "dir", str(output),
                str(state["path"]),
            ], timeout=1500)
            # If the reader didn't provide files, don't claim there are any.
            if not any(output.iterdir()):
                raise RuntimeError(
                    "NCA reader returned no files for this section. "
                    "It may be unsupported, inaccessible or empty."
                )
            state["extracted"][section] = output
        except Exception:
            shutil.rmtree(output, ignore_errors=True)
            raise
        return output
