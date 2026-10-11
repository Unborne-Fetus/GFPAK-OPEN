"""Native desktop bridge: single-window conversion, temporary preview, asset browser.

All generated GLBs are held in an app-owned session directory and deleted on
next conversion or shutdown. The user's original archives remain untouched.
Permanent GLB output is a separate, explicit Save action.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path

from .addon_manager import find_addon, ensure_addon
from .asset_browser import AssetBrowser
from .blender_detection import find_blender, can_launch_blender
from .converter import ConversionOptions, convert_model, validate_glb


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
        self.sources: list[Path] = []
        self._session = tempfile.TemporaryDirectory(prefix="GFPAK-OPEN-session-")
        self._cache = Path(self._session.name)
        self.export_paths: dict[str, Path] = {}
        self.job = {"running": False, "messages": [], "completed": [], "error": ""}
        self._worker: threading.Thread | None = None
        self._closing = False
        self.setup = {"state": "checking", "error": ""}
        self._setup_started = False
        self._checked_blender: str | None = None
        self._browser = AssetBrowser(nca_workspace=self._cache / 'nca' / uuid.uuid4().hex)
        self._configure_nca_browser()
        self._scan_job = {"running": False, "error": "", "result": None}
        self._nsp_job = {"running": False, "kind": "", "done": 0, "total": 0, "result": None, "error": ""}
        self._nsp_cancel = threading.Event()

    def close(self):
        """Best-effort shutdown; only delete files the app owns in its temp cache."""
        with self._lock:
            self._closing = True
            worker = self._worker
        if worker and worker.is_alive():
            worker.join(timeout=3)
        try:
            self._session.cleanup()
        except OSError:
            # On Windows an in-flight Blender process may still hold a file.
            pass

    def _save(self):
        path = settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.settings, indent=2), encoding="utf-8")

    def _configure_nca_browser(self):
        # Native parser is built in; only an optional user-supplied keyset
        # is consulted. No keys are bundled or exposed to the web interface.
        self._browser.configure_nca_reader(self.settings.get("nca_keyset") or "")

    def browse_nca_settings(self):
        with self._lock:
            keyset = self._browser._nca_sections.keyset
            return {
                "reader": "Built-in NCA3 / RomFS / ExeFS",
                "keyset": keyset.name if keyset and keyset.is_file() else "",
                "ready": True,
                "has_keys": self._browser._nca_sections.key_ready(),
                "note": ("No external NCA reader executable required. "
                         "Plaintext sections open immediately. Encrypted NCAs "
                         "need an existing compatible user-supplied keys file; "
                         "keys are not bundled or downloaded.")
            }

    def browse_nca_select(self, option: str):
        if option != "keyset":
            raise ValueError("The NCA reader is built in; no executable is needed.")
        selected = self._dialog("open", "Select existing local keys file",
                                ("Keys files (*.keys;*.txt)", "All files (*.*)"))
        if not selected:
            return self.browse_nca_settings()
        keyfile = Path(selected[0])
        if not keyfile.is_file():
            raise ValueError("Selected local keys file does not exist")
        with self._lock:
            self.settings["nca_keyset"] = str(keyfile)
            self._save()
            self._configure_nca_browser()
        return self.browse_nca_settings()

    def _get_blender(self):
        blender = self.settings.get("blender", "")
        if blender and blender == self._checked_blender:
            return blender
        if not can_launch_blender(blender):
            blender = find_blender()
            self.settings["blender"] = blender
            self._save()
        self._checked_blender = blender
        return blender

    def setup_status(self):
        with self._lock:
            if not self._setup_started:
                self._setup_started = True
                threading.Thread(target=self._install_addon, daemon=True).start()
            blender = self._get_blender()
            addon = find_addon(self.settings.get("addon"))
            if addon:
                self.settings["addon"] = addon
            return {"blender": blender, "addon": addon,
                    "setup": dict(self.setup), "sources": [str(x) for x in self.sources],
                    "settings": {name: self.settings.get(name, "")
                                 for name in ("hashes", "oodle", "textures")},
                    "animations": bool(self.settings.get("animations", True)),
                    "cache": "Temporary GLBs are removed on the next conversion or app exit"}

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
            selected = window.create_file_dialog(webview.FOLDER_DIALOG, allow_multiple=False)
        elif kind == "save":
            selected = window.create_file_dialog(webview.SAVE_DIALOG,
                                                 save_filename=title, file_types=tuple(file_types))
        else:
            selected = window.create_file_dialog(webview.OPEN_DIALOG,
                                                 allow_multiple=multiple,
                                                 file_types=tuple(file_types))
        if not selected:
            return []
        if isinstance(selected, str):
            return [selected]
        return list(selected)

    def select_sources(self, mode="files"):
        if mode == "folder":
            paths = self._dialog("folder", "Select decoded model folder")
        else:
            paths = self._dialog("open", "Choose model sources",
                                 ("Native models (*.gfpak;*.trmdl;*.gfbmdl;*.glb)",
                                  "All files (*.*)"), multiple=True)
        if paths:
            self.sources = [Path(p) for p in paths]
        return [str(p) for p in self.sources]

    def select_option(self, option):
        if option not in ("blender", "addon", "hashes", "oodle", "textures"):
            raise ValueError("Invalid converter setting")
        if option in ("addon", "textures"):
            paths = self._dialog("folder", "Choose directory")
        else:
            paths = self._dialog("open", "Choose file", ("All files (*.*)",))
        if paths:
            self.settings[option] = paths[0]
            if option == "blender":
                self._checked_blender = None
            self._save()
        return self.settings.get(option, "")

    def set_options(self, values):
        for key in ("blender", "addon", "hashes", "oodle", "textures"):
            if key in values:
                self.settings[key] = str(values[key])[:4096]
                if key == "blender":
                    self._checked_blender = None
        if "animations" in values:
            self.settings["animations"] = bool(values["animations"])
        self._save()
        return True

    def _clear_cached_models(self):
        self.export_paths.clear()
        for child in self._cache.glob("*.glb"):
            try:
                child.unlink()
            except OSError:
                pass

    def _begin_conversion(self, sources: list[Path]):
        if not sources:
            raise ValueError("Choose at least one model first")
        with self._lock:
            if self._closing:
                raise RuntimeError("The desktop studio is closing")
            if self.job["running"]:
                raise ValueError("A preview is already being prepared")
            if any(p.suffix.lower() != ".glb" for p in sources if p.is_file()) or any(p.is_dir() for p in sources):
                blender = self._get_blender()
                addon = find_addon(self.settings.get("addon"))
                if not blender:
                    raise ValueError(
                        "Blender is not launchable. Install Blender or select its executable "
                        "under Converter → Advanced settings."
                    )
                if not addon:
                    raise ValueError("The Pokémon Switch Blender importer is not ready yet")
            else:
                blender = ""
                addon = ""
            options = dict(self.settings)
            self._clear_cached_models()
            self.job = {"running": True,
                        "messages": ["Preparing temporary preview. Nothing will be saved permanently."],
                        "completed": [], "error": ""}
        def work():
            for source in sources:
                output = self._cache / (uuid.uuid4().hex + ".glb")
                try:
                    def log(message):
                        with self._lock:
                            self.job["messages"].append(str(message))
                    def opt(key):
                        return Path(options[key]) if options.get(key) else None
                    if source.is_file() and source.suffix.lower() == ".glb":
                        validate_glb(source)
                        shutil.copy2(source, output)
                        log("Loaded original GLB without conversion")
                    else:
                        convert_model(ConversionOptions(
                            source=source, output=output,
                            blender=Path(blender), addon=Path(addon),
                            dictionary=opt("hashes"), oodle=opt("oodle"),
                            texture_folder=opt("textures"),
                            animations=bool(options.get("animations", True))
                        ), progress=log)
                    token = uuid.uuid4().hex
                    with self._lock:
                        self.export_paths[token] = output
                        self.job["completed"].append({
                            "name": source.stem + ".glb",
                            "url": "/__native_output/" + token,
                            "key": token, "temporary": True
                        })
                        self.job["messages"].append("Ready to preview: " + source.name)
                except Exception as exc:
                    with self._lock:
                        self.job["messages"].append("Failed " + source.name + ": " + str(exc))
                        self.job["error"] += source.name + ": " + str(exc) + "\n"
            with self._lock:
                self.job["running"] = False
        self._worker = threading.Thread(target=work, daemon=True)
        self._worker.start()
        return True

    def start_conversion(self):
        return self._begin_conversion(list(self.sources))

    def preview_browser_item(self, node_id: str):
        source = self._browser.preview_source(node_id)
        return self._begin_conversion([source])

    def conversion_status(self):
        with self._lock:
            return dict(self.job, messages=list(self.job["messages"]),
                        completed=list(self.job["completed"]))

    def output_file(self, key):
        with self._lock:
            return self.export_paths.get(key)

    def save_cached_model(self, key: str):
        """Save permanently only after the user explicitly selects a location."""
        with self._lock:
            output = self.export_paths.get(key)
            if not output or not output.is_file():
                raise ValueError("Preview expired. Reload the model before saving.")
            label = next((item["name"] for item in self.job["completed"]
                          if item["key"] == key), "converted-model.glb")
        choice = self._dialog("save", label, ("GLB models (*.glb)",))
        if not choice:
            return False
        dest = Path(choice[0])
        if dest.suffix.lower() != ".glb":
            dest = dest.with_suffix(".glb")
        if dest.exists():
            raise ValueError("File already exists. Choose a different name to preserve it.")
        shutil.copy2(output, dest)
        return str(dest)

    def browse_choose(self, mode="folder"):
        if mode not in {"folder", "file"}:
            raise ValueError("Unknown browser source mode")
        paths = (self._dialog("folder", "Choose an extracted game directory") if mode == "folder"
                 else self._dialog("open", "Choose a package or archive",
                                   ("Game packages (*.nsp;*.gfpak;*.zip;*.xci)",
                                    "All files (*.*)")))
        if not paths:
            return None
        with self._lock:
            self._browser = AssetBrowser(nca_workspace=self._cache / 'nca' / uuid.uuid4().hex)
            self._configure_nca_browser()
            self._scan_job = {"running": False, "error": "", "result": None}
            root = self._browser.open(paths[0])
            return {"root": root, "directory": str(self._browser.root_path),
                    "children": self._browser.children(root["id"])}

    def browse_attach_extracted_nca(self, node_id: str):
        """Associate an existing extracted folder with the selected NCA."""
        with self._lock:
            browser = self._browser
            node = browser.node(node_id)
            if node["kind"] != "nspfile" or not node["name"].lower().endswith(".nca"):
                raise ValueError("Select a Program or other NCA entry in the tree first")
        folders = self._dialog("folder", "Choose existing extracted NCA section files")
        if not folders:
            return None
        with self._lock:
            if browser is not self._browser:
                raise ValueError("The opened NSP has changed")
            linked = browser.attach_extracted_nca(node_id, folders[0])
            return {"parent": browser._public(node), "linked": linked,
                    "children": browser.children(node_id)}

    def browse_attach_extracted(self):
        """Link an existing extracted directory into the NSP's file tree."""
        with self._lock:
            if not self._browser.root_path or self._browser.root_path.suffix.lower() != ".nsp":
                raise ValueError("Open an NSP first, then link your extracted files")
            browser = self._browser
        folders = self._dialog("folder", "Choose an already extracted game folder")
        if not folders:
            return None
        with self._lock:
            if browser is not self._browser:
                raise ValueError("Opened package changed; try again")
            node = browser.attach_extracted(folders[0])
            root = browser.node(browser.root_id)
            return {"linked": node, "root": browser._public(root),
                    "children": browser.children(root["id"])}

    def browse_save_item(self, node_id: str):
        """Save exactly one selected file with an explicit native dialog."""
        with self._lock:
            browser = self._browser
            node = browser.node(node_id)
            if node["kind"] not in {"file", "zipfile", "gfpak_resource", "nspfile", "nca_file"}:
                raise ValueError("Select a file rather than a folder")
            name = node["name"].replace("\\", "/").rsplit("/", 1)[-1]
            if node["kind"] == "gfpak_resource":
                name = name.split(" · ", 1)[-1] or "resource.bin"
            # The name is a dialog suggestion only; untrusted names are never
            # used directly as output paths without an explicit user choice.
            name = "".join(ch for ch in name if ch not in '<>:"/\\|?*')[:160]
            if not name or name.startswith("."):
                name = "exported-resource.bin"
        selected = self._dialog("save", name, ("All files (*.*)",))
        if not selected:
            return False
        with self._lock:
            if browser is not self._browser:
                raise ValueError("Package changed; select the file again")
        return str(browser.export_item(node_id, Path(selected[0])))

    def browse_item_details(self, node_id: str):
        with self._lock:
            return self._browser.item_details(node_id)

    def browse_children(self, node_id: str):
        with self._lock:
            return self._browser.children(node_id)

    def browse_start_scan(self):
        with self._lock:
            if not self._browser.root_path or not self._browser.root_path.is_dir():
                raise ValueError("Open an extracted game folder to scan for assets")
            if self._scan_job["running"]:
                return False
            browser = self._browser
            self._scan_job = {"running": True, "error": "", "result": None}
        def run():
            try:
                result = browser.scan()
                with self._lock:
                    if browser is self._browser:
                        self._scan_job["result"] = result
            except Exception as exc:
                with self._lock:
                    if browser is self._browser:
                        self._scan_job["error"] = str(exc)
            finally:
                with self._lock:
                    if browser is self._browser:
                        self._scan_job["running"] = False
        threading.Thread(target=run, daemon=True).start()
        return True

    def browse_nsp_page(self, node_id: str, page: int = 0,
                        query: str = "", category: str = "all"):
        with self._lock:
            return self._browser.nsp_page(node_id, page, query, category)

    def browse_nsp_summary(self, node_id: str):
        with self._lock:
            node = self._browser.node(node_id)
            if node["kind"] != "nsp":
                raise ValueError("Open an NSP file before viewing package analysis")
            return self._browser.nsp_reader(Path(node["path"])).summary()

    def browse_nsp_inspect(self, node_id: str, offset: int = 0, length: int = 256):
        with self._lock:
            return self._browser.nsp_inspect(node_id, offset=int(offset), length=int(length))

    def browse_nsp_manifest(self, node_id: str):
        with self._lock:
            node = self._browser.node(node_id)
            if node["kind"] != "nsp":
                raise ValueError("Select the NSP package first")
            analyzer = self._browser.nsp_reader(Path(node["path"]))
        selected = self._dialog("save", analyzer.path.stem + "-inventory.json",
                                ("JSON files (*.json)",))
        if not selected:
            return False
        output = Path(selected[0])
        if output.suffix.lower() != ".json":
            output = output.with_suffix(".json")
        return str(analyzer.write_manifest(output))

    def browse_nsp_start_task(self, operation: str, node_id: str):
        """Hash, audit or raw-export a selected PFS0 entry in a worker thread."""
        if operation not in {"hash", "extract", "audit"}:
            raise ValueError("Unsupported NSP operation")
        with self._lock:
            if self._nsp_job["running"]:
                raise ValueError("Another package operation is running")
            if operation == "audit":
                node = self._browser.node(node_id)
                if node["kind"] != "nsp":
                    raise ValueError("Select an NSP package to audit")
                analyzer = self._browser.nsp_reader(Path(node["path"]))
                index = None
                label = analyzer.path.name
                total = sum(row.size for row in analyzer.entries)
            else:
                analyzer, index = self._browser.nsp_entry(node_id)
                label = analyzer.get(index).name
                total = analyzer.get(index).size
            origin = self._browser
        target = None
        if operation == "extract":
            # User picks an explicit path. An NSP filename is never trusted as an
            # extraction destination, and an existing file cannot be overwritten.
            safe_name = Path(label.replace("\\", "/")).name or "nsp-resource.bin"
            chosen = self._dialog("save", safe_name, ("All files (*.*)",))
            if not chosen:
                return False
            target = Path(chosen[0])
            if target.is_file():
                raise ValueError("Destination already exists; choose another filename")
        with self._lock:
            if origin is not self._browser:
                raise ValueError("Explorer changed; select the file again")
            self._nsp_cancel.clear()
            self._nsp_job = {"running": True, "kind": operation,
                             "name": label, "done": 0, "total": total,
                             "result": None, "error": ""}
        def progress(done, ignored_total):
            if self._nsp_cancel.is_set():
                raise RuntimeError("Operation cancelled")
            with self._lock:
                self._nsp_job["done"] = min(self._nsp_job["total"], done)

        def job():
            try:
                if operation == "hash":
                    result = analyzer.sha256(index, progress=progress)
                elif operation == "extract":
                    saved = analyzer.export_raw(index, target, progress=progress)
                    result = {"file": saved.name, "saved": str(saved),
                              "message": "Raw package file saved unchanged. Encrypted NCA data is not decrypted."}
                else:
                    files = len(analyzer.entries)
                    warnings = []
                    hashed_bytes = 0
                    mismatches = 0
                    for count, entry in enumerate(analyzer.entries, 1):
                        if self._nsp_cancel.is_set():
                            raise RuntimeError("Operation cancelled")
                        # Convert per-entry progress into a package-wide progress bar.
                        def progress_all(done, ignored_total):
                            progress(hashed_bytes + done, total)
                        digest = analyzer.sha256(entry.index, progress=progress_all)
                        hashed_bytes += entry.size
                        if digest["content_id_comparison"] == "differs":
                            mismatches += 1
                            if len(warnings) < 40:
                                warnings.append(entry.name)
                    result = {"files_checked": files, "bytes_hashed": hashed_bytes,
                              "content_id_differences": mismatches,
                              "sample_differences": warnings,
                              "warning": "Content-ID comparisons are advisory; a difference is not always corruption."}
                with self._lock:
                    self._nsp_job["result"] = result
                    self._nsp_job["done"] = total
            except Exception as exc:
                with self._lock:
                    self._nsp_job["error"] = str(exc)
            finally:
                with self._lock:
                    self._nsp_job["running"] = False
        threading.Thread(target=job, daemon=True).start()
        return True

    def browse_nsp_cancel_task(self):
        with self._lock:
            if not self._nsp_job["running"]:
                return False
            self._nsp_cancel.set()
        return True

    def browse_nsp_task_status(self):
        with self._lock:
            return dict(self._nsp_job)

    def browse_scan_status(self):
        with self._lock:
            return dict(self._scan_job)
