"""Offline desktop host for the full web studio, with access to the classic Blender tools."""
from __future__ import annotations

import functools
import mimetypes
import re
import http.server
import os
import subprocess
import sys
import threading
from pathlib import Path


def _prepare_assets() -> Path:
    """Build browser assets on first source checkout run, without touching packaged builds."""
    assets = _assets()
    root = Path(__file__).resolve().parent.parent
    if (assets / "index.html").is_file():
        if getattr(sys, "frozen", False):
            return assets
        built = (assets / "index.html").stat().st_mtime
        sources = [root / "vite.config.js", root / "package.json"]
        sources.extend((root / "web").rglob("*"))
        if not any(p.is_file() and p.stat().st_mtime > built for p in sources):
            return assets
    if getattr(sys, "frozen", False):
        raise RuntimeError("The packaged desktop application is missing its bundled viewer files.")
    root = Path(__file__).resolve().parent.parent
    npm = "npm.cmd" if os.name == "nt" else "npm"
    if not (root / "package.json").is_file():
        raise RuntimeError("Cannot locate the web studio project files.")
    print("Preparing the GFPAK Open desktop viewer for the first launch...", flush=True)
    env = os.environ.copy()
    env["GFPAK_DESKTOP"] = "1"
    try:
        if not (root / "node_modules" / "vite").exists():
            print("Installing the web viewer dependencies...", flush=True)
            subprocess.run([npm, "install", "--no-audit", "--no-fund"], cwd=root,
                           env=env, check=True)
        print("Building the offline desktop viewer...", flush=True)
        subprocess.run([npm, "run", "build"], cwd=root, env=env, check=True)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Node.js/npm is required for the first desktop launch. "
            "Install Node.js LTS, then open run.bat again."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "The automatic desktop viewer build failed. Review the npm errors above."
        ) from exc
    if not (assets / "index.html").is_file():
        raise RuntimeError("The web viewer build finished without creating dist-desktop/index.html.")
    return assets


def _assets() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "web_dist"
    return Path(__file__).resolve().parent.parent / "dist-desktop"


from .desktop_backend import DesktopAPI

class _Server(http.server.SimpleHTTPRequestHandler):
    api = None

    def do_GET(self):
        match = re.fullmatch(r"/__native_output/([0-9a-f]{32})", self.path)
        if match:
            path = self.api.output_file(match.group(1)) if self.api else None
            if not path or not path.is_file():
                self.send_error(404, "Converted model not found")
                return
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with path.open("rb") as source:
                import shutil
                shutil.copyfileobj(source, self.wfile)
            return
        super().do_GET()

    def log_message(self, format, *args):
        pass


def main():
    assets = _prepare_assets()
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("pywebview is required for the Windows studio: pip install pywebview") from exc
    api = DesktopAPI()
    _Server.api = api
    factory = functools.partial(_Server, directory=str(assets))
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), factory) as server:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/"
        webview.create_window("GFPAK Open — Model Studio", url,
                              js_api=api, width=1380, height=900, min_size=(1000, 680))
        try:
            webview.start(gui="edgechromium")
        finally:
            server.shutdown()
