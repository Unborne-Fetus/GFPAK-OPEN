"""Automatic model/animation/texture links use evidence, never made-up species."""
import unittest

from gfpak_open.asset_matching import match_model_assets


def item(number, path, category, scope="game"):
    return {"id": str(number), "relative": path,
            "name": path.rsplit("/", 1)[-1], "scope": scope,
            "category": category}


class AssetMatchingTests(unittest.TestCase):
    def test_unique_model_gathers_texture_mesh_skeleton_and_animation(self):
        rows = [item(1, "pokemon/pm0025_00_00.trmdl", "model"),
                item(2, "pokemon/pm0025_00_00.trmsh", "mesh"),
                item(3, "pokemon/pm0025_body.bntx", "texture"),
                item(4, "animations/pm0025_idle.tranm", "animation"),
                item(5, "pokemon/pm0025_00_00.trskl", "skeleton")]
        grouped = match_model_assets(rows)
        self.assertEqual({row["id"] for row in grouped["1"]}, {"2", "3", "4", "5"})
        self.assertTrue(all(row["reason"] for row in grouped["1"]))

    def test_never_match_different_species_or_different_containers(self):
        rows = [item(1, "p/pm0025.trmdl", "model"),
                item(2, "p/pm0026_idle.tranm", "animation"),
                item(3, "p/pm0025_body.bntx", "texture", "other"),
                item(4, "p/pm0025_idle.tranm", "animation")]
        self.assertEqual([x["id"] for x in match_model_assets(rows)["1"]], ["4"])

    def test_ambiguous_generic_textures_remain_unattached(self):
        rows = [item(1, "p/pm0025.trmdl", "model"),
                item(2, "p/pm0026.trmdl", "model"),
                item(3, "p/body.bntx", "texture"),
                item(4, "p/idle.tranm", "animation")]
        grouped = match_model_assets(rows)
        self.assertEqual(grouped["1"], [])
        self.assertEqual(grouped["2"], [])

    def test_single_model_can_match_generic_companions_in_same_folder(self):
        rows = [item(1, "p/pm0025.trmdl", "model"),
                item(2, "p/body.bntx", "texture"),
                item(3, "p/idle.tranm", "animation")]
        grouped = match_model_assets(rows)
        self.assertEqual({x["id"] for x in grouped["1"]}, {"2", "3"})
        self.assertTrue(all(x["confidence"] == "probable" for x in grouped["1"]))

    def test_matching_large_game_is_scoped_not_global(self):
        rows = []
        for n in range(500):
            rows.extend([
                item(3*n, f"pm{n:04d}/pm{n:04d}.trmdl", "model"),
                item(3*n+1, f"pm{n:04d}/pm{n:04d}_idle.tranm", "animation"),
                item(3*n+2, f"pm{n:04d}/body.bntx", "texture")
            ])
        grouped = match_model_assets(rows)
        self.assertEqual(len(grouped), 500)
        self.assertTrue(all(len(parts) == 2 for parts in grouped.values()))


if __name__ == "__main__":
    unittest.main()
