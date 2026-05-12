#!/usr/bin/env python3
"""
YOLOv11 offline inference for ad-topology mcap files.

Reads camera streams (foxglove.CompressedImage AVIF or
neodrive.global.drivers.camera.VideoStream H264) directly from an mcap file,
runs YOLOv11 detection on each frame, and writes a JSON sidecar at
``<input>.yolo.json`` for the ad-topology frontend to overlay.

Usage:
    python detect.py --mcap /path/to/input.mcap [--model yolo11x] [--device cuda:0]
"""

import argparse
import datetime
import json
import os
import re
import struct
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Lazy-imported (heavy) inside main() to make --help fast and let users see
# import errors with a clearer message.

# COCO classes we care about for autonomous driving comparison.
RELEVANT_CLASS_IDS = {
    0: 'person',
    1: 'bicycle',
    2: 'car',
    3: 'motorcycle',
    5: 'bus',
    7: 'truck',
    9: 'traffic light',
    11: 'stop sign',
}


# ---------------------------------------------------------------------------
#  Wire-level protobuf parsing for messages the embedded FDS can't decode.
# ---------------------------------------------------------------------------

def _read_varint(buf: bytes, pos: int) -> Tuple[int, int]:
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


def _iter_fields(buf: bytes):
    """Yield (field_num, wire_type, value_or_offset) tuples."""
    pos = 0
    while pos < len(buf):
        tag, pos = _read_varint(buf, pos)
        fn = tag >> 3
        wt = tag & 0x07
        if wt == 0:
            val, pos = _read_varint(buf, pos)
            yield fn, wt, val
        elif wt == 1:
            yield fn, wt, buf[pos:pos + 8]
            pos += 8
        elif wt == 2:
            length, pos = _read_varint(buf, pos)
            yield fn, wt, buf[pos:pos + length]
            pos += length
        elif wt == 5:
            yield fn, wt, buf[pos:pos + 4]
            pos += 4
        else:
            return


def parse_videostream(buf: bytes) -> Optional[Dict]:
    """Extract relevant fields from neodrive.global.drivers.camera.VideoStream.

    Returns dict with keys: frame_id, format, frame_type, data, measurement_time.
    """
    out = {
        'frame_id': '',
        'format': '',
        'frame_type': -1,
        'data': b'',
        'measurement_time': 0.0,
    }
    for fn, wt, val in _iter_fields(buf):
        if wt == 2:
            if fn == 2:
                out['frame_id'] = val.decode('utf-8', errors='replace')
            elif fn == 3:
                out['format'] = val.decode('utf-8', errors='replace')
            elif fn == 21:
                out['data'] = bytes(val)
        elif wt == 0 and fn == 6:
            out['frame_type'] = val
        elif wt == 1 and fn == 4:
            out['measurement_time'] = struct.unpack('<d', val)[0]
    return out if out['data'] else None


def _looks_like_text(b: bytes) -> bool:
    """Quick check: short ASCII / utf-8 string with no control bytes."""
    if not b or len(b) > 256:
        return False
    try:
        s = b.decode('utf-8')
    except UnicodeDecodeError:
        return False
    # Image binary almost always contains nul bytes; text never does.
    if '\x00' in s:
        return False
    return True


def parse_compressedimage(buf: bytes) -> Optional[Dict]:
    """Extract fields from a foxglove.CompressedImage-shaped message.

    The exact field numbers for ``data`` / ``format`` / ``frame_id`` differ
    between the public foxglove schema and the in-house variant used by some
    of our mcaps, so identify them by content instead of by field number:
    - ``data``: longest length-delimited field that is NOT a short ASCII
      string (binary image bytes; AVIF/JPEG always contain nul bytes).
    - ``format``: shortest ASCII string field (typically ``"avif"``,
      ``"jpeg"``, etc.).
    - ``frame_id``: the other ASCII string field (e.g. ``_sensor_...``).
    """
    text_candidates = []
    binary_candidates = []
    for _fn, wt, val in _iter_fields(buf):
        if wt != 2:
            continue
        if _looks_like_text(val):
            text_candidates.append(bytes(val))
        else:
            binary_candidates.append(bytes(val))

    if not binary_candidates:
        return None

    # Pick largest binary blob as the image payload.
    data = max(binary_candidates, key=len)

    # Among text fields, the format is short (<=8 chars typically); frame_id
    # is longer (e.g. ``_sensor_camera_front_left_1_image``).
    text_strs = [t.decode('utf-8') for t in text_candidates]
    text_strs.sort(key=len)
    fmt = text_strs[0] if text_strs else ''
    frame_id = text_strs[1] if len(text_strs) > 1 else ''

    return {'frame_id': frame_id, 'format': fmt, 'data': data}


# ---------------------------------------------------------------------------
#  Decoders
# ---------------------------------------------------------------------------

class H264Decoder:
    """Per-camera streaming H264 decoder using PyAV.

    Frames must be fed in arrival order (IDR -> P-frames). Returns RGB ndarray
    or None when the codec needs more data (typical for first few P-frames
    before initial IDR).
    """

    def __init__(self):
        import av  # noqa: F401 (deferred import, raises clearly if missing)
        self._av = av
        self._codec = av.CodecContext.create('h264', 'r')

    def decode(self, nal_bytes: bytes):
        packet = self._av.Packet(nal_bytes)
        try:
            frames = self._codec.decode(packet)
        except Exception as exc:
            print('  warn: h264 decode error:', exc, file=sys.stderr)
            return None
        if not frames:
            return None
        # Take the most recent decoded frame (in B-frame-free streams there
        # is at most one).
        frame = frames[-1]
        return frame.to_ndarray(format='rgb24')


_AVIF_PLUGIN_LOADED = False


def _ensure_avif_plugin():
    """Register pillow-avif-plugin with PIL exactly once."""
    global _AVIF_PLUGIN_LOADED
    if _AVIF_PLUGIN_LOADED:
        return
    try:
        import pillow_avif  # noqa: F401  (side-effect: registers AVIF plugin)
        _AVIF_PLUGIN_LOADED = True
    except ImportError as exc:
        raise RuntimeError(
            'pillow-avif-plugin is not installed. '
            'Run: pip3 install --user pillow-avif-plugin'
        ) from exc


def decode_avif(data: bytes):
    """AVIF -> RGB ndarray via PIL + pillow-avif-plugin."""
    _ensure_avif_plugin()
    from io import BytesIO
    from PIL import Image
    import numpy as np
    img = Image.open(BytesIO(data)).convert('RGB')
    return np.asarray(img)


# ---------------------------------------------------------------------------
#  Camera channel discovery
# ---------------------------------------------------------------------------

CAMERA_TOPIC_RE = '/sensor/camera/'
CAMERA_TOPIC_SUFFIX = '/image/video'


def is_camera_video_topic(topic: str) -> bool:
    return topic.startswith(CAMERA_TOPIC_RE) and topic.endswith(CAMERA_TOPIC_SUFFIX)


# Fisheye camera ID convention for the X3PRO platform: cameras 0 (front
# middle), 3 (left middle), 5 (rear left), 8 (right middle) are fisheye.
# Other platforms may differ; this is a pragmatic fallback when neither
# the topic name nor calibration metadata flags the lens type.
FISHEYE_CAM_IDS = {0, 3, 5, 8}


def is_fisheye_topic_by_name(topic: str) -> bool:
    """Identify fisheye topics by name across mcap variants.

    Matches:
      - record-converted mcaps with ``..._fisheye_<n>`` in the topic, e.g.
        ``/sensor/camera/front_middle_fisheye_0/image/video``
      - URL-loaded camera.mcap variants without the ``fisheye`` word but
        with the trailing camera ID, e.g.
        ``/sensor/camera/front_middle_0/image/video``
    """
    if 'fisheye' in topic:
        return True
    m = re.search(r'/sensor/camera/[^/]+_(\d+)/image/video$', topic)
    if m and int(m.group(1)) in FISHEYE_CAM_IDS:
        return True
    return False


def is_fisheye_by_image(rgb, threshold: float = 0.20) -> bool:
    """Content-based fisheye detection.

    Fisheye lenses project a circular image onto a rectangular sensor, so
    the four corners of the frame are nearly black (no light hits there).
    A regular pinhole / wide-angle lens fills the sensor, so corners and
    center have similar brightness.

    Compute mean intensity ratio (corners / center). For fisheye it is
    typically < 0.05; for normal lenses > 0.5. We use 0.20 as the cutoff.

    Returns False on degenerate inputs (all-black scene) so we don't
    mis-classify a covered camera as fisheye.
    """
    try:
        import numpy as np
    except ImportError:
        return False
    if rgb is None:
        return False
    h, w = rgb.shape[:2]
    if h < 32 or w < 32:
        return False
    cs = max(16, min(h, w) // 16)
    ch = max(cs, min(h, w) // 8)
    cyc, cxc = h // 2, w // 2
    corners = np.concatenate([
        rgb[:cs, :cs].reshape(-1, 3),
        rgb[:cs, w - cs:].reshape(-1, 3),
        rgb[h - cs:, :cs].reshape(-1, 3),
        rgb[h - cs:, w - cs:].reshape(-1, 3),
    ], axis=0)
    center = rgb[cyc - ch:cyc + ch, cxc - ch:cxc + ch].reshape(-1, 3)
    corner_mean = float(corners.mean())
    center_mean = float(center.mean())
    if center_mean < 5.0:
        return False  # essentially black scene, defer judgement
    return (corner_mean / center_mean) < threshold


def extract_cam_short_name(topic: str) -> str:
    # /sensor/camera/<name>/image/video -> <name>
    parts = topic.split('/')
    if len(parts) >= 4:
        return parts[3]
    return topic


# ---------------------------------------------------------------------------
#  Main pipeline
# ---------------------------------------------------------------------------

def discover_camera_channels(reader, args):
    """Return list of (topic, schema_name) for all camera video topics matching filters."""
    summary = reader.get_summary()
    if summary is None:
        return []
    chans = []
    schemas_by_id = {sid: s for sid, s in summary.schemas.items()}
    for cid, ch in summary.channels.items():
        if not is_camera_video_topic(ch.topic):
            continue
        if args.skip_fisheye and is_fisheye_topic_by_name(ch.topic):
            continue
        if args.topics and ch.topic not in args.topics:
            continue
        schema = schemas_by_id.get(ch.schema_id)
        sname = schema.name if schema else 'unknown'
        chans.append((ch.topic, sname))
    chans.sort()
    return chans


def run_inference_for_topic(model, frames_rgb, args):
    """Batch-inference a list of HWC RGB ndarrays. Returns list-of-list of dicts."""
    if not frames_rgb:
        return []
    batch_size = args.batch
    # Ultralytics accepts 'cpu', '0', '0,1', or None. It does NOT accept 'auto'.
    # Translate our friendly 'auto' value into None so Ultralytics auto-selects.
    predict_device = None if args.device in ('auto', '') else args.device
    out_per_frame = []
    for i in range(0, len(frames_rgb), batch_size):
        batch = frames_rgb[i:i + batch_size]
        kwargs = dict(
            conf=args.conf,
            iou=args.iou,
            verbose=False,
            classes=list(RELEVANT_CLASS_IDS.keys()) if args.relevant_only else None,
        )
        if predict_device is not None:
            kwargs['device'] = predict_device
        results = model.predict(batch, **kwargs)
        for r in results:
            dets = []
            if r.boxes is None:
                out_per_frame.append(dets)
                continue
            xyxy = r.boxes.xyxy.cpu().numpy()
            conf = r.boxes.conf.cpu().numpy()
            cls = r.boxes.cls.cpu().numpy().astype(int)
            for j in range(len(cls)):
                cid = int(cls[j])
                cname = r.names.get(cid, f'cls_{cid}')
                dets.append({
                    'class_id': cid,
                    'class_name': cname,
                    'confidence': float(conf[j]),
                    'bbox': [float(xyxy[j][0]), float(xyxy[j][1]),
                             float(xyxy[j][2]), float(xyxy[j][3])],
                })
            out_per_frame.append(dets)
    return out_per_frame


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--mcap', required=True, help='Input mcap path (absolute)')
    ap.add_argument('--output', default=None,
                    help='Output JSON sidecar path. Default: <mcap>.yolo.json')
    ap.add_argument('--model', default='yolo11x',
                    help='YOLO model (yolo11n/s/m/l/x). Default: yolo11x')
    ap.add_argument('--device', default='auto',
                    help='Inference device (auto, cpu, cuda:0). Default: auto')
    ap.add_argument('--conf', type=float, default=0.25, help='Confidence threshold')
    ap.add_argument('--iou', type=float, default=0.5, help='NMS IoU threshold')
    ap.add_argument('--batch', type=int, default=8, help='Inference batch size')
    ap.add_argument('--topics', default='',
                    help='Comma-separated camera video topics; default = all')
    ap.add_argument('--skip-fisheye', action='store_true',
                    help='Skip fisheye cameras')
    ap.add_argument('--max-frames-per-cam', type=int, default=0,
                    help='Cap frames per camera (0 = no cap, useful for smoke test)')
    ap.add_argument('--relevant-only', action='store_true', default=True,
                    help='Only keep AD-relevant COCO classes (default: True)')
    args = ap.parse_args()

    args.topics = [t.strip() for t in args.topics.split(',') if t.strip()]
    output_path = args.output or (str(Path(args.mcap).with_suffix('')) + '.yolo.json')
    if Path(args.mcap).suffix != '.mcap':
        # Path.with_suffix only works once; if input is x.mcap.foo it gets weird
        output_path = args.output or (args.mcap + '.yolo.json')

    print('=' * 70)
    print('YOLOv11 offline inference')
    print('=' * 70)
    print('  input:  ', args.mcap)
    print('  output: ', output_path)
    print('  model:  ', args.model)
    print('  device: ', args.device)
    print('  conf:   ', args.conf)

    try:
        from mcap.reader import make_reader
    except ImportError as exc:
        print('error: missing required Python package:', exc, file=sys.stderr)
        sys.exit(1)

    try:
        from ultralytics import YOLO
    except ImportError:
        print('error: ultralytics not installed. pip install ultralytics', file=sys.stderr)
        sys.exit(1)

    print('Loading model ...')
    t0 = time.time()
    # Resolve model weights. We search several locations in priority order
    # so the resolver works whether weights are placed inside or outside
    # the git repo. The repo's ``tools/yolo_detect/`` directory is governed
    # by a ``*.pt filter=lfs`` rule in .gitattributes, so any .pt placed
    # there can be silently replaced with an LFS pointer file (134 bytes of
    # text) on git operations -- which then breaks ``torch.load`` with an
    # ``UnpicklingError: invalid load key, 'v'``. Prefer paths OUTSIDE the
    # repo to avoid that footgun.
    #
    # Search order (first valid match wins):
    #   1. $YOLO_WEIGHTS_DIR/<model>.pt           (env override)
    #   2. /home/caros/workspace/yolo_weights/<model>.pt
    #   3. <script_dir>/<model>.pt                (legacy, may be LFS pointer)
    #   4. <model>.pt                             (let Ultralytics download)
    script_dir = Path(__file__).resolve().parent
    candidates = []
    env_dir = os.environ.get('YOLO_WEIGHTS_DIR')
    if env_dir:
        candidates.append(Path(env_dir) / f'{args.model}.pt')
    candidates.append(Path('/home/caros/workspace/yolo_weights') / f'{args.model}.pt')
    candidates.append(script_dir / f'{args.model}.pt')

    def _looks_like_pytorch_pt(path: Path) -> bool:
        """A real .pt is a zip archive; LFS pointers are tiny ASCII files."""
        try:
            if not path.is_file():
                return False
            if path.stat().st_size < 1024:
                return False
            with open(path, 'rb') as fp:
                return fp.read(2) == b'PK'
        except OSError:
            return False

    model_arg = None
    for c in candidates:
        if _looks_like_pytorch_pt(c):
            model_arg = str(c)
            print(f'  using cached weights: {model_arg}')
            break
        if c.is_file():
            print(f'  warn: {c} exists but is not a valid PyTorch model '
                  f'({c.stat().st_size} bytes; likely Git LFS pointer)',
                  file=sys.stderr)
    if model_arg is None:
        model_arg = f'{args.model}.pt'
        print(f'  no cached weights; will download {model_arg} (needs github.com)')
    model = YOLO(model_arg)
    print(f'  loaded in {time.time() - t0:.1f}s')

    if args.device != 'auto':
        # Ultralytics handles this on .predict(); just record it.
        pass

    # Open mcap and find camera channels
    with open(args.mcap, 'rb') as fp:
        reader = make_reader(fp)
        cam_channels = discover_camera_channels(reader, args)
        if not cam_channels:
            print('error: no camera video topics found in mcap', file=sys.stderr)
            sys.exit(1)

        print(f'\nFound {len(cam_channels)} camera topics:')
        for topic, sname in cam_channels:
            print(f'  {topic}  ({sname})')

        # Per-topic state: H264 decoder, list of (log_time_ns, image_w, image_h, rgb)
        state_by_topic: Dict[str, Dict] = {}
        for topic, sname in cam_channels:
            state_by_topic[topic] = {
                'schema_name': sname,
                'h264': H264Decoder() if 'VideoStream' in sname else None,
                'frames': [],   # list of (log_time_ns, w, h, rgb_ndarray)
            }

        topic_set = {t for t, _ in cam_channels}

        print('\nDecoding camera frames ...')
        t_decode = time.time()
        for schema, channel, message in reader.iter_messages(topics=list(topic_set)):
            topic = channel.topic
            st = state_by_topic.get(topic)
            if st is None:
                continue
            schema_name = st['schema_name']

            if 'CompressedImage' in schema_name:
                parsed = parse_compressedimage(message.data)
                if not parsed or not parsed['data']:
                    continue
                fmt = parsed['format'].lower()
                if fmt == 'avif':
                    try:
                        rgb = decode_avif(parsed['data'])
                    except Exception as exc:
                        print(f'  warn: avif decode failed for {topic}: {exc}',
                              file=sys.stderr)
                        continue
                else:
                    print(f'  skip unsupported foxglove format: {fmt}', file=sys.stderr)
                    continue
            elif 'VideoStream' in schema_name:
                parsed = parse_videostream(message.data)
                if not parsed or not parsed['data']:
                    continue
                rgb = st['h264'].decode(parsed['data'])
                if rgb is None:
                    continue
            else:
                continue

            if args.max_frames_per_cam > 0 and \
                    len(st['frames']) >= args.max_frames_per_cam:
                # We must keep feeding the H264 decoder from earlier samples to
                # preserve state, but we no longer need to store new frames.
                continue

            h, w = rgb.shape[:2]
            st['frames'].append((message.log_time, w, h, rgb))

    decode_secs = time.time() - t_decode
    total_frames = sum(len(st['frames']) for st in state_by_topic.values())
    print(f'  decoded {total_frames} frames across {len(state_by_topic)} topics '
          f'in {decode_secs:.1f}s')

    # Run inference per topic
    print('\nRunning YOLO inference ...')
    t_inf = time.time()
    out_frames: List[Dict] = []
    for topic, st in state_by_topic.items():
        frames = st['frames']
        if not frames:
            continue
        if args.max_frames_per_cam > 0:
            frames = frames[:args.max_frames_per_cam]

        rgbs = [f[3] for f in frames]
        per_frame_dets = run_inference_for_topic(model, rgbs, args)
        n_dets = sum(len(d) for d in per_frame_dets)
        print(f'  {topic}: {len(frames)} frames -> {n_dets} detections')

        for (log_time_ns, w, h, _rgb), dets in zip(frames, per_frame_dets):
            out_frames.append({
                'topic': topic,
                'log_time_ns': int(log_time_ns),
                'image_w': int(w),
                'image_h': int(h),
                'detections': dets,
            })

    inf_secs = time.time() - t_inf
    total_dets = sum(len(f['detections']) for f in out_frames)
    print(f'  inferred {total_dets} detections in {inf_secs:.1f}s')

    # Order output frames by topic + time for determinism
    out_frames.sort(key=lambda f: (f['topic'], f['log_time_ns']))

    sidecar = {
        'model': args.model,
        'version': '1.0',
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'mcap_file': str(Path(args.mcap).resolve()),
        'conf_threshold': args.conf,
        'iou_threshold': args.iou,
        'frames': out_frames,
    }

    print(f'\nWriting sidecar: {output_path}')
    with open(output_path, 'w') as fp:
        json.dump(sidecar, fp, separators=(',', ':'))
    sz = os.path.getsize(output_path)
    print(f'  wrote {sz / 1024:.1f} KB')

    print('\nDone.')
    print(f'  decode={decode_secs:.1f}s  inference={inf_secs:.1f}s  '
          f'total_frames={total_frames}  total_detections={total_dets}')


if __name__ == '__main__':
    main()
