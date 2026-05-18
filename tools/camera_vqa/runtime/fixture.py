"""Deterministic non-production runtime for UI and schema testing."""

import json
from typing import Dict, List

from .base import CameraVqaBatch


class FixtureRuntime:
    def __init__(self, _config: Dict):
        pass

    def infer(self, batch: CameraVqaBatch, questions: List[str]) -> Dict:
        camera_states = {}
        for cam_id, present in batch.input.get("camera_mask", {}).items():
            if not present:
                camera_states[cam_id] = {
                    "visibility_state": "unknown",
                    "severity": "unknown",
                    "confidence": 0.0,
                }
            elif cam_id == "front_left_1":
                camera_states[cam_id] = {
                    "visibility_state": "wet",
                    "severity": "medium",
                    "confidence": 0.84,
                }
            else:
                camera_states[cam_id] = {
                    "visibility_state": "clean",
                    "severity": "none",
                    "confidence": 0.96,
                }

        parsed = {
            "camera_states": camera_states,
            "function_impact": {
                "LCC": {
                    "predicted": "degrade",
                    "actual": "unknown",
                    "confidence": 0.72,
                    "basis": ["front_left_1=wet"],
                    "evidence_type": "dependency_matrix",
                }
            } if "function_impact" in questions else {},
        }
        return {
            "runtime": {
                "name": "fixture-camera-vqa",
                "version": "test",
                "mode": "fixture",
                "non_production": True,
            },
            "diagnostics": {
                "backbone": {
                    "name": "atlas_backbone_fixture",
                    "exposed": True,
                    "latency_ms": 0.1,
                    "output_shape": [1, 12, 8, 16],
                    "dtype": "float32",
                    "mean": 0.0,
                    "std": 1.0,
                    "l2_norm": 1.0,
                    "nan_count": 0,
                    "inf_count": 0,
                },
                "vlm_adapter": {
                    "exposed": True,
                    "latency_ms": 0.1,
                    "output_shape": [1, 64, 3584],
                    "token_count": 64,
                    "dtype": "float32",
                    "mean": 0.0,
                    "std": 1.0,
                    "l2_norm": 1.0,
                    "nan_count": 0,
                    "inf_count": 0,
                },
                "perceiver": {
                    "name": "flamingo_perceiver_resampler_fixture",
                    "exposed": True,
                    "latency_ms": 0.1,
                    "num_queries": 64,
                    "layers": 4,
                    "output_shape": [1, 64, 3584],
                    "attention_entropy": 2.1,
                    "per_camera_attention": {
                        cam_id: round(1.0 / max(1, len(batch.input.get("camera_mask", {}))), 4)
                        for cam_id in batch.input.get("camera_mask", {})
                    },
                },
                "decoder": {
                    "name": "fixture_decoder",
                    "latency_ms": 0.1,
                    "prompt_tokens": len(questions),
                    "output_tokens": 4,
                    "schema_valid": True,
                },
            },
            "answer": {
                "raw": json.dumps(parsed, ensure_ascii=False),
                "parsed": parsed,
                "schema_errors": [],
            },
        }
