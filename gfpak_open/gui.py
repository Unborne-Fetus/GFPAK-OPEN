"""Lightweight Tkinter archive browser: read-only until Export is selected."""
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .core import GFPak, GFPakError


class Studio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("GFPak Open — Archive Studio")
        self.geometry("1080x680")
        self.minsize(820, 480)
        self.archive = None
        self.dll = None
        self.status = tk.StringVar(value="Open an extracted .gfpak archive to begin.")
        self._build()

    def _build(self):
        menubar = tk.Menu(self)
        filemenu = tk.Menu(menubar, tearoff=False)
        filemenu.add_command(label="Open GFPak…", command=self.open_file)
        filemenu.add_command(label="Select Oodle DLL…", command=self.select_dll)
        filemenu.add_separator()
        filemenu.add_command(label="Save JSON index…", command=self.export_report)
        filemenu.add_command(label="Exit", command=self.destroy)
        menubar.add_cascade(label="File", menu=filemenu)
        self.config(menu=menubar)
        actions = ttk.Frame(self, padding=10)
        actions.pack(fill="x")
        ttk.Button(actions, text="Open .gfpak", command=self.open_file).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="Export selected", command=lambda: self.export(False, False)).pack(side="left", padx=3)
        ttk.Button(actions, text="Export all", command=lambda: self.export(True, False)).pack(side="left", padx=3)
        ttk.Button(actions, text="Save packed blocks", command=lambda: self.export(False, True)).pack(side="left", padx=3)
        ttk.Button(actions, text="Save JSON index", command=self.export_report).pack(side="left", padx=3)
        self.heading = ttk.Label(self, text="No archive loaded", padding=(14, 8))
        self.heading.pack(fill="x")
        columns = ("index", "folder", "packed", "unpacked", "compression", "path_hash")
        frame = ttk.Frame(self, padding=(10, 0, 10, 0))
        frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(frame, columns=columns, show="headings", selectmode="extended")
        sizes = (80, 115, 110, 110, 110, 250)
        labels = ("Index", "Folder", "Packed bytes", "Unpacked bytes", "Compression", "Path hash")
        for col, title, width in zip(columns, labels, sizes):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=width, anchor="w")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        ttk.Label(self, textvariable=self.status, padding=12, anchor="w").pack(fill="x")

    def open_file(self):
        path = filedialog.askopenfilename(title="Choose a GFPak", filetypes=[("GFPAK archives", "*.gfpak"), ("All files", "*.*")])
        if not path:
            return
        try:
            archive = GFPak(path)
        except (GFPakError, OSError) as exc:
            messagebox.showerror("Cannot open archive", str(exc))
            return
        self.archive = archive
        self.tree.delete(*self.tree.get_children())
        for r in archive.resources:
            self.tree.insert("", "end", iid=str(r.index), values=(
                r.index, r.folder if r.folder is not None else "—", r.packed_size,
                r.size, {0: "Stored", 2: "LZ4", 3: "Oodle"}.get(r.compression, str(r.compression)),
                r.path_hash,
            ))
        desc = archive.summary()
        self.heading.config(text=f"{archive.source.name}    •    {desc['file_count']} resources    •    {desc['folder_count']} folders")
        self.status.set("Loaded successfully. Select items to export; Oodle compressed items require your own compatible DLL.")

    def select_dll(self):
        path = filedialog.askopenfilename(title="Select an Oodle runtime DLL", filetypes=[("Windows DLL", "*.dll"), ("All files", "*.*")])
        if path:
            self.dll = path
            self.status.set("Oodle DLL selected: " + Path(path).name)

    def export_report(self):
        if not self.archive:
            messagebox.showinfo("No archive", "Open a .gfpak archive first.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".json", initialfile=self.archive.source.stem + "_index.json", filetypes=[("JSON", "*.json")])
        if path:
            try:
                self.archive.save_report(path)
                self.status.set("Saved index: " + path)
            except OSError as exc:
                messagebox.showerror("Export failed", str(exc))

    def export(self, all_files: bool, packed: bool):
        if not self.archive:
            messagebox.showinfo("No archive", "Open a .gfpak archive first.")
            return
        selected = self.archive.resources if all_files else [self.archive.resources[int(x)] for x in self.tree.selection()]
        if not selected:
            messagebox.showinfo("No selection", "Select one or more entries, or choose Export all.")
            return
        if any(r.compression == 3 for r in selected) and not packed and not self.dll:
            messagebox.showinfo("Oodle required", "These entries use Oodle compression. Choose File > Select Oodle DLL to supply a compatible runtime, or use Save packed blocks to export compressed data.")
            return
        out = filedialog.askdirectory(title="Choose export folder")
        if not out:
            return
        self.status.set(f"Exporting {len(selected)} resources…")
        def work():
            try:
                result = self.archive.extract(out, selected, oodle_dll=self.dll, packed=packed)
                self.after(0, lambda: self.status.set(f"Exported {len(result)} resources to {out}"))
            except (GFPakError, OSError) as exc:
                self.after(0, lambda: messagebox.showerror("Export failed", str(exc)))
                self.after(0, lambda: self.status.set("Export failed; see error."))
        threading.Thread(target=work, daemon=True).start()


def main():
    Studio().mainloop()


if __name__ == "__main__":
    main()
