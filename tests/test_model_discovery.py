"""Regression coverage for hash-only Trinity model discovery."""
import unittest
from dataclasses import dataclass

from gfpak_open.model_discovery import infer_model_resources, unwind_suffix
from gfpak_open.converter import fnv1a64


@dataclass
class Item:
    index: int
    path_hash: str
    file_hash: str


class ModelDiscoveryTests(unittest.TestCase):
    def test_fvn_suffix_reversal(self):
        stem = "bin/pokemon/model/pack/monster"
        expected = int(fnv1a64(stem), 16)
        for suffix in (".trmdl", ".trmsh", ".trmbf", ".trmtr", ".trskl"):
            self.assertEqual(unwind_suffix(fnv1a64(stem + suffix), suffix), expected)

    def test_real_pikachu_archive_hash_fingerprints(self):
        # Only public-sized hash fingerprints, never model/game asset bytes.
        originals = [
            (152, "0d0c81ddc29bfc92", "559a761641a62722"),
            (153, "0d20abddc2acecfa", "55ae601641b6aaca"),
            (154, "0d3fa1ddc2c78c8b", "55cd761641d180bb"),
            (155, "0d4689ddc2cd8271", "55677e16417adb21"),
            (156, "0d578dddc2dbfc70", "5578621641891ec0"),
            (157, "92e44bdd7d2af73f", "f40760169c17b36f"),
            (174, "bef18512632cd9eb", "398cf9c3474ce15b"),
            (175, "beb77d1262fb540c", "39bff1c347782d5c"),
            (176, "0874467bce8afe72", "a30994a270d5ad62"),
            (177, "08ae4e7bcebc8451", "a2d69ca270aa6161"),
        ]
        result = infer_model_resources([Item(*x) for x in originals], "pm0025_00_00")
        self.assertEqual(result[153], "pm0025_00_00.trmdl")
        self.assertEqual(result[152], "pm0025_00_00.trmbf")
        self.assertEqual(result[155], "pm0025_00_00.trmsh")
        self.assertEqual(result[157], "pm0025_00_00.trskl")
        self.assertEqual({i for i in result}, {i for i, _, _ in originals})

    def test_no_model_from_random_or_single_hash(self):
        resources = [Item(1, fnv1a64("other.trmdl"), fnv1a64("other.trmdl"))]
        self.assertEqual(infer_model_resources(resources, "sample"), {})

    def test_model_triplet_is_required(self):
        only_two = [Item(n, fnv1a64("same" + ext), fnv1a64("same" + ext))
                    for n, ext in enumerate((".trmdl", ".trmsh"))]
        self.assertEqual(infer_model_resources(only_two, "sample"), {})


if __name__ == "__main__":
    unittest.main()
