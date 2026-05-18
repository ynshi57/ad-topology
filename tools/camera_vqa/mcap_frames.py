"""MCAP camera extraction helpers for Camera VQA.

This module is intentionally conservative: it prepares Atlas-style camera
metadata (camera order, masks, topic grouping, timestamps) without pretending
that missing cameras are black images. Real image tensor construction is a
runtime concern once the Atlas adapter contract is available.
"""

import re
from collections import defaultdict
from typing import Dict, Iterable, List, Optional, Tuple


# Canonical Atlas camera order. This must match the model-team contract before
# production use. It is exposed in diagnostics so mismatches are visible.
ATLAS_CAMERA_ORDER = [
    "front_middle_0",
    "front_left_1",
    "left_front_2",
    "left_middle_3",
    "left_rear_4",
    "rear_left_5",
    "rear_right_6",
    "right_rear_7",
    "right_middle_8",
    "right_front_9",
    "front_right_10",
    "front_left_dark_11",
]


CAMERA_TOPIC_RE = re.compile(r"/sensor/camera/([^/]+)/")


def camera_name_from_topic(topic: str) -> Optional[str]:
    """Extract the camera name from a /sensor/camera/<name>/... topic."""
    if not isinstance(topic, str):
        return None
    m = CAMERA_TOPIC_RE.search(topic)
    return m.group(1) if m else None


def build_camera_mask(
    present_cameras: Dict[str, Dict],
    camera_order: Optional[List[str]] = None,
) -> Tuple[Dict[str, bool], List[str], Dict[str, List[int]]]:
    """Return (mask, missing, image_shape) for the canonical camera order.

    Missing cameras are represented only in the mask/missing list. They are
    not assigned an image shape, which prevents UI/runtime code from mistaking
    a missing camera for an actual all-black frame.
    """
    order = camera_order or ATLAS_CAMERA_ORDER
    mask = {name: name in present_cameras for name in order}
    missing = [name for name in order if not mask[name]]
    image_shape = {
        name: info["image_shape"]
        for name, info in present_cameras.items()
        if name in order and info.get("image_shape")
    }
    return mask, missing, image_shape


def summarize_camera_channels(channels: Iterable[Dict]) -> Dict[str, Dict]:
    """Group image/calibration/transform channels by camera name."""
    grouped: Dict[str, Dict] = defaultdict(lambda: {
        "video_topic": None,
        "video_schema": None,
        "video_count": 0,
        "camera_info_topic": None,
        "camera_info_count": 0,
        "transform_topic": None,
        "transform_count": 0,
    })
    for ch in channels:
        topic = ch.get("topic", "")
        cam = camera_name_from_topic(topic)
        if not cam:
            continue
        info = grouped[cam]
        count = int(ch.get("count", 0) or 0)
        schema = ch.get("schema")
        if topic.endswith("/image/video"):
            info["video_topic"] = topic
            info["video_schema"] = schema
            info["video_count"] = count
        elif topic.endswith("/image/video_camera_info"):
            info["camera_info_topic"] = topic
            info["camera_info_count"] = count
        elif topic.endswith("/image/video_transform"):
            info["transform_topic"] = topic
            info["transform_count"] = count
    return dict(grouped)


def list_mcap_channels(mcap_path: str) -> List[Dict]:
    """Return summary-channel dicts from an MCAP file."""
    from mcap.reader import make_reader

    with open(mcap_path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        if not summary or not summary.statistics:
            return []
        counts = summary.statistics.channel_message_counts
        rows = []
        for channel_id, channel in summary.channels.items():
            schema = summary.schemas.get(channel.schema_id)
            rows.append({
                "id": channel_id,
                "topic": channel.topic,
                "schema": schema.name if schema else "",
                "count": int(counts.get(channel_id, 0)),
            })
        return rows


def summarize_mcap_cameras(mcap_path: str) -> Dict[str, Dict]:
    """Inspect an MCAP and return camera channel grouping."""
    return summarize_camera_channels(list_mcap_channels(mcap_path))


def build_input_record(
    timestamp_sec: float,
    log_time_ns: int,
    present_cameras: Dict[str, Dict],
    camera_order: Optional[List[str]] = None,
) -> Dict:
    """Build the sidecar ``input`` block for a sampled frame."""
    order = camera_order or ATLAS_CAMERA_ORDER
    mask, missing, image_shape = build_camera_mask(present_cameras, order)
    return {
        "timestamp_sec": float(timestamp_sec),
        "log_time_ns": int(log_time_ns),
        "camera_order": order,
        "camera_mask": mask,
        "image_shape": image_shape,
        "missing_cameras": missing,
    }
