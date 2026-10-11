"""Install or locate the external Pokémon Switch Blender importer.

Downloads only from the upstream GitHub repository. Never bundles game assets.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

UPSTREAM = "ChicoEevee/Pokemon-Switch-Model-Importer-Blender"
ARCHIVE_URL = "https://github.com/" + UPSTREAM + "/archive/refs/heads/main.zip"
LIMIT = 32 * 1024 * 1024


def managed_addon() -> Path:
    base = Path(os.getenv("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
    return base / "GFPAK-OPEN" / "addons" / "Pokemon-Switch-Model-Importer-Blender"


def is_addon(path: str | Path | None) -> bool:
    if not path:
        return False
    folder = Path(path).expanduser()
    return all((folder / file).is_file() for file in
               ("__init__.py", "gfbmdl_import.py", "gfbanm_importer.py"))


def find_addon(preferred: str | Path | None = None) -> str:
    candidates = [preferred, os.environ.get("GFPAK_BLENDER_ADDON"), managed_addon()]
    home = Path.home()
    candidates.extend([
        home / "Downloads" / "Pokemon-Switch-Model-Importer-Blender-main",
        home / "Downloads" / "Pokemon-Switch-Model-Importer-Blender",
        home / "Documents" / "Pokemon-Switch-Model-Importer-Blender",
    ])
    for candidate in candidates:
        if is_addon(candidate):
            return str(Path(candidate).resolve())
    return ""


def ensure_addon(preferred: str | Path | None = None) -> str:
    existing = find_addon(preferred)
    if existing:
        return existing
    target = managed_addon()
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "GFPAK-OPEN"})
    with tempfile.TemporaryDirectory(prefix="gfpak-addon-") as tmp:
        archive_file = Path(tmp) / "addon.zip"
        with urllib.request.urlopen(request, timeout=35) as response, archive_file.open("wb") as out:
            total = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                total += len(chunk)
                if total > LIMIT:
                    raise ValueError("Add-on download exceeds the maximum safe size")
                out.write(chunk)
        staging = Path(tmp) / "package"
        staging.mkdir()
        with zipfile.ZipFile(archive_file) as archive:
            entries = archive.infolist()
            if len(entries) > 4000 or sum(i.file_size for i in entries) > LIMIT * 6:
                raise ValueError("Add-on archive contains too much data")
            for item in entries:
                parts = Path(item.filename).parts
                if not parts or any(part in ("..", "") for part in parts):
                    raise ValueError("Unsafe path in Blender add-on archive")
                if item.is_dir():
                    continue
                if len(parts) < 2:
                    continue
                name = Path(*parts[1:])
                if name.is_absolute() or ":" in str(name) or "\\" in str(name):
                    raise ValueError("Unsafe resource name in Blender add-on")
                destination = staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        if not is_addon(staging):
            raise ValueError("Downloaded archive is not a compatible Pokémon Switch Blender importer")
        if target.exists():
            raise ValueError("An incomplete managed add-on exists; remove it before reinstalling")
        shutil.copytree(staging, target)
    return str(target)
