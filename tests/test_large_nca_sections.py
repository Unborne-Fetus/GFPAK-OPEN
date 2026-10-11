"""Regression tests for multi-gigabyte NCA sections and huge RomFS directories.

Fake sparse storage reports >8 GiB logical size but allocates under 200 KiB:
CI does not need Switch game content, decryption keys, or gigabyte fixtures.
"""
from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gfpak_open.nca_native import NativeNCAError, RomFS, NONE
from gfpak_open.asset_browser import AssetBrowser


class SparseSection:
    """Large virtual section: metadata tables exceed 16 MiB each."""
    size = 9 * 1024**3
    dir_table_off = 0x1000
    dir_table_size = 24 * 1024**2
    file_table_off = 0x1900000
    file_table_size = 48 * 1024**2
    data_off = 0x5000000

    def __init__(self, file_count=3304, cycle=False):
        self.requests = []
        self.file_count = file_count
        root = struct.pack("<6I", NONE, NONE, NONE, 0, NONE, 0)
        table = bytearray(file_count * 40)
        for i in range(file_count):
            name = ("f%06d" % i).encode()
            next_offset = (i + 1) * 40 if i + 1 < file_count else NONE
            if cycle and i == file_count - 1:
                next_offset = 0
            struct.pack_into("<IIQQII", table, i * 40, 0, next_offset,
                             5 * 1024**3, 128, NONE, len(name))
            table[i * 40 + 32:i * 40 + 32 + len(name)] = name
        header = struct.pack(
            "<10Q", 0x50, self.dir_table_off, 0,
            self.dir_table_off, self.dir_table_size,
            self.file_table_off, 0,
            self.file_table_off, self.file_table_size,
            self.data_off
        )
        self.blocks = [
            (0, header),
            (self.dir_table_off, root),
            (self.file_table_off, table),
        ]

    def read(self, relative, size):
        self.requests.append(size)
        if relative < 0 or size < 0 or relative + size > self.size:
            raise AssertionError("Read exceeded synthetic sparse section.")
        if size > 64 * 1024:
            raise AssertionError("Reader tried to buffer too much metadata.")
        result = bytearray(size)
        for start, data in self.blocks:
            lo = max(start, relative)
            hi = min(start + len(data), relative + size)
            if lo < hi:
                result[lo - relative:hi - relative] = data[lo - start:hi - start]
        return bytes(result)


class LargeNCATreeTests(unittest.TestCase):
    def test_over_16_mib_tables_and_over_3000_files_are_fully_pageable(self):
        section = SparseSection()
        fs = RomFS(section, 0)
        self.assertEqual(fs.dir_table_size, 24 * 1024**2)
        self.assertEqual(fs.file_table_size, 48 * 1024**2)
        self.assertLessEqual(max(section.requests), 65536)

        seen = []
        cursor = None
        pages = 0
        while True:
            page = fs.children_page("", cursor)
            pages += 1
            seen.extend(row["name"] for row in page["entries"])
            if page["next_cursor"] is None:
                break
            cursor = page["next_cursor"]
        self.assertEqual(len(seen), 3304)
        self.assertEqual(len(set(seen)), 3304)
        self.assertEqual(seen[0], "f000000")
        self.assertEqual(seen[-1], "f003303")
        self.assertEqual(pages, 14)
        self.assertEqual(fs.children_page("")["entries"][0]["name"], "f000000")
        self.assertLessEqual(max(section.requests), 65536)
        self.assertLessEqual(len(fs._file_table._pages), fs._file_table.CACHE_PAGES)
        self.assertEqual(fs.file("f003303").offset,
                         section.data_off + 5 * 1024**3)

    def test_forged_cursor_is_rejected_and_cycles_are_detected(self):
        fs = RomFS(SparseSection(file_count=2), 0)
        with self.assertRaisesRegex(NativeNCAError, "cursor"):
            fs.children_page("", "f:ffffffff")
        fs.children_page("")
        broken = RomFS(SparseSection(file_count=3, cycle=True), 0)
        with self.assertRaisesRegex(NativeNCAError, "cycle"):
            broken.children_page("")

    def test_asset_browser_paginates_huge_directory_without_losing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = SparseSection(file_count=3304)
            fs = RomFS(section, 0)
            browser = AssetBrowser()
            path = Path(tmp) / "large.nsp"
            root = browser._node("nca_section", path, name="Section 1")
            browser._section_nodes[root["id"]] = (0, 1)
            fake_reader = SimpleNamespace(path=path)
            browser._nca_sources[root["id"]] = fake_reader
            with patch.object(browser._nca_sections, "filesystem", return_value=fs):
                page = browser.children(root["id"])
                self.assertEqual(len(page["entries"]), 250)
                self.assertTrue(page["truncated"])
                self.assertIsNotNone(page["next_cursor"])
                self.assertEqual(page["entries"][0]["name"], "f000000")
                visited = list(page["entries"])
                while page["next_cursor"]:
                    page = browser.children(root["id"], page["next_cursor"])
                    visited.extend(page["entries"])
            self.assertEqual(len(visited), 3304)
            self.assertEqual(len({row["id"] for row in visited}), 3304)
            self.assertFalse(page["truncated"])
            self.assertIsNone(page["next_cursor"])
            self.assertLessEqual(max(section.requests), 65536)


if __name__ == "__main__":
    unittest.main()
