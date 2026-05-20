#!/usr/bin/env python3
"""Extract deterministic Camera VQA frame datasets from camera.mcap files."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Dict, List

from mcap.reader import make_reader

from tools.camera_vqa.image_decode import decode_message_image
from tools.camera_vqa.mcap_frames import ATLAS_CAMERA_ORDER, camera_name_from_topic


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def iso_now() -> str:
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def collect_samples_at_targets(mcap_path: str, targets: List[int]) -> List[Dict]:
    """Return decoded RGB samples for explicit target log times.

    For each camera and target sample time, take the first frame at-or-after
    the target. This is deterministic for a given MCAP and avoids using wall
    clock or random choices.
    """
    samples = []
    with open(mcap_path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        if not summary or not summary.statistics:
            raise RuntimeError(f"MCAP has no summary/statistics: {mcap_path}")
        start_ns = int(summary.statistics.message_start_time)
        by_camera_target: Dict[str, int] = {}
        for schema, channel, msg in reader.iter_messages():
            cam = camera_name_from_topic(channel.topic)
            if cam not in ATLAS_CAMERA_ORDER:
                continue
            if by_camera_target.get(cam, 0) >= len(targets):
                continue
            target = targets[by_camera_target.get(cam, 0)]
            if int(msg.log_time) < target:
                continue
            rgb = decode_message_image(schema.name if schema else "", msg.data)
            if rgb is None:
                continue
            samples.append({
                "camera_id": cam,
                "topic": channel.topic,
                "schema": schema.name if schema else "",
                "target_time_ns": int(target),
                "log_time_ns": int(msg.log_time),
                "timestamp_sec": (int(msg.log_time) - start_ns) / 1e9,
                "rgb": rgb,
                "raw_hash": sha256_bytes(msg.data),
            })
            by_camera_target[cam] = by_camera_target.get(cam, 0) + 1
    samples.sort(key=lambda x: (x["log_time_ns"], x["camera_id"]))
    return samples


def collect_samples(mcap_path: str, sample_interval_sec: float, max_samples: int) -> List[Dict]:
    """Return decoded RGB samples near a deterministic timestamp grid."""
    with open(mcap_path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        if not summary or not summary.statistics:
            raise RuntimeError(f"MCAP has no summary/statistics: {mcap_path}")
        start_ns = int(summary.statistics.message_start_time)
        end_ns = int(summary.statistics.message_end_time)
    interval_ns = max(1, int(sample_interval_sec * 1e9))
    targets = []
    t = start_ns
    while t <= end_ns and len(targets) < max_samples:
        targets.append(t)
        t += interval_ns
    if not targets:
        targets = [start_ns]
    return collect_samples_at_targets(mcap_path, targets)


def write_dataset(mcap_path: str, output_dir: str, dataset_id: str,
                  sample_interval_sec: float, max_samples: int) -> Dict:
    from PIL import Image

    root = Path(output_dir).resolve() / dataset_id
    frames_dir = root / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.jsonl"
    metadata_path = root / "metadata.json"

    samples = collect_samples(mcap_path, sample_interval_sec, max_samples)
    manifest_rows = []
    with manifest_path.open("w", encoding="utf-8") as mf:
        for sample in samples:
            ts_dir = frames_dir / f"{sample['log_time_ns']}"
            ts_dir.mkdir(parents=True, exist_ok=True)
            image_path = ts_dir / f"{sample['camera_id']}.png"
            Image.fromarray(sample["rgb"]).save(image_path, format="PNG")
            row = {
                "dataset_id": dataset_id,
                "mcap_path": mcap_path,
                "camera_id": sample["camera_id"],
                "topic": sample["topic"],
                "schema": sample["schema"],
                "timestamp_sec": sample["timestamp_sec"],
                "log_time_ns": sample["log_time_ns"],
                "target_time_ns": sample["target_time_ns"],
                "image_path": str(image_path),
                "image_sha256": sha256_file(image_path),
                "raw_message_sha256": sample["raw_hash"],
                "camera_mask": True,
                "state": None,
                "severity": None,
            }
            manifest_rows.append(row)
            mf.write(json.dumps(row, ensure_ascii=False) + "\n")

    metadata = {
        "dataset_id": dataset_id,
        "created_at": iso_now(),
        "mcap_path": mcap_path,
        "mcap_sha256": sha256_file(Path(mcap_path)),
        "sample_interval_sec": sample_interval_sec,
        "max_samples": max_samples,
        "camera_order": ATLAS_CAMERA_ORDER,
        "frames": len(manifest_rows),
        "manifest_path": str(manifest_path),
        "preprocess": {
            "frame_format": "png",
            "color": "RGB",
            "production": False,
            "reason": "offline MCAP frame extraction, not vehicle image pipeline",
        },
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"root": str(root), "manifest": str(manifest_path), "metadata": str(metadata_path), "frames": len(manifest_rows)}


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mcap", required=True)
    ap.add_argument("--output-dir", default="/home/caros/workspace/camera_vqa_dataset")
    ap.add_argument("--dataset-id", default=None)
    ap.add_argument("--sample-interval-sec", type=float, default=10.0)
    ap.add_argument("--max-samples", type=int, default=8)
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    dataset_id = args.dataset_id or datetime.datetime.utcnow().strftime("camera_vqa_%Y%m%d_%H%M%S")
    result = write_dataset(
        args.mcap,
        args.output_dir,
        dataset_id,
        args.sample_interval_sec,
        args.max_samples,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
