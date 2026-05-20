import hashlib
import tempfile
import unittest
from pathlib import Path

from tools.camera_vqa.dataset.extract_frames import sha256_bytes, sha256_file


class DatasetExtractionTest(unittest.TestCase):
    def test_sha256_bytes_is_stable(self):
        self.assertEqual(sha256_bytes(b"abc"), sha256_bytes(b"abc"))
        self.assertNotEqual(sha256_bytes(b"abc"), sha256_bytes(b"abcd"))

    def test_sha256_file_is_stable(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.bin"
            p.write_bytes(b"hello")
            expected = "sha256:" + hashlib.sha256(b"hello").hexdigest()
            self.assertEqual(sha256_file(p), expected)


if __name__ == "__main__":
    unittest.main()
