"""Desktop-only native Blender conversion bridge used by the unified web studio."""
from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path

from .addon_manager import find_addon, ensure_addon
from .blender_detection import find_blender
from .converter import ConversionOptions, convert_model

def settings_path():
    root = Path(os.getenv("APPDATA") or Path.home() / ".config")
    return root / "GFPAK-OPEN" / "settings.json"


class DesktopAPI:
    def __init__(self):
        self._lock = threading.RLock()
        try:
            self.settings = json.loads(settings_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.settings = {}
        self.sources = []
        self.export_paths = {}
        self.job = {"running": False, "messages": [], "completed": [], "error": ""}
        self.setup = {"state": "checking", "error": ""}
        self._setup_started = False

    def _save(self):
        path = settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.settings, indent=2), encoding="utf-8")

    def setup_status(self):
        with self._lock:
            if not self._setup_started:
                self._setup_started = True
                threading.Thread(target=self._install_addon, daemon=True).start()
            blender = self.settings.get("blender")
            if not blender or not Path(blender).is_file():
                blender = find_blender()
                self.settings["blender"] = blender
            addon = find_addon(self.settings.get("addon"))
            if addon:
                self.settings["addon"] = addon
            return {"blender": blender, "addon": addon,
                    "setup": dict(self.setup), "sources": [str(x) for x in self.sources],
                    "settings": {name: self.settings.get(name, "")
                                 for name in ("hashes", "oodle", "textures")},
                    "animations": bool(self.settings.get("animations", False))}

    def _install_addon(self):
        try:
            addon = ensure_addon(self.settings.get("addon"))
            with self._lock:
                self.settings["addon"] = addon
                self.setup = {"state": "ready", "error": ""}
                self._save()
        except Exception as exc:
            with self._lock:
                self.setup = {"state": "failed", "error": str(exc)}

    def retry_addon(self):
        with self._lock:
            if self.setup["state"] == "checking":
                return False
            self.setup = {"state": "checking", "error": ""}
        threading.Thread(target=self._install_addon, daemon=True).start()
        return True

    def _dialog(self, kind, title, file_types=(), multiple=False):
        import webview
        window = webview.windows[0]
        if kind == "folder":
            selected = window.create_file_dialog(webview.FOLDER_DIALOG, directory="", allow_multiple=False)
        elif kind == "save":
            selected = window.create_file_dialog(webview.SAVE_DIALOG, save_filename=title,
                                                 file_types=tuple(file_types))
        else:
            selected = window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=multiple,
                                                 file_types=tuple(file_types))
        if not selected:
            return []
        if isinstance(selected, str):
            return [selected]
        return list(selected)

    def select_sources(self, mode="files"):
        if mode == "folder":
            paths = self._dialog("folder", "Choose model directory")
        else:
            paths = self._dialog("open", "Choose model archives",
                                 ("Models (*.gfpak;*.trmdl;*.gfbmdl)", "All files (*.*)"),
                                 multiple=True)
        if paths:
            self.sources = [Path(p) for p in paths]
        return [str(p) for p in self.sources]

    def select_option(self, option):
        if option not in ("blender", "addon", "hashes", "oodle", "textures"):
            raise ValueError("Invalid conversion option")
        if option in ("addon", "textures"):
            paths = self._dialog("folder", "Choose directory")
        else:
            paths = self._dialog("open", "Choose file", ("All files (*.*)",))
        if paths:
            self.settings[option] = paths[0]
            self._save()
        return self.settings.get(option, "")

    def set_options(self, values):
        for key in ("blender", "addon", "hashes", "oodle", "textures"):
            if key in values:
                self.settings[key] = str(values[key])[:4096]
        if "animations" in values:
            self.settings["animations"] = bool(values["animations"])
        self._save()
        return True

    def start_conversion(self):
        with self._lock:
            if self.job["running"]:
                raise ValueError("Another conversion is already running")
            if not self.sources:
                raise ValueError("Select model sources first")
            blender = self.settings.get("blender") or find_blender()
            addon = find_addon(self.settings.get("addon"))
            if not blender or not Path(blender).is_file():
                raise ValueError("Blender was not found. Install Blender or select its executable.")
            if not addon:
                raise ValueError("Blender importer is not installed yet. Wait for setup or retry.")
            sources = list(self.sources)
            settings = dict(self.settings)
        if len(sources) == 1:
            names = self._dialog("save", sources[0].stem + ".glb", ("GLB models (*.glb)",))
            if not names:
                return False
            outputs = [Path(names[0])]
            if outputs[0].suffix.lower() != ".glb":
                outputs[0] = outputs[0].with_suffix(".glb")
        else:
            dest = self._dialog("folder", "Choose batch export directory")
            if not dest:
                return False
            outputs = [Path(dest[0]) / (src.stem + ".glb") for src in sources]
        with self._lock:
            self.job = {"running": True, "messages": ["Starting Blender conversion…"],
                        "completed": [], "error": ""}
        def work():
            for src, output in zip(sources, outputs):
                try:
                    def progress(message):
                        with self._lock:
                            self.job["messages"].append(str(message))
                    def optional(name):
                        return Path(settings[name]) if settings.get(name) else None
                    convert_model(ConversionOptions(
                        source=src, output=output, blender=Path(blender), addon=Path(addon),
                        dictionary=optional("hashes"), oodle=optional("oodle"),
                        texture_folder=optional("textures"),
                        animations=bool(settings.get("animations", False))
                    ), progress=progress)
                    key = uuid.uuid4().hex
                    with self._lock:
                        self.export_paths[key] = output
                        self.job["completed"].append({
                            "name": output.name, "url": "/__native_output/" + key
                        })
                        self.job["messages"].append("Converted " + output.name)
                except Exception as exc:
                    with self._lock:
                        self.job["messages"].append("Failed " + src.name + ": " + str(exc))
                        self.job["error"] += src.name + ": " + str(exc) + "\n"
            with self._lock:
                self.job["running"] = False
        threading.Thread(target=work, daemon=True).start()
        return True

    def conversion_status(self):
        with self._lock:
            return dict(self.job, messages=list(self.job["messages"]),
                        completed=list(self.job["completed"]))

    def output_file(self, key):
        with self._lock:
            return self.export_paths.get(key)
