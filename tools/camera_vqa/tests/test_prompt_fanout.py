import json
import tempfile
import unittest
from pathlib import Path

from tools.camera_vqa.runtime.prompt_fanout import (
    build_prompt_sidecar,
    extract_camera_predictions,
    load_prompt_fanout_predictions,
    normalize_prompt_value,
)
from tools.camera_vqa.schema import validate_sidecar


class PromptFanoutAdapterTest(unittest.TestCase):
    def test_normalizes_failsafe_dirty_values(self):
        self.assertEqual(normalize_prompt_value("failsafe_dirty", "wet")["visibility_state"], "wet")
        self.assertEqual(normalize_prompt_value("failsafe_dirty", "clean")["severity"], "none")
        self.assertEqual(normalize_prompt_value("failsafe_dirty", "nonsense")["visibility_state"], "unknown")

    def test_extracts_camera_predictions_from_nested_json(self):
        payload = {"x": [{"front_left_1": "wet"}, {"nested": {"front_right_10": "clean"}}]}
        preds = extract_camera_predictions(payload)
        self.assertEqual(preds["front_left_1"], "wet")
        self.assertEqual(preds["front_right_10"], "clean")

    def test_loads_prompt_fanout_predictions_from_output_dir(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "result.json"
            p.write_text(json.dumps({"front_left_1": "wet"}), encoding="utf-8")
            preds, raw_files = load_prompt_fanout_predictions(d)
        self.assertEqual(preds["front_left_1"], "wet")
        self.assertEqual(len(raw_files), 1)

    def test_build_prompt_sidecar_is_schema_valid(self):
        sidecar = build_prompt_sidecar(
            mcap_path="/tmp/foo.camera.mcap",
            output_path="/tmp/foo.camera.vqa.json",
            task="failsafe_dirty",
            model="qwen3-vl-8b",
            predictions={"front_left_1": "wet", "front_right_10": "clean"},
            raw_files=["/tmp/out/result.json"],
            frame_indices="0,30",
        )
        self.assertEqual(validate_sidecar(sidecar), [])
        st = sidecar["frames"][0]["answer"]["parsed"]["camera_states"]["front_left_1"]
        self.assertEqual(st["source"], "prompt_fanout")
        self.assertEqual(st["review_status"], "pending")


if __name__ == "__main__":
    unittest.main()
