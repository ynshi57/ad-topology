#!/usr/bin/env python3
"""Evaluate a Camera VQA classifier and determinism."""

import argparse
import json

import torch
from torch.utils.data import DataLoader

from tools.camera_vqa.data_loader import CameraVqaImageDataset
from tools.camera_vqa.dataset import ID_TO_STATE
from tools.camera_vqa.model import build_model


def load_model(path, device):
    ckpt = torch.load(path, map_location=device)
    model = build_model(ckpt.get("config", {})).to(device)
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    return model, ckpt.get("config", {})


@torch.no_grad()
def evaluate(model, ds, device):
    loader = DataLoader(ds, batch_size=32, shuffle=False)
    total = 0
    correct = 0
    confusion = {}
    for batch in loader:
        out = model(batch["image"].to(device))
        pred = out["state_logits"].argmax(dim=1).cpu()
        target = batch["state"]
        for p, t in zip(pred.tolist(), target.tolist()):
            total += 1
            correct += int(p == t)
            key = f"{ID_TO_STATE[t]}->{ID_TO_STATE[p]}"
            confusion[key] = confusion.get(key, 0) + 1
    return {"samples": total, "accuracy": correct / max(1, total), "confusion": confusion}


@torch.no_grad()
def determinism(model, ds, device, repeat):
    if len(ds) == 0:
        return {"repeat_runs": repeat, "answer_equal": True, "max_logit_abs_diff": 0.0}
    sample = ds[0]["image"].unsqueeze(0).to(device)
    logits = []
    for _ in range(repeat):
        logits.append(model(sample)["state_logits"].cpu())
    base = logits[0]
    max_diff = max(float((x - base).abs().max().item()) for x in logits[1:]) if len(logits) > 1 else 0.0
    answers = [int(x.argmax(dim=1).item()) for x in logits]
    return {
        "repeat_runs": repeat,
        "max_logit_abs_diff": max_diff,
        "answer_equal": len(set(answers)) == 1,
        "answer": ID_TO_STATE[answers[0]],
    }


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-path", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--repeat", type=int, default=5)
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    device = torch.device(args.device if args.device != "auto" else ("cuda:0" if torch.cuda.is_available() else "cpu"))
    model, config = load_model(args.model_path, device)
    ds = CameraVqaImageDataset(args.labels)
    result = evaluate(model, ds, device)
    result["determinism"] = determinism(model, ds, device, args.repeat)
    result["config"] = config
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
