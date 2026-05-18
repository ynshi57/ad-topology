"""Runtime adapter boundary for Camera VQA.

The real Atlas/cosmos model is intentionally behind this interface. ad-topology
does not depend on a particular model package; it prepares camera batches and
expects a structured diagnostics/answer result.
"""

from dataclasses import dataclass
from typing import Dict, List, Protocol


@dataclass(frozen=True)
class CameraVqaBatch:
    timestamp_sec: float
    log_time_ns: int
    mcap_path: str
    input: Dict


class CameraVqaRuntime(Protocol):
    def infer(self, batch: CameraVqaBatch, questions: List[str]) -> Dict:
        ...


def load_runtime(name: str, config: Dict) -> CameraVqaRuntime:
    if name == "fixture":
        from .fixture import FixtureRuntime

        return FixtureRuntime(config)
    if name == "external":
        from .external import ExternalRuntime

        return ExternalRuntime(config)
    if name == "http":
        from .http import HttpRuntime

        return HttpRuntime(config)
    if name == "precomputed":
        from .precomputed import PrecomputedRuntime

        return PrecomputedRuntime(config)
    raise ValueError(f"unknown camera VQA runtime: {name}")
