"""GFPAK Open Windows GUI — model conversion is the primary action."""
from __future__ import annotations

import json
import os
import shutil
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .converter import ConversionError, ConversionOptions, convert_model
from .core import GFPak, GFPakError


def find_blender() -> str:
    path = shutil.which("blender")
    if path:
        return path
    if os.name == "nt":
        root = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Blender Foundation"
        if root.exists():
            found = sorted(root.glob("Blender */blender.exe"))
            if found:
                return str(found[-1])
    return ""


def settings_file() -> Path:
    return Path(os.environ.get("APPDATA", Path.home() / ".config")) / "GFPAK-OPEN" / "settings.json"


class Studio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("GFPAK Open — 3D Model Converter")
        self.geometry("1180x780")
        self.minsize(900, 620)
        self.archive = None
        self.inputs = []
        self.busy = False
        try:
            settings = json.loads(settings_file().read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            settings = {}
        self.blender = tk.StringVar(value=settings.get("blender", find_blender()))
        self.addon = tk.StringVar(value=settings.get("addon", ""))
        self.hashes = tk.StringVar(value=settings.get("hashes", ""))
        self.oodle = tk.StringVar(value=settings.get("oodle", ""))
        self.textures = tk.StringVar(value=settings.get("textures", ""))
        self.animations = tk.BooleanVar(value=settings.get("animations", False))
        self.status = tk.StringVar(value="Choose a GFPAK archive or a decoded TRMDL folder.")
        self.progress = tk.IntVar(value=0)
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._close)

    def save_settings(self):
        try:
            file = settings_file()
            file.parent.mkdir(parents=True, exist_ok=True)
            state = {key: getattr(self, key).get()
                     for key in ("blender", "addon", "hashes", "oodle", "textures", "animations")}
            file.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _close(self):
        self.save_settings()
        self.destroy()

    def _build(self):
        title = ttk.Frame(self, padding=(18, 15, 18, 8))
        title.pack(fill="x")
        ttk.Label(title, text="GFPAK → 3D MODEL → GLB", font=("Segoe UI", 19, "bold")).pack(anchor="w")
        ttk.Label(title, text="Convert Pokémon Switch TRMDL models for Pokédex 3D Max. Files stay on your PC.").pack(anchor="w", pady=3)

        source = ttk.LabelFrame(self, text="1  Source Pokémon model", padding=10)
        source.pack(fill="x", padx=16, pady=5)
        choices = ttk.Frame(source)
        choices.pack(fill="x")
        ttk.Button(choices, text="Open .gfpak…", command=self.open_archive).pack(side="left", padx=(0, 8))
        ttk.Button(choices, text="Open .trmdl / .gfbmdl…", command=self.open_native).pack(side="left", padx=(0, 8))
        ttk.Button(choices, text="Open model folder…", command=self.open_folder).pack(side="left", padx=(0, 8))
        ttk.Button(choices, text="Batch .gfpak…", command=self.open_batch).pack(side="left")
        self.summary = ttk.Label(source, text="No model selected")
        self.summary.pack(fill="x", pady=(8, 0))

        config = ttk.LabelFrame(self, text="2  Converter settings (saved automatically)", padding=10)
        config.pack(fill="x", padx=16, pady=5)
        self._row(config, 0, "Blender executable", self.blender)
        self._row(config, 1, "Pokémon Switch Blender add-on", self.addon, directory=True)
        self._row(config, 2, "GFPAK filename dictionary", self.hashes)
        self._row(config, 3, "Oodle runtime DLL", self.oodle)
        self._row(config, 4, "PNG texture folder (optional)", self.textures, directory=True)
        ttk.Checkbutton(config, text="Import supported model animations", variable=self.animations).grid(row=5, column=1, sticky="w", pady=4)
        config.columnconfigure(1, weight=1)

        buttons = ttk.Frame(self, padding=(16, 8))
        buttons.pack(fill="x")
        self.convert_button = ttk.Button(buttons, text="Convert to GLB", command=self.convert)
        self.convert_button.pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="Save GFPAK index…", command=self.save_index).pack(side="left", padx=6)
        ttk.Button(buttons, text="Show archive entries", command=self.show_entries).pack(side="left", padx=6)
        ttk.Button(buttons, text="Clear log", command=lambda: self.log.delete("1.0", "end")).pack(side="right")
        ttk.Progressbar(self, mode="determinate", maximum=100, variable=self.progress).pack(fill="x", padx=18, pady=(0, 6))
        ttk.Label(self, textvariable=self.status, padding=(18, 0, 18, 8)).pack(fill="x")
        frame = ttk.LabelFrame(self, text="Conversion log", padding=5)
        frame.pack(fill="both", expand=True, padx=16, pady=(0, 15))
        self.log = tk.Text(frame, wrap="word", font=("Consolas", 10), height=8)
        scroll = ttk.Scrollbar(frame, command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set)
        self.log.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.write("Ready. Choose a GFPak or TRMDL folder, configure Blender, and select Convert to GLB.")

    def _row(self, parent, row, label, variable, directory=False):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 10), pady=2)
        ttk.Entry(parent, textvariable=variable).grid(row=row, column=1, sticky="ew", pady=2)
        def browse():
            if directory:
                result = filedialog.askdirectory(title=label)
            else:
                result = filedialog.askopenfilename(title=label)
            if result:
                variable.set(result)
                self.save_settings()
        ttk.Button(parent, text="Browse…", command=browse).grid(row=row, column=2, padx=(8, 0), pady=2)

    def write(self, message):
        self.log.insert("end", message + "\n")
        self.log.see("end")

    def update_from_worker(self, message):
        self.after(0, lambda: self.write(message))
        self.after(0, lambda: self.status.set(message))

    def set_inputs(self, paths):
        if self.busy:
            return
        self.inputs = paths
        self.archive = None
        if len(paths) == 1 and paths[0].suffix.lower() == ".gfpak":
            try:
                self.archive = GFPak(paths[0])
            except (GFPakError, OSError) as exc:
                self.inputs = []
                messagebox.showerror("Invalid archive", str(exc))
                return
            s = self.archive.summary()
            self.summary.config(text=f"{paths[0].name}  |  {s['file_count']} resources  |  {s['folder_count']} folders  |  compression: {s['compression_types']}")
            self.write(f"Opened {paths[0].name}: {s['file_count']} resources.")
        else:
            self.summary.config(text=f"{len(paths)} selected: " + ", ".join(p.name for p in paths[:4]))
            self.write(f"Selected {len(paths)} model inputs.")

    def open_archive(self):
        path = filedialog.askopenfilename(title="Open GFPak", filetypes=[("GFPak", "*.gfpak"), ("All files", "*.*")])
        if path:
            self.set_inputs([Path(path)])

    def open_native(self):
        path = filedialog.askopenfilename(
            title="Open Pokémon native 3D mesh",
            filetypes=[
                ("Pokémon Switch model", "*.trmdl *.gfbmdl"),
                ("Trinity model (PLA / SV / Z-A)", "*.trmdl"),
                ("GFBMDL model (Let's Go / SWSH)", "*.gfbmdl"),
                ("All files", "*.*"),
            ])
        if path:
            self.set_inputs([Path(path)])

    def open_folder(self):
        path = filedialog.askdirectory(title="Choose decoded Pokémon model folder")
        if path:
            self.set_inputs([Path(path)])

    def open_batch(self):
        paths = filedialog.askopenfilenames(title="Choose GFPak archives", filetypes=[("GFPAK files", "*.gfpak")])
        if paths:
            self.set_inputs([Path(path) for path in paths])

    def save_index(self):
        if not self.archive:
            messagebox.showinfo("No archive", "Open one GFPak archive first.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".json", initialfile=self.archive.source.stem + "_index.json", filetypes=[("JSON", "*.json")])
        if path:
            self.archive.save_report(path)
            self.write("Saved index: " + path)

    def show_entries(self):
        if not self.archive:
            messagebox.showinfo("No archive", "Open a single GFPak archive first.")
            return
        window = tk.Toplevel(self)
        window.title("GFPAK resources")
        window.geometry("760x460")
        cols = ("index", "folder", "codec", "size", "hash")
        tree = ttk.Treeview(window, columns=cols, show="headings")
        for col in cols:
            tree.heading(col, text=col.title())
        for r in self.archive.resources:
            tree.insert("", "end", values=(r.index, r.folder, r.compression, r.size, r.path_hash))
        tree.pack(fill="both", expand=True)

    def convert(self):
        if self.busy:
            return
        if not self.inputs:
            messagebox.showinfo("No source", "Choose a GFPAK or decoded model folder.")
            return
        if len(self.inputs) == 1:
            out = filedialog.asksaveasfilename(initialfile=self.inputs[0].stem + ".glb",
                                              defaultextension=".glb", filetypes=[("GLB model", "*.glb")])
            if not out:
                return
            outputs = [Path(out)]
        else:
            dest = filedialog.askdirectory(title="Choose folder for batch GLB exports")
            if not dest:
                return
            outputs = [Path(dest) / (src.stem + ".glb") for src in self.inputs]
        self.save_settings()
        inputs = list(zip(self.inputs, outputs))
        settings = {key: getattr(self, key).get().strip()
                    for key in ("blender", "addon", "hashes", "oodle", "textures")}
        animation_flag = self.animations.get()
        self.busy = True
        self.convert_button.configure(state="disabled")
        self.progress.set(0)
        self.write("Starting model conversion…")
        def work():
            good, bad = 0, 0
            for idx, (src, dst) in enumerate(inputs):
                def option(name):
                    return Path(settings[name]) if settings[name] else None
                try:
                    convert_model(ConversionOptions(
                        source=src, output=dst, blender=Path(settings["blender"]),
                        addon=Path(settings["addon"]), dictionary=option("hashes"),
                        oodle=option("oodle"), texture_folder=option("textures"),
                        animations=animation_flag), progress=self.update_from_worker)
                    good += 1
                    self.update_from_worker("SUCCESS: " + str(dst))
                except (ConversionError, GFPakError, OSError) as exc:
                    bad += 1
                    self.update_from_worker("FAILED: " + src.name + " — " + str(exc))
                self.after(0, lambda value=round((idx + 1) / len(inputs) * 100): self.progress.set(value))
            self.after(0, lambda: self.finish(good, bad))
        threading.Thread(target=work, daemon=True).start()

    def finish(self, good, bad):
        self.busy = False
        self.convert_button.configure(state="normal")
        self.status.set(f"Finished: {good} converted, {bad} failed. Read the log for details.")
        self.write(self.status.get())


def main():
    Studio().mainloop()


if __name__ == "__main__":
    main()
