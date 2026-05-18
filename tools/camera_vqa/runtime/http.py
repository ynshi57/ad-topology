"""HTTP adapter for Atlas/cosmos runtimes served out-of-process."""

import json
import urllib.error
import urllib.request
from typing import Dict, List

from .base import CameraVqaBatch


class HttpRuntime:
    def __init__(self, config: Dict):
        self.url = config.get("url")
        self.timeout_sec = float(config.get("timeout_sec", 120))
        if not self.url:
            raise ValueError("http runtime requires config.url")

    def infer(self, batch: CameraVqaBatch, questions: List[str]) -> Dict:
        payload = {
            "mcap_path": batch.mcap_path,
            "timestamp_sec": batch.timestamp_sec,
            "log_time_ns": batch.log_time_ns,
            "input": batch.input,
            "questions": questions,
        }
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as err:
            raise RuntimeError(f"http runtime request failed: {err}") from err
