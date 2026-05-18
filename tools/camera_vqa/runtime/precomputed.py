"""Adapter for model-team precomputed Atlas/cosmos outputs."""

import json
from typing import Dict, List

from .base import CameraVqaBatch


class PrecomputedRuntime:
    def __init__(self, config: Dict):
        path = config.get("path")
        if not path:
            raise ValueError("precomputed runtime requires config.path")
        self.path = path
        with open(path, "r", encoding="utf-8") as f:
            self.payload = json.load(f)

    def infer(self, batch: CameraVqaBatch, _questions: List[str]) -> Dict:
        frames = self.payload.get("frames", [])
        if not frames:
            raise RuntimeError(f"precomputed runtime has no frames: {self.path}")

        best = min(
            frames,
            key=lambda f: abs(float(f.get("timestamp_sec", 0.0)) - batch.timestamp_sec),
        )
        return {
            "runtime": self.payload.get("runtime", {
                "name": "precomputed",
                "version": "unknown",
                "mode": "precomputed",
            }),
            "diagnostics": best.get("diagnostics", {}),
            "answer": best.get("answer", {
                "raw": "{}",
                "parsed": {"camera_states": {}, "function_impact": {}},
                "schema_errors": [],
            }),
        }
