#!/usr/bin/env python3
"""Train a fixed-slot Camera VQA classifier."""

import argparse
import datetime
import hashlib
import json
import os
import random
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, random_split

from tools.camera_vqa.data_loader import CameraVqaImageDataset
from tools.camera_vqa.dataset import STATE_LABELS, SEVERITY_LABELS
from tools.camera_vqa.model import build_model


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def set_seed(seed):
    random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--output-root", default="/home/caros/workspace/camera_vqa_models")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="cpu")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    set_seed(args.seed)
    ds = CameraVqaImageDataset(args.labels)
    if len(ds) == 0:
        raise RuntimeError("no labeled samples found")
    val_len = max(1, int(len(ds) * 0.2)) if len(ds) > 4 else 0
    train_len = len(ds) - val_len
    if val_len > 0:
        train_ds, val_ds = random_split(ds, [train_len, val_len], generator=torch.Generator().manual_seed(args.seed))
    else:
        train_ds, val_ds = ds, None

    device = torch.device(args.device if args.device != "auto" else ("cuda:0" if torch.cuda.is_available() else "cpu"))
    model = build_model({"model_type": "tiny_cnn"}).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, generator=torch.Generator().manual_seed(args.seed))

    history = []
    for epoch in range(args.epochs):
        model.train()
        total_loss = 0.0
        for batch in train_loader:
            img = batch["image"].to(device)
            state = batch["state"].to(device)
            severity = batch["severity"].to(device)
            out = model(img)
            loss = F.cross_entropy(out["state_logits"], state) + 0.5 * F.cross_entropy(out["severity_logits"], severity)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_loss += float(loss.item()) * img.shape[0]
        history.append({"epoch": epoch + 1, "train_loss": total_loss / max(1, len(train_ds))})

    run_id = args.run_id or datetime.datetime.utcnow().strftime("camera_vqa_%Y%m%d_%H%M%S")
    out_dir = Path(args.output_root) / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "run_id": run_id,
        "model_type": "tiny_cnn",
        "labels_path": str(Path(args.labels).resolve()),
        "labels_sha256": sha256_file(args.labels),
        "seed": args.seed,
        "torch_version": torch.__version__,
        "state_labels": STATE_LABELS,
        "severity_labels": SEVERITY_LABELS,
        "history": history,
    }
    torch.save({"model_state": model.cpu().state_dict(), "config": config}, out_dir / "model.pt")
    (out_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "label_map.json").write_text(json.dumps({
        "state_labels": STATE_LABELS,
        "severity_labels": SEVERITY_LABELS,
    }, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "run_id": run_id, "output_dir": str(out_dir), "samples": len(ds)}, indent=2))


if __name__ == "__main__":
    main()
