"""Locate Blender on Windows, including Microsoft Store installations."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path


def _version(path: Path) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", str(path.parent.name))
    return tuple(int(n) for n in numbers[:4])


def find_blender() -> str:
    """Return the best installed Blender executable, or an empty string."""
    candidates: list[Path] = []

    def add(path):
        if path:
            candidates.append(Path(path).expanduser())

    if os.name == "nt":
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                for key in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\blender.exe",
                            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\blender.exe"):
                    try:
                        with winreg.OpenKey(hive, key) as handle:
                            add(winreg.QueryValueEx(handle, "")[0])
                    except OSError:
                        pass
        except ImportError:
            pass

        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = Path(os.environ.get(env, ""))
            if not root.is_dir():
                continue
            foundation = root / "Blender Foundation"
            if foundation.is_dir():
                candidates.extend(foundation.glob("Blender */blender.exe"))
            candidates.extend((root / "Programs" / "Blender Foundation").glob("Blender */blender.exe"))
            if env == "LOCALAPPDATA":
                add(root / "Microsoft" / "WindowsApps" / "blender.exe")
                # Microsoft Store MSIX installations may have no App Execution Alias.
                store = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "WindowsApps"
                try:
                    candidates.extend(store.glob("BlenderFoundation.Blender_*/blender.exe"))
                    candidates.extend(store.glob("BlenderFoundation.Blender_*/Blender/blender.exe"))
                except OSError:
                    pass

        # Store package install path via Windows PowerShell package registration.
        try:
            command = [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "Get-AppxPackage '*Blender*' | Select-Object -ExpandProperty InstallLocation"
            ]
            output = subprocess.run(command, capture_output=True, text=True,
                                    timeout=8, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for line in output.stdout.splitlines():
                location = Path(line.strip())
                add(location / "blender.exe")
                add(location / "Blender" / "blender.exe")
        except (OSError, subprocess.TimeoutExpired):
            pass

    add(shutil.which("blender"))
    # Prefer real executables over app execution aliases; newest version first.
    existing = [p for p in candidates if p.is_file()]
    existing.sort(key=lambda p: ("windowsapps" not in str(p).lower() or
                                 "blenderfoundation.blender_" in str(p).lower(),
                                 _version(p)), reverse=True)
    return str(existing[0]) if existing else ""
