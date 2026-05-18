"""External command adapter for real Atlas/cosmos runtimes.

The command receives two positional arguments:
  1. input JSON path
  2. output JSON path

This file exchange keeps ad-topology decoupled from the model package.
"""

import json
import os
import subprocess
import tempfile
from typing import Dict, List

from .base import CameraVqaBatch


class ExternalRuntime:
    def __init__(self, config: Dict):
        self.command = config.get("command")
        self.timeout_sec = float(config.get("timeout_sec", 120))

    def infer(self, batch: CameraVqaBatch, questions: List[str]) -> Dict:
        if not self.command or not os.path.exists(self.command):
            raise RuntimeError(f"external runtime command not found: {self.command}")

        payload = {
            "mcap_path": batch.mcap_path,
            "timestamp_sec": batch.timestamp_sec,
            "log_time_ns": batch.log_time_ns,
            "input": batch.input,
            "questions": questions,
        }
        with tempfile.TemporaryDirectory(prefix="camera-vqa-external-") as d:
            input_path = os.path.join(d, "input.json")
            output_path = os.path.join(d, "output.json")
            with open(input_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)

            proc = subprocess.run(
                [self.command, input_path, output_path],
                text=True,
                capture_output=True,
                timeout=self.timeout_sec,
                check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    "external runtime failed "
                    f"(code={proc.returncode}): {proc.stderr[-500:]}"
                )
            if not os.path.exists(output_path):
                raise RuntimeError(f"external runtime did not write {output_path}")
            with open(output_path, "r", encoding="utf-8") as f:
                return json.load(f)
