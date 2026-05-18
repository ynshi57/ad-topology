import copy
import unittest

from tools.camera_vqa.schema import (
    SCHEMA_VERSION,
    build_summary,
    validate_sidecar,
)


def make_valid_sidecar():
    return {
        "version": SCHEMA_VERSION,
        "kind": "camera_vqa",
        "model": "fixture-camera-vqa",
        "runtime": {
            "name": "fixture",
            "version": "test",
            "mode": "fixture",
            "non_production": True,
        },
        "mcap": "/tmp/example.camera.mcap",
        "generated_at": "2026-05-18T08:00:00Z",
        "questions": ["camera_state", "function_impact"],
        "summary": {},
        "frames": [
            {
                "timestamp_sec": 12.34,
                "log_time_ns": 12340000000,
                "input": {
                    "camera_order": ["front_middle_0", "front_left_1"],
                    "camera_mask": {
                        "front_middle_0": True,
                        "front_left_1": True,
                    },
                    "image_shape": {
                        "front_middle_0": [960, 732, 3],
                        "front_left_1": [960, 732, 3],
                    },
                    "missing_cameras": [],
                },
                "diagnostics": {
                    "backbone": {
                        "name": "atlas_backbone",
                        "exposed": True,
                        "latency_ms": 40.8,
                        "output_shape": [1, 12, 256, 1024],
                        "dtype": "float16",
                        "mean": 0.002,
                        "std": 0.91,
                        "l2_norm": 512.4,
                        "nan_count": 0,
                        "inf_count": 0,
                    },
                    "vlm_adapter": {
                        "exposed": True,
                        "latency_ms": 1.2,
                        "output_shape": [1, 64, 3584],
                        "token_count": 64,
                        "dtype": "float16",
                        "mean": -0.001,
                        "std": 0.77,
                        "l2_norm": 408.2,
                        "nan_count": 0,
                        "inf_count": 0,
                    },
                    "perceiver": {
                        "name": "flamingo_perceiver_resampler",
                        "exposed": True,
                        "latency_ms": 1.1,
                        "num_queries": 64,
                        "layers": 4,
                        "output_shape": [1, 64, 3584],
                        "attention_entropy": 2.1,
                        "per_camera_attention": {
                            "front_middle_0": 0.48,
                            "front_left_1": 0.52,
                        },
                    },
                    "decoder": {
                        "name": "cosmos7B_qwen2_5_decoder",
                        "latency_ms": 6.3,
                        "prompt_tokens": 23,
                        "output_tokens": 7,
                        "schema_valid": True,
                    },
                },
                "answer": {
                    "raw": "{\"camera_states\": {}}",
                    "parsed": {
                        "camera_states": {
                            "front_left_1": {
                                "visibility_state": "wet",
                                "severity": "medium",
                                "confidence": 0.84,
                            },
                            "front_middle_0": {
                                "visibility_state": "clean",
                                "severity": "none",
                                "confidence": 0.96,
                            },
                        },
                        "function_impact": {
                            "LCC": {
                                "predicted": "degrade",
                                "actual": "unknown",
                                "confidence": 0.72,
                                "basis": ["front_left_1=wet"],
                                "evidence_type": "dependency_matrix",
                            }
                        },
                    },
                    "schema_errors": [],
                },
            }
        ],
    }


class CameraVqaSchemaTest(unittest.TestCase):
    def test_accepts_valid_sidecar_and_builds_summary(self):
        sidecar = make_valid_sidecar()

        errors = validate_sidecar(sidecar)
        summary = build_summary(sidecar)

        self.assertEqual(errors, [])
        self.assertEqual(summary["frames"], 1)
        self.assertEqual(summary["camera_state_counts"]["wet"], 1)
        self.assertEqual(summary["camera_state_counts"]["clean"], 1)
        self.assertEqual(summary["schema_invalid_frames"], 0)

    def test_rejects_invalid_camera_state_enum(self):
        sidecar = make_valid_sidecar()
        sidecar["frames"][0]["answer"]["parsed"]["camera_states"]["front_left_1"][
            "visibility_state"
        ] = "dirty-ish"

        errors = validate_sidecar(sidecar)

        self.assertTrue(any("visibility_state" in e for e in errors))
        self.assertTrue(any("dirty-ish" in e for e in errors))

    def test_requires_reason_when_diagnostics_not_exposed(self):
        sidecar = make_valid_sidecar()
        sidecar["frames"][0]["diagnostics"]["vlm_adapter"] = {
            "exposed": False,
        }

        errors = validate_sidecar(sidecar)

        self.assertTrue(any("reason" in e for e in errors))

    def test_accepts_flamingo_perceiver_diagnostics(self):
        sidecar = make_valid_sidecar()

        errors = validate_sidecar(sidecar)

        self.assertEqual(errors, [])

    def test_rejects_invalid_perceiver_query_count(self):
        sidecar = make_valid_sidecar()
        sidecar["frames"][0]["diagnostics"]["perceiver"]["num_queries"] = 0

        errors = validate_sidecar(sidecar)

        self.assertTrue(any("num_queries" in e for e in errors))

    def test_rejects_invalid_per_camera_attention_weight(self):
        sidecar = make_valid_sidecar()
        sidecar["frames"][0]["diagnostics"]["perceiver"]["per_camera_attention"][
            "front_middle_0"
        ] = 1.4

        errors = validate_sidecar(sidecar)

        self.assertTrue(any("per_camera_attention" in e for e in errors))

    def test_unknown_actual_function_state_is_allowed_but_not_off(self):
        sidecar = make_valid_sidecar()
        impact = sidecar["frames"][0]["answer"]["parsed"]["function_impact"]["LCC"]
        impact["actual"] = "unknown"

        errors = validate_sidecar(sidecar)

        self.assertEqual(errors, [])

    def test_rejects_invalid_actual_function_state(self):
        sidecar = make_valid_sidecar()
        impact = sidecar["frames"][0]["answer"]["parsed"]["function_impact"]["LCC"]
        impact["actual"] = "probably_off"

        errors = validate_sidecar(sidecar)

        self.assertTrue(any("actual" in e for e in errors))

    def test_validation_does_not_mutate_input(self):
        sidecar = make_valid_sidecar()
        original = copy.deepcopy(sidecar)

        validate_sidecar(sidecar)

        self.assertEqual(sidecar, original)


if __name__ == "__main__":
    unittest.main()
