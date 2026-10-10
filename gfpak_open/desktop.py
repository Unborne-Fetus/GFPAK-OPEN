"""Offline desktop host for the full web studio, with access to the classic Blender tools."""
from __future__ import annotations

import functools
import http.server
import os
import subprocess
import sys
import threading
from pathlib import Path


def _assets() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "web_dist"
    return Path(__file__).resolve().parent.parent / "dist-desktop"


class _Server(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format, *args):
        pass


class DesktopAPI:
    def open_converter(self):
        """Launch existing converter without blocking the 3D viewer."""
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--classic"]
        else:
            cmd = [sys.executable, str(Path(__file__).resolve().parent.parent / "launch.py"), "--classic"]
        subprocess.Popen(cmd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return True

    def find_blender(self):
        from .blender_detection import find_blender
        return find_blender()


def main():
    assets = _assets()
    if not (assets / "index.html").is_file():
        raise RuntimeError("Web studio assets missing. Run npm install and npm run build first.")
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("pywebview is required for the Windows studio: pip install pywebview") from exc
    factory = functools.partial(_Server, directory=str(assets))
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), factory) as server:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/"
        webview.create_window("GFPAK Open — Model Studio", url,
                              js_api=DesktopAPI(), width=1380, height=900, min_size=(1000, 680))
        try:
            webview.start(gui="edgechromium")
        finally:
            server.shutdown()
