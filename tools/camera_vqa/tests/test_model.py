import unittest

import torch

from tools.camera_vqa.model import MultiCameraPerceiverVqaNet, TinyCameraVqaNet


class CameraVqaModelTest(unittest.TestCase):
    def test_tiny_model_output_shapes(self):
        model = TinyCameraVqaNet().eval()
        out = model(torch.zeros(2, 3, 64, 64))
        self.assertEqual(out["state_logits"].shape[0], 2)
        self.assertEqual(out["severity_logits"].shape[0], 2)

    def test_perceiver_context_output_shapes(self):
        model = MultiCameraPerceiverVqaNet().eval()
        x = torch.zeros(1, 12, 3, 64, 64)
        mask = torch.ones(1, 12, dtype=torch.bool)
        out = model(x, mask)
        self.assertEqual(out["state_logits"].shape[:2], (1, 12))
        self.assertEqual(out["severity_logits"].shape[:2], (1, 12))
        self.assertEqual(out["attention"].shape[-1], 12)


if __name__ == "__main__":
    unittest.main()
