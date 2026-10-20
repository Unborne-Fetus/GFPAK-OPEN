"""Verified desktop model archive lookup (synthetic, user-owned game files)."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gfpak_open.asset_browser import AssetBrowser
from gfpak_open.model_archive_locator import (
    find_pokemon_model_archive, form_key, selected_form,
)
from test_asset_browser import create_gfpak, create_resolved_gfpak


class ModelArchiveLocatorTests(unittest.TestCase):
    def test_form_key_never_confuses_species_with_a_specific_form(self):
        self.assertEqual(form_key("pm0025_00_00_anim.gfpak"), "pm0025_00_00")
        self.assertEqual(form_key("0012 · PM0025_01_00.trmdl"), "pm0025_01_00")
        self.assertEqual(form_key("pm0025_idle.tranm"), "")
        self.assertEqual(form_key("pm00250_00_00.gfpak"), "")
        self.assertEqual(form_key("pm0025_00_001.gfpak"), "")

    def test_one_click_finds_verified_sibling_before_complete_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "pm0025_00_00-animations.gfpak"
            model = root / "pm0025_00_00-model.gfpak"
            wrong = root / "pm0025_01_00-model.gfpak"
            create_gfpak(source)
            create_resolved_gfpak(model)
            create_resolved_gfpak(wrong)  # Contents are for the wrong form.
            browser = AssetBrowser()
            opened = browser.open(source)
            result = find_pokemon_model_archive(browser, {}, opened["id"])
            self.assertEqual(result["status"], "found")
            self.assertEqual(result["archive"]["name"], model.name)
            self.assertTrue(result["archive"]["expandable"])
            self.assertEqual(result["form"], "pm0025_00_00")
            self.assertTrue(source.exists() and model.exists())

    def test_model_candidates_come_from_decoded_members_not_gfpak_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake = root / "pm0025_00_00-fake.gfpak"
            good = root / "pm0025_00_00-mesh.gfpak"
            create_gfpak(fake)
            create_resolved_gfpak(good)
            browser = AssetBrowser()
            opened = browser.open(root)
            catalog = browser.scan()
            entry = next(row for row in catalog["assets"] if row["name"] == fake.name)
            result = find_pokemon_model_archive(
                browser, {opened["id"]: catalog}, entry["id"])
            self.assertEqual(result["status"], "found")
            self.assertEqual(result["archive"]["name"], good.name)

    def test_two_matching_model_archives_are_not_silently_chosen(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "pm0025_00_00-animation.gfpak"
            model_a = root / "pm0025_00_00-a.gfpak"
            model_b = root / "pm0025_00_00-b.gfpak"
            create_gfpak(source)
            create_resolved_gfpak(model_a)
            create_resolved_gfpak(model_b)
            browser = AssetBrowser()
            opened = browser.open(source)
            result = find_pokemon_model_archive(browser, {}, opened["id"])
            self.assertEqual(result["status"], "ambiguous")
            self.assertEqual(result["count"], 2)
            self.assertEqual(
                {row["name"] for row in result["archives"]}, {model_a.name, model_b.name})

    def test_no_selection_lists_archives_instead_of_guessing_a_pokemon(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            create_resolved_gfpak(root / "pm0025_00_00-first.gfpak")
            create_resolved_gfpak(root / "pm0025_00_00-second.gfpak")
            browser = AssetBrowser()
            opened = browser.open(root)
            result = find_pokemon_model_archive(browser, {opened["id"]: browser.scan()}, None)
            self.assertEqual(result["status"], "browse")

    def test_missing_archive_requests_index_without_claiming_false_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extra = root / "pm0025_00_00-effects.gfpak"
            create_gfpak(extra)
            browser = AssetBrowser()
            opened = browser.open(root)
            source = browser.children(opened["id"])["entries"][0]
            result = find_pokemon_model_archive(browser, {}, source["id"])
            self.assertEqual(result["status"], "scan_required")
            result = find_pokemon_model_archive(
                browser, {opened["id"]: browser.scan()}, source["id"])
            self.assertEqual(result["status"], "not_found")
            self.assertIn("No verified", result["message"])

    def test_unqualified_form_requires_explicit_pokemon_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "pm0025_idle.tranm").write_bytes(b"animation")
            browser = AssetBrowser()
            opened = browser.open(root)
            candidate = browser.children(opened["id"])["entries"][0]
            self.assertFalse(selected_form(browser, browser.node(candidate["id"])))
            result = find_pokemon_model_archive(browser, {}, candidate["id"])
            self.assertEqual(result["status"], "needs_selection")

    def test_related_romfs_archive_is_read_from_current_section_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            browser = AssetBrowser()
            browser.open(root)
            reader = SimpleNamespace(path=root / "user-owned.nsp")
            archive = browser._node(
                "nca_file", reader.path, inner="source:0:1",
                name="pm0025_00_00-effects.gfpak", size=200)
            browser._nca_virtual_nodes[archive["id"]] = (
                0, 1, "pokemon/pm0025_00_00-effects.gfpak")
            browser._nca_sources[archive["id"]] = reader
            fs = SimpleNamespace(children_page=lambda path, cursor=None, limit=250: {
                "entries": [
                    {"type": "file", "name": "pm0025_00_00-model.gfpak",
                     "path": "pokemon/pm0025_00_00-model.gfpak", "size": 300},
                    {"type": "file", "name": "pm0025_01_00-model.gfpak",
                     "path": "pokemon/pm0025_01_00-model.gfpak", "size": 300},
                ], "next_cursor": None
            })
            with patch.object(browser, "_nca_virtual_file", return_value=(
                    reader, 0, 1, "pokemon/pm0025_00_00-effects.gfpak")), \
                 patch.object(browser._nca_sections, "filesystem", return_value=fs), \
                 patch.object(browser, "_mounted_gfpak", side_effect=lambda id_: (
                    None, {0: "pm0025_00_00.trmdl"} if id_ != archive["id"] else
                    {0: "pm0025_00_00-body.bntx"})):
                result = find_pokemon_model_archive(browser, {}, archive["id"])
            self.assertEqual(result["status"], "found")
            self.assertEqual(result["archive"]["name"], "pm0025_00_00-model.gfpak")


if __name__ == "__main__":
    unittest.main()
