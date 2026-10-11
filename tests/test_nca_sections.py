"""Synthetic NSP tests for authentic nested NCA section tree behavior.

No actual game packages, console keys, or decryption utilities are needed.
"""
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gfpak_open.asset_browser import AssetBrowser
from gfpak_open.nca_sections import LocalNCASections, SECTION_RE
from gfpak_open.nsp_explorer import NSPAnalyzer


def make_nsp(path: Path):
    filename = b"0123456789abcdef0123456789abcdef.nca\0"
    data = b"NCA placeholder bytes not a real encrypted file"
    path.write_bytes(
        b"PFS0" + struct.pack("<III", 1, len(filename), 0) +
        struct.pack("<QQII", 0, len(data), 0, 0) +
        filename + data
    )
    return data


class NCATreeTests(unittest.TestCase):
    def test_section_recognition_from_reader_output(self):
        report = "NCA header\nSection 0:\n\tExeFS\nSection 1:\n\tRomFS\nSection 2:\n"
        self.assertEqual(sorted(set(map(int, SECTION_RE.findall(report)))), [0, 1, 2])

    def test_locked_nca_shows_help_not_fake_sections(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "test.nsp"
            make_nsp(source)
            browser = AssetBrowser(nca_workspace=Path(temp) / "cache")
            root = browser.open(source)
            nca = browser.children(root["id"])["entries"][0]
            self.assertTrue(nca["expandable"])
            listing = browser.children(nca["id"])
            self.assertEqual([r["name"] for r in listing["entries"]],
                             ["Sections unavailable"])
            self.assertIn("Select a local NCA reader", listing["note"])
            self.assertFalse(listing["entries"][0]["expandable"])
            self.assertFalse((Path(temp) / "cache").joinpath("readable.nca").exists())

    def test_true_section_tree_and_lazy_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "test.nsp"
            original = make_nsp(package)
            tool = root / "hactool.exe"
            tool.write_bytes(b"reader fixture")
            keyset = root / "local.keys"
            keyset.write_text("dummy fixture, not real keys")
            browser = AssetBrowser(nca_workspace=root / "staged")
            node = browser.open(package)
            browser.configure_nca_reader(tool, keyset)
            calls = []

            def fake_reader(command, **_kw):
                calls.append(command)
                self.assertIn("--suppresskeys", command)
                self.assertEqual(command[0], str(tool))
                if "-i" in command:
                    staged = Path(command[-1])
                    self.assertTrue(staged.is_file())
                    self.assertEqual(staged.read_bytes(), original)
                    return SimpleNamespace(returncode=0,
                                           stdout=b"Section 0:\nSection 1:\n",
                                           stderr=b"")
                if "--section0dir" in command:
                    out = Path(command[command.index("--section0dir") + 1])
                    (out / "main").write_bytes(b"fake main")
                    (out / "main.npdm").write_bytes(b"fake npdm")
                elif "--section1dir" in command:
                    out = Path(command[command.index("--section1dir") + 1])
                    pokemon = out / "bin" / "archive" / "pokemon"
                    pokemon.mkdir(parents=True)
                    (pokemon / "pm0025_00_00.gfpak").write_bytes(b"model fixture")
                return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

            with patch("gfpak_open.nca_sections.subprocess.run", side_effect=fake_reader):
                nca = browser.children(node["id"])["entries"][0]
                sections = browser.children(nca["id"])["entries"]
                self.assertEqual([x["name"] for x in sections],
                                 ["Section 0", "Section 1"])
                self.assertEqual(len(calls), 1)  # Listing sections is lazy.
                section_zero = browser.children(sections[0]["id"])["entries"]
                self.assertEqual({x["name"] for x in section_zero},
                                 {"main", "main.npdm"})
                section_one = browser.children(sections[1]["id"])["entries"]
                self.assertEqual([r["name"] for r in section_one], ["bin"])
                child = section_one[0]
                for folder in ("archive", "pokemon"):
                    listing = browser.children(child["id"])
                    child = next(x for x in listing["entries"] if x["name"] == folder)
                pokemon_files = browser.children(child["id"])["entries"]
                self.assertEqual(pokemon_files[0]["name"], "pm0025_00_00.gfpak")
                self.assertEqual(len(calls), 3)
                browser.children(sections[1]["id"])
                self.assertEqual(len(calls), 3)  # Section reused from temp cache.

    def test_reader_failure_does_not_invent_sections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "test.nsp"
            make_nsp(package)
            tool = root / "reader.exe"
            tool.touch()
            keyset = root / "local.keys"
            keyset.touch()
            browser = AssetBrowser(nca_workspace=root / "staged")
            main = browser.open(package)
            browser.configure_nca_reader(tool, keyset)
            with patch("gfpak_open.nca_sections.subprocess.run",
                       return_value=SimpleNamespace(returncode=1,
                                                    stdout=b"secret keys here",
                                                    stderr=b"bad")):
                nca = browser.children(main["id"])["entries"][0]
                result = browser.children(nca["id"])
            self.assertEqual(result["entries"][0]["name"], "Sections unavailable")
            self.assertNotIn("secret", result["note"].lower())

    def test_no_available_disk_space_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "test.nsp"
            make_nsp(package)
            tool = root / "reader.exe"
            tool.touch()
            keyset = root / "local.keys"
            keyset.touch()
            explorer = LocalNCASections(root / "staged")
            explorer.configure(tool, keyset)
            with patch("gfpak_open.nca_sections.shutil.disk_usage",
                       return_value=SimpleNamespace(free=0)):
                with self.assertRaisesRegex(RuntimeError, "free temporary disk"):
                    explorer.sections(NSPAnalyzer(package), 0)


if __name__ == "__main__":
    unittest.main()
