"""Pokémon model/texture/animation association uses verified filename families."""
import tempfile
import unittest
from pathlib import Path

from gfpak_open.pokemon_assets import asset_kind, engine_family, group_related, pokemon_id
from gfpak_open.asset_browser import AssetBrowser


class PokemonAssetCatalogTests(unittest.TestCase):
    def test_group_model_texture_skeleton_and_native_clips(self):
        files = [
            "archive/pokemon/pm0025_00_00.trmdl",
            "archive/pokemon/pm0025_00_00.trmsh",
            "archive/pokemon/pm0025_00_00.trmbf",
            "archive/pokemon/pm0025_00_00.trmtr",
            "archive/pokemon/pm0025_00_00.trskl",
            "archive/pokemon/pm0025_body.bntx",
            "animations/pm0025_idle.tranm",
            "animations/pm0025_walk.tranm",
            "animations/pm0026_idle.tranm",
        ]
        report = group_related(files[0], files)
        self.assertEqual(report["asset_id"], "pm0025")
        self.assertEqual(report["engine"], "Game Freak Trinity")
        self.assertEqual(report["counts"]["animation"], 2)
        self.assertEqual(report["counts"]["texture"], 1)
        self.assertEqual(report["counts"]["skeleton"], 1)
        self.assertTrue(all("pm0026" not in row["path"] for row in report["files"]))
        self.assertIn("not a verified", report["note"])

    def test_detect_other_engines_without_guessing_species(self):
        self.assertEqual(engine_family(["pokemon/sample.gfbmdl"]), "Game Freak GFBMDL")
        self.assertIn("Snap", engine_family(["texture.nutexb"]))
        self.assertIn("Unity", engine_family(["assets.bundle"]))
        self.assertEqual(pokemon_id("pm00250"), "")
        self.assertEqual(pokemon_id("a/pm0025_01_00.gfpak"), "pm0025")
        self.assertEqual(asset_kind("mystery_abcdef.bin"), "unidentified")
        self.assertEqual(group_related("unidentified.bin", ["pm0025.trmdl"])["files"], [])

    def test_desktop_file_browser_groups_only_discovered_asset_nodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for name in ("pm0025_00_00.trmdl", "pm0025_body.bntx",
                         "pm0025_walk.tranm", "pm0026_walk.tranm"):
                (folder / name).write_bytes(b"test")
            browser = AssetBrowser()
            root = browser.open(folder)
            listing = browser.children(root["id"])
            model = next(row for row in listing["entries"] if row["name"].endswith(".trmdl"))
            report = browser.asset_family(model["id"])
            self.assertEqual(report["counts"]["animation"], 1)
            self.assertEqual(report["counts"]["texture"], 1)
            self.assertEqual(report["counts"]["model"], 1)


if __name__ == "__main__":
    unittest.main()
