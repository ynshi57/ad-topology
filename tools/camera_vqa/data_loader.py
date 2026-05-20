"""PyTorch dataset for Camera VQA labels."""

import json
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import Dataset
from torchvision import transforms

from tools.camera_vqa.dataset import STATE_TO_ID, SEVERITY_TO_ID


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


class CameraVqaImageDataset(Dataset):
    def __init__(self, labels_path, image_size=224):
        self.labels_path = str(labels_path)
        self.rows = [
            r for r in read_jsonl(labels_path)
            if r.get("image_path") and r.get("state") in STATE_TO_ID
        ]
        self.transform = transforms.Compose([
            transforms.Resize((image_size, image_size), interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        row = self.rows[idx]
        img = Image.open(Path(row["image_path"])).convert("RGB")
        state = STATE_TO_ID[row["state"]]
        severity = SEVERITY_TO_ID.get(row.get("severity") or "unknown", SEVERITY_TO_ID["unknown"])
        return {
            "image": self.transform(img),
            "state": torch.tensor(state, dtype=torch.long),
            "severity": torch.tensor(severity, dtype=torch.long),
            "meta": row,
        }
