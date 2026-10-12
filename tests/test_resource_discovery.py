"""Synthetic coverage for independently named textures and animation packs."""
import struct
import unittest
from types import SimpleNamespace
from gfpak_open.converter import fnv1a64
from gfpak_open.resource_discovery import discover_resource_names, content_extension
from gfpak_open.asset_matching import match_model_assets


class Archive:
    def __init__(self, contents, seed=0xCBF29CE484222325):
        self.contents = contents
        self.reads = []
        self.resources = [SimpleNamespace(index=i, size=len(data),
                          path_hash=fnv1a64(name, seed), file_hash=fnv1a64(name, seed))
                          for i, (name, data) in enumerate(contents)]
    def read_resource(self, resource):
        self.reads.append(resource.index)
        return self.contents[resource.index][1]


def animation():
    # Root -> info/skeletal -> one named bone -> framed translation channel.
    data = bytearray(176)
    struct.pack_into('<I', data, 0, 16)
    def table(vt, at, fields, size):
        struct.pack_into('<HH', data, vt, 4 + len(fields)*2, size)
        for i, offset in enumerate(fields):
            struct.pack_into('<H', data, vt + 4 + i*2, offset)
        struct.pack_into('<i', data, at, at-vt)
    table(4, 16, [4, 8], 12)
    struct.pack_into('<II', data, 20, 40-20, 64-24)
    table(28, 40, [4, 8, 12], 16)
    struct.pack_into('<III', data, 44, 1, 2, 30)
    table(56, 64, [4], 8)
    struct.pack_into('<I', data, 68, 72-68)
    struct.pack_into('<II', data, 72, 1, 104-76)
    table(80, 104, [4, 0, 0, 0, 0, 8, 12], 16)
    struct.pack_into('<I', data, 108, 136-108)
    data[112] = 2
    struct.pack_into('<I', data, 116, 128-116)
    table(120, 128, [4], 8)
    struct.pack_into('<I', data, 132, 148-132)
    struct.pack_into('<I', data, 136, 4)
    data[140:145] = b'root\0'
    struct.pack_into('<I', data, 148, 2)
    return bytes(data)


class DiscoveryTests(unittest.TestCase):
    def test_reference_chain_restores_material_and_texture_names(self):
        archive = Archive([
            ('pm0025.trmdl', b'body.trmmt\0'),
            ('body.trmmt', b'skin.trmtr\0'),
            ('skin.trmtr', b'body.bntx\0'),
            ('body.bntx', b'BNTX\0'),
        ])
        names = discover_resource_names(archive, {0:'pm0025.trmdl'})
        self.assertEqual(names, dict(enumerate(name for name, _ in archive.contents)))
        self.assertEqual(len(archive.reads), len(set(archive.reads)))

    def test_unreferenced_texture_and_animation_identified_without_model_triplet(self):
        archive = Archive([('unknown_texture', b'BNTX\0'),
                           ('unknown_clip', animation()), ('junk', b'not an animation')])
        names = discover_resource_names(archive, {})
        self.assertEqual(names, {0:'resource_0000.bntx', 1:'resource_0001.tranm'})

    def test_content_companions_match_multiple_forms_of_one_family(self):
        archive = Archive([('pm0025_a.trmdl', b'foo'),
                           ('pm0025_b.trmdl', b'bar'), ('random', animation())])
        names = discover_resource_names(archive, {0:'pm0025_a.trmdl',1:'pm0025_b.trmdl'})
        rows = [dict(id=str(i), name=name, scope='pack', game_scope='game',
                     category='animation' if i == 2 else 'model')
                for i, name in names.items()]
        matches = match_model_assets(rows)
        self.assertEqual(matches['0'][0]['kind'], 'animation')
        self.assertEqual(matches['1'][0]['kind'], 'animation')

    def test_game_freak_offset_basis_restores_exact_companion_paths(self):
        archive = Archive([('pm0025.trmdl', b'pm0025.trmtr\0'),
                           ('pm0025.trmtr', b'pm0025_body_alb.bntx\0'),
                           ('pm0025_body_alb.bntx', b'BNTX\0')],
                          seed=0xCBF29CE484222645)
        names = discover_resource_names(archive, {0:'model.trmdl', 1:'model.trmtr'})
        self.assertEqual(names[1], 'pm0025.trmtr')
        self.assertEqual(names[2], 'pm0025_body_alb.bntx')

    def test_malformed_tables_are_not_animations(self):
        for data in (b'\0'*160, b'BNT', b'fake animation', animation()[:120]):
            self.assertIsNone(content_extension(data))
        malformed = bytearray(animation())
        malformed[112] = 255
        self.assertIsNone(content_extension(malformed))

    def test_ambiguous_basename_hashes_are_not_named(self):
        archive = Archive([('model.trmdl', b'body.bntx\0'),
                           ('body.bntx', b'abc'), ('body.bntx', b'def')])
        self.assertEqual(discover_resource_names(archive, {0:'model.trmdl'}),
                         {0:'model.trmdl'})
