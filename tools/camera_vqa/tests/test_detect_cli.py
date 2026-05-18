import unittest

from tools.camera_vqa.detect import default_output_path, make_sidecar
from tools.camera_vqa.runtime.base import CameraVqaBatch
from tools.camera_vqa.runtime.fixture import FixtureRuntime
from tools.camera_vqa.schema import validate_sidecar


class CameraVqaDetectCliTest(unittest.TestCase):
    def test_default_output_path_strips_mcap_suffix(self):
        self.assertEqual(
            default_output_path("/data/foo.camera.mcap"),
            "/data/foo.camera.vqa.json",
        )
        self.assertEqual(
            default_output_path("/data/foo"),
            "/data/foo.camera.vqa.json",
        )

    def test_make_sidecar_wraps_runtime_result_into_schema_valid_document(self):
        batch = CameraVqaBatch(
            timestamp_sec=1.0,
            log_time_ns=1000000000,
            mcap_path="/tmp/foo.camera.mcap",
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
        result = FixtureRuntime({}).infer(batch, ["camera_state", "function_impact"])

        sidecar = make_sidecar(
            mcap_path="/tmp/foo.camera.mcap",
            output_path="/tmp/foo.camera.vqa.json",
            questions=["camera_state", "function_impact"],
            runtime_result=result,
            frames=[{
                "timestamp_sec": batch.timestamp_sec,
                "log_time_ns": batch.log_time_ns,
                "input": batch.input,
                "diagnostics": result["diagnostics"],
                "answer": result["answer"],
            }],
        )

        self.assertEqual(validate_sidecar(sidecar), [])
        self.assertEqual(sidecar["summary"]["frames"], 1)
        self.assertEqual(sidecar["runtime"]["mode"], "fixture")


if __name__ == "__main__":
    unittest.main()
