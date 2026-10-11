import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from gfpak_open.core import Resource

from gfpak_open.converter import (
    ConversionError, ConversionOptions, HashDictionary, convert_model,
    find_models, fnv1a64, safe_path, validate_glb, discover_dictionary, community_dictionary,
)


def make_glb(path, meshes=True):
    document = {
        "asset": {"version": "2.0"},
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}] if meshes else [],
    }
    payload = json.dumps(document).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    data = b"glTF" + struct.pack("<II", 2, 20 + len(payload))
    data += struct.pack("<II", len(payload), 0x4E4F534A) + payload
    path.write_bytes(data)


class ConverterTests(unittest.TestCase):
    def test_fnv_known_value(self):
        self.assertEqual(fnv1a64("hello"), "a430d84680aabd0b")

    def test_hash_dictionary(self):
        with tempfile.TemporaryDirectory() as tmp:
            txt = Path(tmp) / "gfpak.txt"
            txt.write_text("bin/field/model/pack/\nmodel.trmdl\nmodel.trmsh\n")
            dictionary = HashDictionary(txt)
            self.assertEqual(dictionary.mapping[fnv1a64("model.trmdl")],
                             "bin/field/model/pack/model.trmdl")
            js = Path(tmp) / "map.json"
            js.write_text(json.dumps({"0123456789abcdef": "pokemon/model.trmdl"}))
            self.assertEqual(HashDictionary(js).mapping["0123456789abcdef"], "pokemon/model.trmdl")

    def test_community_dictionary_matches_archive_model_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            names = ["model.trmdl"] + [f"asset_{i}.trmsh" for i in range(130)]
            response = io.BytesIO(("\\n".join(names) + "\\n").encode())
            archive = type("Archive", (), {
                "resources": [Resource(0, 0, 3, 100, 50, 0, fnv1a64("model.trmdl"), None, None, None)]
            })()
            messages = []
            with patch.dict("os.environ", {"LOCALAPPDATA": tmp}):
                with patch("gfpak_open.converter.urllib.request.urlopen", return_value=response):
                    _, matched = community_dictionary(archive, messages.append)
            self.assertEqual(matched, {0: "model.trmdl"})

    def test_auto_discover_companion_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "pm0025_00_00.gfpak"
            self.assertIsNone(discover_dictionary(source))
            dictionary = root / "gfpak.txt"
            dictionary.write_text("model.trmdl\\n")
            self.assertEqual(discover_dictionary(source), dictionary)

    def test_safe_names(self):
        for name in ("../file.trmdl", "/tmp/file.trmdl", "C:/file.trmdl", "abc\\def", "x/../../oops"):
            with self.subTest(name=name), self.assertRaises(ConversionError):
                safe_path(name)
        self.assertEqual(safe_path("foo/bar.trmdl"), Path("foo/bar.trmdl"))

    def test_prefer_base_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "pokemon_lod2.trmdl").write_bytes(b"x")
            Path(tmp, "pokemon.trmdl").write_bytes(b"x")
            self.assertEqual(find_models(Path(tmp))[0].name, "pokemon.trmdl")

    def test_glb_validation_requires_mesh(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "model.glb"
            make_glb(output)
            validate_glb(output)
            make_glb(output, meshes=False)
            with self.assertRaisesRegex(ConversionError, "no 3D meshes"):
                validate_glb(output)

    def test_decoded_folder_blender_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "decoded"
            source.mkdir()
            (source / "pm0025_00_00.trmdl").write_bytes(b"synthetic test data")
            (root / "blender.exe").write_bytes(b"fake")
            addon = root / "addon"
            addon.mkdir()
            (addon / "__init__.py").write_text("")
            target = root / "pikachu.glb"
            def fake_blender(cmd, **_kwargs):
                self.assertIn("--background", cmd)
                self.assertIn("--model", cmd)
                self.assertEqual(cmd[cmd.index("--output") + 1], str(target))
                make_glb(target)
                return type("Result", (), {"returncode": 0, "stdout": "success", "stderr": ""})()
            with patch("gfpak_open.converter.subprocess.run", side_effect=fake_blender):
                result = convert_model(ConversionOptions(source, target, root / "blender.exe", addon))
            self.assertEqual(result, target)
            validate_glb(target)

    def test_gfbmdl_and_trmdl_direct_file_handoff(self):
        for suffix in (".gfbmdl", ".trmdl"):
            with self.subTest(format=suffix), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                src_folder = root / "source"
                src_folder.mkdir()
                source = src_folder / ("pm0025_00_00" + suffix)
                source.write_bytes(b"synthetic test model")
                neighbor = src_folder / "body.png"
                neighbor.write_bytes(b"not an actual PNG: tests staging only")
                blender = root / "blender.exe"
                blender.write_bytes(b"fake")
                addon = root / "addon"
                addon.mkdir()
                (addon / "__init__.py").write_text("")
                target = root / "result.glb"

                def fake_blender(cmd, **_kwargs):
                    model = Path(cmd[cmd.index("--model") + 1])
                    self.assertEqual(model.suffix.lower(), suffix)
                    self.assertTrue(model.with_name("body.png").exists())
                    self.assertEqual(cmd[cmd.index("--output") + 1], str(target))
                    make_glb(target)
                    return type("Result", (), {
                        "returncode": 0, "stdout": "success", "stderr": "",
                    })()

                with patch("gfpak_open.converter.subprocess.run", side_effect=fake_blender):
                    result = convert_model(ConversionOptions(source, target, blender, addon))
                self.assertEqual(result, target)
                validate_glb(target)
                self.assertEqual(source.read_bytes(), b"synthetic test model")

    def test_native_source_does_not_overwrite_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "pokemon.gfbmdl"
            source.write_bytes(b"test")
            blender = root / "blender.exe"
            blender.write_bytes(b"")
            addon = root / "addon"
            addon.mkdir()
            (addon / "__init__.py").write_text("")
            output = root / "already.glb"
            output.write_bytes(b"preserve original")
            with self.assertRaisesRegex(ConversionError, "already exists"):
                convert_model(ConversionOptions(source, output, blender, addon))
            self.assertEqual(output.read_bytes(), b"preserve original")

    def test_archive_without_dictionary_fails_cleanly(self):
        sample = Path("/mnt/data/pm0025_00_00.gfpak")
        if not sample.is_file():
            self.skipTest("User Pikachu sample is not in the public repository")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "blender.exe").write_bytes(b"fake")
            addon = root / "addon"
            addon.mkdir()
            (addon / "__init__.py").write_text("")
            target = root / "out.glb"
            with self.assertRaisesRegex(ConversionError, "filename dictionary"):
                convert_model(ConversionOptions(sample, target, root / "blender.exe", addon))
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
