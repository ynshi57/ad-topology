"""Adapter for atlas_data_product_line prompt_fanout outputs.

This module is intentionally tolerant about prompt_fanout's output file layout:
the tool may emit nested JSON files under an output directory. We recursively
scan JSON payloads for camera-name keys and normalize known task values into
the Camera VQA sidecar schema.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Tuple

from tools.camera_vqa.mcap_frames import ATLAS_CAMERA_ORDER
from .base import CameraVqaBatch
from tools.camera_vqa.schema import SCHEMA_VERSION, build_summary, validate_sidecar


SUPPORTED_TASKS = {"failsafe_dirty", "failsafe_exposure", "quality_v4_2class"}

DIRTY_STATES = {"clean", "wet", "blocked", "blur"}
EXPOSURE_STATES = {"ok", "dark", "saturate", "exposure_fault"}
QUALITY_STATES = {"good", "bad", "null"}


class PromptFanoutRuntime:
    """Batch-oriented prompt_fanout adapter exposed through the runtime API.

    `detect.py` calls runtimes per sampled batch. prompt_fanout itself is
    batch-oriented, so this class mainly provides a clear not-configured
    behavior for direct runtime use. The server endpoint below is the primary
    integration path.
    """

    def __init__(self, config: Dict):
        self.config = config

    def infer(self, batch: CameraVqaBatch, _questions: List[str]) -> Dict:
        cfg = dict(self.config)
        cfg["mcap_path"] = batch.mcap_path
        cfg.setdefault("frame_indices", "0")
        result = run_prompt_fanout(cfg)
        predictions = result["predictions"]
        raw_files = result["raw_files"]
        task = cfg.get("task", "failsafe_dirty")
        model = cfg.get("model", "qwen3-vl-8b")
        camera_states = {
            cam: normalize_prompt_value(task, predictions.get(cam, "unknown"))
            for cam in ATLAS_CAMERA_ORDER
        }
        parsed = {"camera_states": camera_states, "function_impact": {}}
        return {
            "runtime": {"name": "prompt_fanout", "mode": "prompt_fanout", "model": model, "task": task},
            "diagnostics": {
                "prompt_fanout": {
                    "name": "atlas_data.prompt_fanout",
                    "exposed": True,
                    "latency_ms": 0.0,
                    "model": model,
                    "task": task,
                    "raw_files": raw_files,
                    "output_shape": [len(predictions)],
                },
                "decoder": {"name": model, "exposed": True, "latency_ms": 0.0, "schema_valid": True},
            },
            "answer": {
                "raw": json.dumps(predictions, ensure_ascii=False),
                "parsed": parsed,
                "schema_errors": [],
            },
        }


def normalize_prompt_value(task: str, value) -> Dict:
    raw = str(value).strip().lower() if value is not None else "unknown"
    if task == "failsafe_dirty":
        state = raw if raw in DIRTY_STATES else "unknown"
        severity = "none" if state == "clean" else ("unknown" if state == "unknown" else "medium")
        return {
            "visibility_state": state,
            "severity": severity,
            "confidence": 0.0,
            "source": "prompt_fanout",
            "review_status": "pending",
            "teacher_raw_answer": raw,
        }
    if task == "failsafe_exposure":
        exposure = raw if raw in EXPOSURE_STATES else "unknown"
        if exposure == "ok":
            state = "clean"
        elif exposure in {"dark", "saturate"}:
            state = exposure
        elif exposure == "exposure_fault":
            state = "unknown"
        else:
            state = "unknown"
        severity = "none" if state == "clean" else ("unknown" if state == "unknown" else "medium")
        return {
            "visibility_state": state,
            "severity": severity,
            "confidence": 0.0,
            "source": "prompt_fanout",
            "review_status": "pending",
            "teacher_raw_answer": raw,
            "exposure_state": exposure,
        }
    if task == "quality_v4_2class":
        quality = raw if raw in QUALITY_STATES else "null"
        state = "clean" if quality == "good" else "unknown"
        severity = "none" if quality == "good" else "unknown"
        return {
            "visibility_state": state,
            "severity": severity,
            "confidence": 0.0,
            "source": "prompt_fanout",
            "review_status": "pending",
            "teacher_raw_answer": raw,
            "quality_state": quality,
        }
    raise ValueError(f"unsupported prompt_fanout task: {task}")


def _walk_json(obj, out: Dict[str, str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ATLAS_CAMERA_ORDER and not isinstance(v, (dict, list)):
                out[k] = v
            else:
                _walk_json(v, out)
    elif isinstance(obj, list):
        for item in obj:
            _walk_json(item, out)


def extract_camera_predictions(payload) -> Dict[str, str]:
    out: Dict[str, str] = {}
    _walk_json(payload, out)
    return out


def load_prompt_fanout_predictions(output_dir: str) -> Tuple[Dict[str, str], List[str]]:
    predictions: Dict[str, str] = {}
    raw_files: List[str] = []
    for path in Path(output_dir).rglob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        raw_files.append(str(path))
        predictions.update(extract_camera_predictions(payload))
    return predictions, raw_files


def build_prompt_sidecar(
    *,
    mcap_path: str,
    output_path: str,
    task: str,
    model: str,
    predictions: Dict[str, str],
    raw_files: List[str],
    frame_indices: str,
) -> Dict:
    camera_states = {
        cam: normalize_prompt_value(task, predictions.get(cam, "unknown"))
        for cam in ATLAS_CAMERA_ORDER
    }
    frame = {
        "timestamp_sec": 0.0,
        "log_time_ns": 0,
        "input": {
            "camera_order": ATLAS_CAMERA_ORDER,
            "camera_mask": {cam: cam in predictions for cam in ATLAS_CAMERA_ORDER},
            "image_shape": {},
            "missing_cameras": [cam for cam in ATLAS_CAMERA_ORDER if cam not in predictions],
        },
        "diagnostics": {
            "prompt_fanout": {
                "name": "atlas_data.prompt_fanout",
                "exposed": True,
                "latency_ms": 0.0,
                "task": task,
                "model": model,
                "frame_indices": frame_indices,
                "raw_files": raw_files,
                "output_shape": [len(predictions)],
            },
            "decoder": {
                "name": model,
                "exposed": True,
                "latency_ms": 0.0,
                "schema_valid": True,
            },
        },
        "answer": {
            "raw": json.dumps(predictions, ensure_ascii=False),
            "parsed": {
                "camera_states": camera_states,
                "function_impact": {},
            },
            "schema_errors": [],
        },
    }
    sidecar = {
        "version": SCHEMA_VERSION,
        "kind": "camera_vqa",
        "model": "prompt_fanout",
        "runtime": {
            "name": "prompt_fanout",
            "mode": "prompt_fanout",
            "model": model,
            "task": task,
        },
        "mcap": mcap_path,
        "output": output_path,
        "generated_at": "",
        "questions": [task],
        "summary": {},
        "frames": [frame],
    }
    sidecar["summary"] = build_summary(sidecar)
    errors = validate_sidecar(sidecar)
    frame["answer"]["schema_errors"] = errors
    return sidecar


def run_prompt_fanout(config: Dict) -> Dict:
    repo = config.get("repo_path")
    python = config.get("python_path")
    mcap_path = config.get("mcap_path")
    model = config.get("model", "qwen3-vl-8b")
    task = config.get("task", "failsafe_dirty")
    frame_indices = config.get("frame_indices", "0")
    output_dir = config.get("output_dir")
    task_args = config.get("task_args", "")
    if task not in SUPPORTED_TASKS:
        raise RuntimeError(f"unsupported prompt_fanout task: {task}")
    if not repo or not os.path.isdir(repo):
        raise RuntimeError("prompt_fanout runtime not configured: repoPath is required")
    if not python or not os.path.exists(python):
        raise RuntimeError("prompt_fanout runtime not configured: pythonPath is required")
    if not mcap_path or not os.path.exists(mcap_path):
        raise RuntimeError(f"mcapPath not found: {mcap_path}")
    output_dir = output_dir or tempfile.mkdtemp(prefix="prompt-fanout-")
    cmd = [
        python,
        "-m",
        "atlas_data.atlas.prompt_fanout",
        "--inputs",
        mcap_path,
        "--frame_indices",
        frame_indices,
        "--models",
        model,
        "--task",
        task,
        "--output_dir",
        output_dir,
    ]
    if task_args:
        cmd.extend(["--task_args", task_args])
    env = os.environ.copy()
    env["PYTHONPATH"] = repo + (":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    proc = subprocess.run(cmd, cwd=repo, text=True, capture_output=True, env=env, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"prompt_fanout failed code={proc.returncode}: {proc.stderr[-1000:]}")
    predictions, raw_files = load_prompt_fanout_predictions(output_dir)
    if not predictions:
        raise RuntimeError(f"prompt_fanout produced no camera predictions under {output_dir}")
    return {
        "output_dir": output_dir,
        "predictions": predictions,
        "raw_files": raw_files,
        "stdout": proc.stdout[-2000:],
        "stderr": proc.stderr[-2000:],
    }
