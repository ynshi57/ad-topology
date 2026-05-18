import json
import tempfile
import unittest
from pathlib import Path

from tools.camera_vqa.runtime.base import CameraVqaBatch, load_runtime
from tools.camera_vqa.schema import validate_sidecar


def make_batch():
    return CameraVqaBatch(
        timestamp_sec=12.34,
        log_time_ns=12340000000,
        mcap_path="/tmp/example.camera.mcap",
        input={
            "camera_order": ["front_middle_0", "front_left_1"],
            "camera_mask": {"front_middle_0": True, "front_left_1": True},
            "image_shape": {
                "front_middle_0": [960, 732, 3],
                "front_left_1": [960, 732, 3],
            },
            "missing_cameras": [],
        },
    )


class RuntimeAdapterTest(unittest.TestCase):
    def test_fixture_runtime_returns_schema_valid_answer(self):
        runtime = load_runtime("fixture", {})

        result = runtime.infer(make_batch(), ["camera_state", "function_impact"])

        self.assertEqual(result["runtime"]["mode"], "fixture")
        self.assertTrue(result["runtime"]["non_production"])
        self.assertIn("diagnostics", result)
        self.assertIn("answer", result)
        sidecar = {
            "version": 1,
            "kind": "camera_vqa",
            "model": "fixture-camera-vqa",
            "runtime": result["runtime"],
            "mcap": "/tmp/example.camera.mcap",
            "generated_at": "2026-05-18T08:00:00Z",
            "questions": ["camera_state", "function_impact"],
            "summary": {},
            "frames": [{
                "timestamp_sec": 12.34,
                "log_time_ns": 12340000000,
                "input": make_batch().input,
                "diagnostics": result["diagnostics"],
                "answer": result["answer"],
            }],
        }
        self.assertEqual(validate_sidecar(sidecar), [])

    def test_external_runtime_fails_clearly_when_command_missing(self):
        runtime = load_runtime("external", {"command": "/no/such/atlas_vqa_runtime"})

        with self.assertRaisesRegex(RuntimeError, "external runtime command not found"):
            runtime.infer(make_batch(), ["camera_state"])

    def test_precomputed_runtime_loads_matching_frame(self):
        payload = {
            "frames": [
                {
                    "timestamp_sec": 12.34,
                    "diagnostics": {"vlm_adapter": {"exposed": False, "reason": "unit_test"}},
                    "answer": {
                        "raw": "{}",
                        "parsed": {"camera_states": {}, "function_impact": {}},
                        "schema_errors": [],
                    },
                }
            ]
        }
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "precomputed.json"
            p.write_text(json.dumps(payload), encoding="utf-8")
            runtime = load_runtime("precomputed", {"path": str(p)})

            result = runtime.infer(make_batch(), ["camera_state"])

        self.assertEqual(result["diagnostics"]["vlm_adapter"]["reason"], "unit_test")


if __name__ == "__main__":
    unittest.main()
