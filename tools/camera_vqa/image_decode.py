"""Deterministic image decoding utilities for camera_vqa tooling.

These helpers are for offline MCAP extraction/evaluation. They are not the
vehicle production image pipeline.
"""

from io import BytesIO
from typing import Dict, Optional, Tuple


def read_varint(buf: bytes, pos: int) -> Tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if (b & 0x80) == 0:
            return result, pos
        shift += 7
        if shift > 63:
            break
    return result, pos


def iter_fields(buf: bytes):
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        fn = tag >> 3
        wt = tag & 0x07
        if wt == 0:
            val, pos = read_varint(buf, pos)
            yield fn, wt, val
        elif wt == 1:
            yield fn, wt, buf[pos:pos + 8]
            pos += 8
        elif wt == 2:
            length, pos = read_varint(buf, pos)
            yield fn, wt, buf[pos:pos + length]
            pos += length
        elif wt == 5:
            yield fn, wt, buf[pos:pos + 4]
            pos += 4
        else:
            return


def looks_like_text(b: bytes) -> bool:
    if not b or len(b) > 256:
        return False
    try:
        s = b.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return "\x00" not in s


def parse_compressedimage(buf: bytes) -> Optional[Dict]:
    text_candidates = []
    binary_candidates = []
    for _fn, wt, val in iter_fields(buf):
        if wt != 2:
            continue
        if looks_like_text(val):
            text_candidates.append(bytes(val))
        else:
            binary_candidates.append(bytes(val))
    if not binary_candidates:
        return None
    data = max(binary_candidates, key=len)
    text_strs = [t.decode("utf-8") for t in text_candidates]
    text_strs.sort(key=len)
    fmt = text_strs[0] if text_strs else ""
    frame_id = text_strs[1] if len(text_strs) > 1 else ""
    return {"frame_id": frame_id, "format": fmt.lower(), "data": data}


def decode_compressed_image(data: bytes, fmt: str = ""):
    import numpy as np
    from PIL import Image

    if "avif" in (fmt or "").lower():
        import pillow_avif  # noqa: F401 - registers plugin
    img = Image.open(BytesIO(data)).convert("RGB")
    return np.asarray(img)


def decode_message_image(schema_name: str, raw: bytes):
    if schema_name == "foxglove.CompressedImage":
        msg = parse_compressedimage(raw)
        if not msg:
            return None
        return decode_compressed_image(msg["data"], msg.get("format", ""))
    return None
