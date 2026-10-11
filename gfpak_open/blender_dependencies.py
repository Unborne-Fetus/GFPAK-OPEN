"""Prepare pure-Python dependencies for Blender's separate embedded Python.

Blender 4.2+ commonly disables in-app network installs. Installing the upstream
importer's dependencies with the host app instead, then passing their local
folder to Blender, avoids altering Blender's preferences or global environment.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

# All of these install as Python packages. The native executable remains Blender's.
REQUIREMENTS = ("flatbuffers==25.2.10", "requests==2.32.5")
REQUIRED_PACKAGES = ("flatbuffers", "requests", "urllib3", "idna", "certifi",
                     "charset_normalizer")


def has_dependencies(directory: str | Path) -> bool:
    root = Path(directory)
    return all((root / name / "__init__.py").is_file() for name in REQUIRED_PACKAGES)


def dependency_cache() -> Path:
    appdata = os.environ.get("LOCALAPPDATA")
    base = Path(appdata) if appdata else Path.home() / ".local" / "share"
    return base / "GFPAK-OPEN" / "blender-python-deps-v1"


def packaged_dependencies() -> Path | None:
    if not getattr(sys, "_MEIPASS", None):
        return None
    folder = Path(sys._MEIPASS) / "blender_deps"
    return folder if has_dependencies(folder) else None


def ensure_blender_dependencies(progress: Callable[[str], None] | None = None) -> Path:
    """Get a real on-disk package tree importable by Blender 5.x, installing once.

    No pip/network calls execute within Blender. Packaged builds carry a copy
    prepared in CI; local source checkouts install into a dedicated app folder.
    """
    bundled = packaged_dependencies()
    if bundled is not None:
        return bundled
    folder = dependency_cache()
    if has_dependencies(folder):
        return folder
    if getattr(sys, "frozen", False):
        raise RuntimeError(
            "Blender Python dependencies were missing from the packaged GFPAK-OPEN build. "
            "Install a newer Windows release; Blender network settings are not the issue."
        )
    if progress:
        progress("Preparing Blender's FlatBuffers and requests packages outside Blender (one-time setup)…")
    folder.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gfpak-blender-deps-", dir=str(folder.parent)) as temp:
        staged = Path(temp) / "packages"
        command = [
            sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
            "--no-input", "--only-binary=:all:",
            "--platform", "any", "--implementation", "py",
            "--python-version", "3.11", "--abi", "none",
            "--target", str(staged),
            *REQUIREMENTS,
        ]
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, errors="replace",
                timeout=180, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(
                "Could not prepare the Blender Python modules outside Blender. "
                f"Ensure that your Python has pip and internet access: {exc}"
            ) from exc
        if completed.returncode or not has_dependencies(staged):
            output = (completed.stdout + "\n" + completed.stderr)[-1600:]
            raise RuntimeError(
                "Blender requires FlatBuffers, but GFPAK-OPEN could not install "
                "its pure-Python dependencies into the app's local cache. "
                "Check your network connection and pip.\n" + output
            )
        if folder.exists():
            # A previous incomplete install is app-owned, so it is safe to replace.
            shutil.rmtree(folder)
        staged.rename(folder)
    if progress:
        progress("Blender Python dependencies ready; no Blender network permissions needed.")
    return folder
