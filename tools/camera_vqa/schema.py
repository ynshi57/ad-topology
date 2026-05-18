#!/usr/bin/env python3
"""Schema helpers for Camera VQA sidecars.

The sidecar is deliberately explicit about what is model output versus
what is inferred by ad-topology. In particular, ``function_impact`` uses
``predicted`` and ``actual`` fields so a dependency-matrix recommendation
is never confused with a real vehicle feature state.
"""

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List


SCHEMA_VERSION = 1

VISIBILITY_STATES = {
    "clean",
    "wet",
    "blocked",
    "blur",
    "dark",
    "saturate",
    "frozen",
    "unknown",
}

SEVERITIES = {"none", "low", "medium", "high", "unknown"}
FUNCTION_STATES = {"available", "degrade", "unavailable", "unknown"}
EVIDENCE_TYPES = {
    "model",
    "dependency_matrix",
    "fsm_topic",
    "alarm_topic",
    "planning_topic",
    "not_available",
}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_required(obj: Dict[str, Any], keys: List[str], path: str, errors: List[str]) -> None:
    for key in keys:
        if key not in obj:
            errors.append(f"{path}.{key}: required")


def _check_enum(value: Any, allowed: set, path: str, errors: List[str]) -> None:
    if value not in allowed:
        errors.append(f"{path}: invalid value {value!r}; allowed={sorted(allowed)}")


def _check_confidence(value: Any, path: str, errors: List[str]) -> None:
    if not _is_number(value) or value < 0.0 or value > 1.0:
        errors.append(f"{path}: confidence must be a number in [0, 1], got {value!r}")


def _validate_diagnostic_block(block: Any, path: str, errors: List[str]) -> None:
    if not isinstance(block, dict):
        errors.append(f"{path}: must be object")
        return
    exposed = block.get("exposed", True)
    if not isinstance(exposed, bool):
        errors.append(f"{path}.exposed: must be boolean")
        return
    if exposed is False:
        if not block.get("reason"):
            errors.append(f"{path}.reason: required when exposed=false")
        return

    if "latency_ms" in block and (not _is_number(block["latency_ms"]) or block["latency_ms"] < 0):
        errors.append(f"{path}.latency_ms: must be non-negative number")
    if "output_shape" in block:
        shape = block["output_shape"]
        if not isinstance(shape, list) or not all(isinstance(x, int) and x >= 0 for x in shape):
            errors.append(f"{path}.output_shape: must be list of non-negative integers")
    for key in ("mean", "std", "l2_norm"):
        if key in block and not _is_number(block[key]):
            errors.append(f"{path}.{key}: must be numeric")
    for key in ("nan_count", "inf_count", "token_count"):
        if key in block and (not isinstance(block[key], int) or block[key] < 0):
            errors.append(f"{path}.{key}: must be non-negative integer")
    if path.endswith(".perceiver"):
        _validate_perceiver_block(block, path, errors)


def _validate_perceiver_block(block: Dict[str, Any], path: str, errors: List[str]) -> None:
    """Validate Flamingo/BLIP-style resampler diagnostics."""
    for key in ("num_queries", "layers"):
        if key in block and (not isinstance(block[key], int) or block[key] <= 0):
            errors.append(f"{path}.{key}: must be positive integer")
    if "attention_entropy" in block:
        val = block["attention_entropy"]
        if not _is_number(val) or val < 0:
            errors.append(f"{path}.attention_entropy: must be non-negative number")
    if "per_camera_attention" in block:
        attn = block["per_camera_attention"]
        if not isinstance(attn, dict):
            errors.append(f"{path}.per_camera_attention: must be object")
        else:
            total = 0.0
            for camera, weight in attn.items():
                if not _is_number(weight) or weight < 0.0 or weight > 1.0:
                    errors.append(
                        f"{path}.per_camera_attention.{camera}: must be number in [0, 1]"
                    )
                elif _is_number(weight):
                    total += float(weight)
            # Per-camera contribution is usually normalized. Allow a small
            # tolerance because runtimes may round before emitting JSON.
            if attn and abs(total - 1.0) > 0.05:
                errors.append(
                    f"{path}.per_camera_attention: weights should sum to ~1.0, got {total:.3f}"
                )


def _validate_frame(frame: Any, idx: int, errors: List[str]) -> None:
    path = f"frames[{idx}]"
    if not isinstance(frame, dict):
        errors.append(f"{path}: must be object")
        return

    _check_required(frame, ["timestamp_sec", "input", "diagnostics", "answer"], path, errors)
    if "timestamp_sec" in frame and not _is_number(frame["timestamp_sec"]):
        errors.append(f"{path}.timestamp_sec: must be numeric")

    input_info = frame.get("input", {})
    if not isinstance(input_info, dict):
        errors.append(f"{path}.input: must be object")
    else:
        _check_required(input_info, ["camera_order", "camera_mask", "image_shape"], f"{path}.input", errors)
        if "camera_order" in input_info and not isinstance(input_info["camera_order"], list):
            errors.append(f"{path}.input.camera_order: must be list")
        if "camera_mask" in input_info and not isinstance(input_info["camera_mask"], dict):
            errors.append(f"{path}.input.camera_mask: must be object")
        if "image_shape" in input_info and not isinstance(input_info["image_shape"], dict):
            errors.append(f"{path}.input.image_shape: must be object")

    diagnostics = frame.get("diagnostics", {})
    if not isinstance(diagnostics, dict):
        errors.append(f"{path}.diagnostics: must be object")
    else:
        for name, block in diagnostics.items():
            _validate_diagnostic_block(block, f"{path}.diagnostics.{name}", errors)

    answer = frame.get("answer", {})
    if not isinstance(answer, dict):
        errors.append(f"{path}.answer: must be object")
        return
    parsed = answer.get("parsed", {})
    if not isinstance(parsed, dict):
        errors.append(f"{path}.answer.parsed: must be object")
        return

    camera_states = parsed.get("camera_states", {})
    if not isinstance(camera_states, dict):
        errors.append(f"{path}.answer.parsed.camera_states: must be object")
    else:
        for cam_id, state in camera_states.items():
            state_path = f"{path}.answer.parsed.camera_states.{cam_id}"
            if not isinstance(state, dict):
                errors.append(f"{state_path}: must be object")
                continue
            _check_required(state, ["visibility_state", "severity", "confidence"], state_path, errors)
            if "visibility_state" in state:
                _check_enum(state["visibility_state"], VISIBILITY_STATES, f"{state_path}.visibility_state", errors)
            if "severity" in state:
                _check_enum(state["severity"], SEVERITIES, f"{state_path}.severity", errors)
            if "confidence" in state:
                _check_confidence(state["confidence"], f"{state_path}.confidence", errors)

    impacts = parsed.get("function_impact", {})
    if not isinstance(impacts, dict):
        errors.append(f"{path}.answer.parsed.function_impact: must be object")
    else:
        for function_name, impact in impacts.items():
            impact_path = f"{path}.answer.parsed.function_impact.{function_name}"
            if not isinstance(impact, dict):
                errors.append(f"{impact_path}: must be object")
                continue
            _check_required(impact, ["predicted", "actual", "evidence_type"], impact_path, errors)
            if "predicted" in impact:
                _check_enum(impact["predicted"], FUNCTION_STATES, f"{impact_path}.predicted", errors)
            if "actual" in impact:
                _check_enum(impact["actual"], FUNCTION_STATES, f"{impact_path}.actual", errors)
            if "confidence" in impact:
                _check_confidence(impact["confidence"], f"{impact_path}.confidence", errors)
            if "evidence_type" in impact:
                _check_enum(impact["evidence_type"], EVIDENCE_TYPES, f"{impact_path}.evidence_type", errors)


def validate_sidecar(sidecar: Dict[str, Any]) -> List[str]:
    """Return a list of schema errors. Empty list means valid."""
    errors: List[str] = []
    if not isinstance(sidecar, dict):
        return ["sidecar: must be object"]

    _check_required(
        sidecar,
        ["version", "kind", "runtime", "mcap", "generated_at", "questions", "frames"],
        "sidecar",
        errors,
    )
    if sidecar.get("version") != SCHEMA_VERSION:
        errors.append(f"sidecar.version: expected {SCHEMA_VERSION}, got {sidecar.get('version')!r}")
    if sidecar.get("kind") != "camera_vqa":
        errors.append(f"sidecar.kind: expected 'camera_vqa', got {sidecar.get('kind')!r}")
    if "runtime" in sidecar and not isinstance(sidecar["runtime"], dict):
        errors.append("sidecar.runtime: must be object")
    if "questions" in sidecar and not isinstance(sidecar["questions"], list):
        errors.append("sidecar.questions: must be list")

    frames = sidecar.get("frames", [])
    if not isinstance(frames, list):
        errors.append("sidecar.frames: must be list")
        return errors
    for idx, frame in enumerate(frames):
        _validate_frame(frame, idx, errors)
    return errors


def build_summary(sidecar: Dict[str, Any]) -> Dict[str, Any]:
    """Build a compact summary for UI recent-file cards and done payloads."""
    state_counts: Counter = Counter()
    impact_counts: Counter = Counter()
    schema_invalid = 0

    for frame in sidecar.get("frames", []) or []:
        answer = frame.get("answer", {})
        if answer.get("schema_errors"):
            schema_invalid += 1
        parsed = answer.get("parsed", {})
        for state in (parsed.get("camera_states", {}) or {}).values():
            state_counts[state.get("visibility_state", "unknown")] += 1
        for impact in (parsed.get("function_impact", {}) or {}).values():
            impact_counts[impact.get("predicted", "unknown")] += 1

    return {
        "frames": len(sidecar.get("frames", []) or []),
        "camera_state_counts": dict(sorted(state_counts.items())),
        "predicted_impact_counts": dict(sorted(impact_counts.items())),
        "schema_invalid_frames": schema_invalid,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a camera VQA sidecar.")
    parser.add_argument("--check", required=True, help="Path to *.camera.vqa.json")
    args = parser.parse_args()

    path = Path(args.check)
    with path.open("r", encoding="utf-8") as f:
        sidecar = json.load(f)
    errors = validate_sidecar(sidecar)
    if errors:
        for err in errors:
            print(err)
        return 1
    print("schema ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
