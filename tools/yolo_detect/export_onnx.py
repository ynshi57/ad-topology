#!/usr/bin/env python3
"""
Idempotent ONNX exporter for YOLOv11 weights.

Reads ``.pt`` from ``/home/caros/workspace/yolo_weights/`` and writes a
matching ``.onnx`` next to it. Skipping happens automatically if the
output already exists and is non-empty.

Usage:
    python3 export_onnx.py yolo11x          # single model
    python3 export_onnx.py --all            # all 5 (n/s/m/l/x) that have .pt
    python3 export_onnx.py yolo11x --force  # re-export even if onnx exists
"""

import argparse
import sys
from pathlib import Path


WEIGHTS_DIR = Path('/home/caros/workspace/yolo_weights')
KNOWN_MODELS = ['yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x']


def export(model_name: str, force: bool = False) -> Path:
    """Export a single model. Returns absolute path to the generated .onnx."""
    pt_path = WEIGHTS_DIR / f'{model_name}.pt'
    onnx_path = WEIGHTS_DIR / f'{model_name}.onnx'

    if not pt_path.is_file():
        raise FileNotFoundError(f'missing weights: {pt_path}')
    # Reject Git LFS pointer files (134 byte text). Real .pt files are 5+ MB
    # and start with the PK zip magic.
    with open(pt_path, 'rb') as f:
        magic = f.read(2)
    if magic != b'PK':
        raise ValueError(
            f'{pt_path} is not a valid PyTorch model '
            f'(magic={magic!r}; likely a Git LFS pointer)'
        )

    if onnx_path.is_file() and onnx_path.stat().st_size > 1024 and not force:
        print(f'[skip] {model_name}: {onnx_path} already exists '
              f'({onnx_path.stat().st_size // 1024} KB)')
        return onnx_path

    print(f'[export] {model_name}: loading {pt_path} ...')
    from ultralytics import YOLO  # heavy import, defer to here
    model = YOLO(str(pt_path))

    print(f'[export] {model_name}: exporting to ONNX ...')
    # NB: simplify=True triggers ultralytics to auto-install onnxslim/
    # onnxruntime via ``uv pip``, which can hang for many minutes on slow
    # networks. The unsimplified graph is still fully viewable in Netron;
    # there are just a few extra Constant/Identity nodes. We trade graph
    # cleanliness for a reliable, fast export.
    out_str = model.export(
        format='onnx',
        imgsz=640,
        simplify=False,
        opset=17,
        dynamic=False,
    )
    out_path = Path(out_str)

    # ultralytics writes the .onnx next to the input .pt by default. Move it
    # to WEIGHTS_DIR for consistency in case it landed elsewhere.
    if out_path.resolve() != onnx_path.resolve():
        out_path.replace(onnx_path)

    size_kb = onnx_path.stat().st_size // 1024
    print(f'[export] {model_name}: wrote {onnx_path} ({size_kb} KB)')
    return onnx_path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('model', nargs='?', help='Model name (yolo11n/s/m/l/x)')
    ap.add_argument('--all', action='store_true',
                    help='Export all available models in WEIGHTS_DIR')
    ap.add_argument('--force', action='store_true',
                    help='Re-export even if the .onnx already exists')
    args = ap.parse_args()

    if args.all:
        any_done = False
        for m in KNOWN_MODELS:
            try:
                export(m, force=args.force)
                any_done = True
            except FileNotFoundError as e:
                print(f'[skip] {m}: {e}')
            except Exception as e:
                print(f'[error] {m}: {e}', file=sys.stderr)
        if not any_done:
            sys.exit(2)
        return

    if not args.model:
        ap.error('provide a model name or --all')
    if args.model not in KNOWN_MODELS:
        ap.error(f'unknown model {args.model!r} (must be one of {KNOWN_MODELS})')

    try:
        path = export(args.model, force=args.force)
    except Exception as e:
        print(f'error: {e}', file=sys.stderr)
        sys.exit(1)
    # Last line of stdout is the absolute onnx path so callers can parse it.
    print(str(path))


if __name__ == '__main__':
    main()
