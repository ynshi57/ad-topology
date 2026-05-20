#!/usr/bin/env python3
"""Camera VQA/Atlas diagnostics sidecar generator.

This CLI is the ad-topology boundary to real Atlas+vlm_adapter+cosmos/Qwen
runtimes. It samples camera.mcap timestamps, builds Atlas-style camera masks,
calls a pluggable runtime adapter, validates the structured answer, and writes
``<input>.camera.vqa.json``.
"""

import argparse
import datetime
import json
import os
import sys
from typing import Dict, List

from mcap.reader import make_reader

from tools.camera_vqa.mcap_frames import (
    ATLAS_CAMERA_ORDER,
    build_camera_mask,
    build_input_record,
    summarize_mcap_cameras,
)
from tools.camera_vqa.runtime.base import CameraVqaBatch, load_runtime
from tools.camera_vqa.schema import SCHEMA_VERSION, build_summary, validate_sidecar


DEFAULT_QUESTIONS = ["camera_state", "exposure_fault", "function_impact"]


def default_output_path(mcap_path: str) -> str:
    base = mcap_path[:-5] if mcap_path.lower().endswith(".mcap") else mcap_path
    return base + ".vqa.json" if base.endswith(".camera") else base + ".camera.vqa.json"


def _iso_now() -> str:
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _mcap_time_window(mcap_path: str):
    with open(mcap_path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        if not summary or not summary.statistics:
            raise RuntimeError(f"MCAP has no summary/statistics: {mcap_path}")
        stats = summary.statistics
        return int(stats.message_start_time), int(stats.message_end_time)


def _sample_times_ns(start_ns: int, end_ns: int, interval_sec: float, max_samples: int) -> List[int]:
    if end_ns < start_ns:
        return [start_ns]
    interval_ns = max(1, int(interval_sec * 1e9))
    times = []
    t = start_ns
    while t <= end_ns and len(times) < max_samples:
        times.append(t)
        t += interval_ns
    if not times:
        times.append(start_ns)
    return times


def _present_cameras_from_summary(mcap_path: str) -> Dict[str, Dict]:
    grouped = summarize_mcap_cameras(mcap_path)
    present = {}
    for cam_id, info in grouped.items():
        if info.get("video_topic"):
            # Real image dimensions are runtime/model-contract dependent; the
            # extractor exposes unknown dimensions as absent unless a runtime
            # later populates them. This avoids treating missing metadata as
            # actual black/zero images.
            present[cam_id] = {
                "video_topic": info.get("video_topic"),
                "video_schema": info.get("video_schema"),
                "video_count": info.get("video_count", 0),
            }
    return present


def make_sidecar(
    mcap_path: str,
    output_path: str,
    questions: List[str],
    runtime_result: Dict,
    frames: List[Dict],
) -> Dict:
    sidecar = {
        "version": SCHEMA_VERSION,
        "kind": "camera_vqa",
        "model": runtime_result.get("runtime", {}).get("name", "unknown"),
        "runtime": runtime_result.get("runtime", {}),
        "mcap": mcap_path,
        "output": output_path,
        "generated_at": _iso_now(),
        "questions": questions,
        "summary": {},
        "frames": frames,
    }
    sidecar["summary"] = build_summary(sidecar)
    return sidecar


def _runtime_config(args) -> Dict:
    cfg = {}
    if args.runtime_command:
        cfg["command"] = args.runtime_command
    if args.runtime_url:
        cfg["url"] = args.runtime_url
    if args.precomputed:
        cfg["path"] = args.precomputed
    if args.model_path:
        cfg["model_path"] = args.model_path
    if args.device:
        cfg["device"] = args.device
    cfg["stability_runs"] = args.stability_runs
    cfg["timeout_sec"] = args.timeout_sec
    return cfg


def run(args) -> Dict:
    if not os.path.exists(args.mcap):
        raise FileNotFoundError(args.mcap)
    output_path = args.output or default_output_path(args.mcap)
    questions = [q.strip() for q in args.questions.split(",") if q.strip()] or DEFAULT_QUESTIONS

    print("=" * 70)
    print("Camera VQA / Atlas diagnostics")
    print("=" * 70)
    print(f"  input:    {args.mcap}")
    print(f"  output:   {output_path}")
    print(f"  runtime:  {args.runtime}")
    print(f"  questions:{','.join(questions)}")

    start_ns, end_ns = _mcap_time_window(args.mcap)
    sample_ns = _sample_times_ns(start_ns, end_ns, args.sample_interval_sec, args.max_samples)
    present = _present_cameras_from_summary(args.mcap)
    mask, missing, _image_shape = build_camera_mask(present, ATLAS_CAMERA_ORDER)
    print(f"  cameras:  present={sum(1 for v in mask.values() if v)} missing={len(missing)}")
    if missing:
        print(f"  missing:  {', '.join(missing)}")

    runtime = load_runtime(args.runtime, _runtime_config(args))
    frames = []
    last_result = {"runtime": {"name": args.runtime, "mode": args.runtime}}
    for idx, ts_ns in enumerate(sample_ns, start=1):
        timestamp_sec = (ts_ns - start_ns) / 1e9
        input_block = build_input_record(timestamp_sec, ts_ns, present, ATLAS_CAMERA_ORDER)
        batch = CameraVqaBatch(
            timestamp_sec=timestamp_sec,
            log_time_ns=ts_ns,
            mcap_path=args.mcap,
            input=input_block,
        )
        print(f"  sample {idx}/{len(sample_ns)}: t={timestamp_sec:.2f}s")
        result = runtime.infer(batch, questions)
        last_result = result
        frame = {
            "timestamp_sec": timestamp_sec,
            "log_time_ns": ts_ns,
            "input": input_block,
            "diagnostics": result.get("diagnostics", {}),
            "answer": result.get("answer", {
                "raw": "{}",
                "parsed": {"camera_states": {}, "function_impact": {}},
                "schema_errors": [],
            }),
        }
        # Validate at frame granularity by wrapping in a transient sidecar.
        transient = make_sidecar(args.mcap, output_path, questions, result, [frame])
        errors = validate_sidecar(transient)
        frame["answer"]["schema_errors"] = errors
        if errors:
            print(f"    schema errors: {len(errors)}")
        frames.append(frame)

    sidecar = make_sidecar(args.mcap, output_path, questions, last_result, frames)
    errors = validate_sidecar(sidecar)
    if errors:
        print(f"  final schema errors: {len(errors)}")
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=2)
    print(f"Done. frames={len(frames)} schema_errors={len(errors)}")
    return sidecar


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcap", required=True, help="Input camera.mcap path")
    parser.add_argument("--output", help="Output *.camera.vqa.json path")
    parser.add_argument("--runtime", default="fixture",
                        choices=["fixture", "external", "http", "precomputed", "local_model"])
    parser.add_argument("--runtime-command", help="External runtime command")
    parser.add_argument("--runtime-url", help="HTTP runtime URL")
    parser.add_argument("--precomputed", help="Precomputed runtime JSON path")
    parser.add_argument("--model-path", help="Local Camera VQA model.pt path")
    parser.add_argument("--device", default="cpu", help="Local model device")
    parser.add_argument("--questions", default=",".join(DEFAULT_QUESTIONS))
    parser.add_argument("--sample-interval-sec", type=float, default=10.0)
    parser.add_argument("--max-samples", type=int, default=8)
    parser.add_argument("--timeout-sec", type=float, default=120.0)
    parser.add_argument("--stability-runs", type=int, default=3)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    try:
        run(parse_args(argv))
        return 0
    except Exception as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
