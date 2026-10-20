"""Desktop effect companion evidence, boundaries, and export metadata."""
import unittest
from gfpak_open.effect_analysis import analyze_effect_assets


class EffectInventoryTests(unittest.TestCase):
    def test_effects_and_companions_are_discovered_without_claiming_decoding(self):
        result = analyze_effect_assets("pm0006_00_00.gfbmdl", [
            {"path": "pm0006_FireCore.bntx"},
            {"path": "pm0006_smoke.trmtr"},
            {"path": "pm0006_flame.traef", "linkedKind": "animation"},
            {"path": "pm0006_custom.bnsh"},
            {"path": "pm0006_idle.gfbanm"},
            {"path": "pm0006_geometry.gfbmdl"},
            {"path": "pm0007_flame.bntx"},
        ])
        self.assertEqual(result["identifiedEffects"], ["fire", "smoke"])
        self.assertEqual(result["companionCounts"], {
            "textures": 1, "animations": 2, "materials": 1, "shaders": 1
        })
        self.assertEqual(result["ignoredOtherSpecies"], 1)
        self.assertEqual(result["accuracy"], "candidate-only")
        self.assertTrue(any(h["linked"] for h in result["hints"]))

    def test_unrelated_filenames_are_not_misclassified(self):
        result = analyze_effect_assets("pm0092.trmdl", [
            {"path": "fire_cave/pm0092_diffuse.bntx"},
            {"path": "effects/unresolved_0xdeadbeef.bin"},
            {"path": "animation_01.tranm"},
            {"path": "fog/cloud.traef"},
        ])
        self.assertEqual(result["identifiedEffects"], ["unspecified"])
        self.assertEqual(result["companionCounts"]["animations"], 2)

    def test_duplicate_and_invalid_paths_are_ignored(self):
        result = analyze_effect_assets("pm0004.gfbmdl", [
            {"path": "pm0004_fire.bntx"},
            {"path": "PM0004_FIRE.BNTX"},
            {"path": None},
            {"path": ""},
        ])
        self.assertEqual(result["companionCounts"]["textures"], 1)
        self.assertEqual(len(result["hints"]), 1)


if __name__ == "__main__":
    unittest.main()
