"""Pure synthetic tests for Switch BucketTree storage. No game data/keys."""
import struct
import unittest

from gfpak_open.bucket_tree import BucketTree, BucketTreeError


def tree(entries, *, compressed=False, end=32):
    raw = bytearray(0x8000)
    struct.pack_into("<IIQ", raw, 0, 0, 1, end)
    struct.pack_into("<IIQ", raw, 0x4000, 0, len(entries), end)
    for i, (virtual, physical, code) in enumerate(entries):
        if compressed:
            codec, level, stored = code
            struct.pack_into("<qqBb2sI", raw, 0x4010 + 24*i,
                             virtual, physical, codec, level, bytes(2), stored)
        else:
            struct.pack_into("<QQI", raw, 0x4010 + 20*i, virtual, physical, code)
    return BucketTree(lambda at, length: raw[at:at+length], len(raw), len(entries),
                      compressed=compressed)


class BucketTreeTests(unittest.TestCase):
    def test_plaintext_sparse_holes_and_indirect_cross_boundary(self):
        table = tree([(0, 4, 0), (8, 0, 1)], end=16)
        source = b"xxxxabcdefgh"
        self.assertEqual(table.read_indirect(0, 16, lambda at, n: source[at:at+n],
                                              sparse=True), b"abcdefgh" + bytes(8))
        self.assertEqual(table.read_indirect(4, 6, lambda at, n: source[at:at+n],
                                              sparse=True), b"efgh" + bytes(2))
        with self.assertRaises(BucketTreeError):
            table.read_indirect(15, 2, lambda at, n: b"")

    def test_patch_original_and_updated_reads(self):
        table = tree([(0, 0, 0), (8, 0, 1)], end=16)
        self.assertEqual(table.read_indirect(0, 16, lambda at, n: b"A" * n,
                                               lambda at, n: b"B" * n),
                         b"A"*8 + b"B"*8)
        with self.assertRaisesRegex(BucketTreeError, "matching"):
            table.read_indirect(8, 4, lambda at, n: b"A"*n)

    def test_uncompressed_and_zero_compressed_storage(self):
        table = tree([(0, 0, (0, 0, 0xffffffff)),
                      (16, 0, (1, 0, 0))], compressed=True, end=32)
        self.assertEqual(table.read_compressed(8, 16, lambda at, n: b"X"*n),
                         b"X"*8 + bytes(8))
        with self.assertRaises(BucketTreeError):
            table.read_compressed(-1, 1, lambda at, n: b"")

    def test_bad_entry_order_is_rejected(self):
        with self.assertRaisesRegex(BucketTreeError, "offsets must increase"):
            tree([(0, 0, 0), (0, 2, 0)], end=32)

    def test_lz4_native_compressed_block(self):
        try:
            import lz4.block
        except ImportError:
            self.skipTest("Native LZ4 not installed")
        message = b"HELLO" * 100
        packed = lz4.block.compress(message, store_size=False)
        table = tree([(0, 0, (3, 0, len(packed)))], compressed=True,
                     end=len(message))
        self.assertEqual(table.read_compressed(30, 21, lambda at, n: packed[at:at+n]),
                         message[30:51])


if __name__ == "__main__":
    unittest.main()

    def test_lz4_block_cache_serves_repeated_small_reads(self):
        try:
            import lz4.block
        except ImportError:
            self.skipTest("Native LZ4 not installed")
        original = bytes(range(256)) * 64
        packed = lz4.block.compress(original, store_size=False)
        table = tree([(0, 0, (3, 0, len(packed)))],
                     compressed=True, end=len(original))
        accesses = []
        def read_data(at, n):
            accesses.append((at, n))
            return packed[at:at+n]
        self.assertEqual(table.read_compressed(1, 32, read_data), original[1:33])
        self.assertEqual(table.read_compressed(4096, 32, read_data), original[4096:4128])
        self.assertEqual(len(accesses), 1, "Repeated pages should not decompress the same block")
        self.assertLessEqual(table._cache_bytes, 24 * 1024 * 1024)
