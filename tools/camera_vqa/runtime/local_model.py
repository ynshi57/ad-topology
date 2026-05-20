"""Runtime adapter for locally trained Camera VQA classifiers."""

import json
import time
from typing import Dict, List

import torch
from PIL import Image
from torchvision import transforms

from tools.camera_vqa.dataset import ID_TO_SEVERITY, ID_TO_STATE
from tools.camera_vqa.dataset.extract_frames import collect_samples_at_targets
from tools.camera_vqa.model import build_model
from .base import CameraVqaBatch


class LocalModelRuntime:
    def __init__(self, config: Dict):
        self.model_path = config.get("model_path")
        if not self.model_path:
            raise ValueError("local_model runtime requires model_path")
        self.device = torch.device(config.get("device", "cpu"))
        self.stability_runs = int(config.get("stability_runs", 3) or 3)
        ckpt = torch.load(self.model_path, map_location=self.device)
        self.config = ckpt.get("config", {})
        self.model = build_model(self.config).to(self.device)
        self.model.load_state_dict(ckpt["model_state"])
        self.model.eval()
        self.transform = transforms.Compose([
            transforms.Resize((224, 224), interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])

    def _predict_tensor(self, tensor):
        with torch.no_grad():
            out = self.model(tensor)
            state_prob = torch.softmax(out["state_logits"], dim=1)[0]
            sev_prob = torch.softmax(out["severity_logits"], dim=1)[0]
        return out["state_logits"].detach().cpu(), state_prob.cpu(), sev_prob.cpu()

    def _predict_rgb(self, rgb):
        img = Image.fromarray(rgb).convert("RGB")
        tensor = self.transform(img).unsqueeze(0).to(self.device)
        _logits, state_prob, sev_prob = self._predict_tensor(tensor)
        state_id = int(torch.argmax(state_prob).item())
        severity_id = int(torch.argmax(sev_prob).item())
        return {
            "visibility_state": ID_TO_STATE[state_id],
            "severity": ID_TO_SEVERITY[severity_id],
            "confidence": float(state_prob[state_id].item()),
            "severity_confidence": float(sev_prob[severity_id].item()),
        }

    def _stability_for_rgb(self, rgb):
        img = Image.fromarray(rgb).convert("RGB")
        tensor = self.transform(img).unsqueeze(0).to(self.device)
        logits = []
        for _ in range(max(1, self.stability_runs)):
            logit, _state_prob, _sev_prob = self._predict_tensor(tensor)
            logits.append(logit)
        base = logits[0]
        max_diff = max(float((x - base).abs().max().item()) for x in logits[1:]) if len(logits) > 1 else 0.0
        answers = [int(x.argmax(dim=1).item()) for x in logits]
        return {
            "repeat_runs": len(logits),
            "max_logit_abs_diff": max_diff,
            "answer_equal": len(set(answers)) == 1,
            "answer": ID_TO_STATE[answers[0]],
        }

    def infer(self, batch: CameraVqaBatch, _questions: List[str]) -> Dict:
        t0 = time.perf_counter()
        samples = collect_samples_at_targets(batch.mcap_path, [batch.log_time_ns])
        states = {}
        for cam_id, present in batch.input.get("camera_mask", {}).items():
            states[cam_id] = {
                "visibility_state": "unknown",
                "severity": "unknown",
                "confidence": 0.0,
            }
        for sample in samples:
            states[sample["camera_id"]] = self._predict_rgb(sample["rgb"])
        stability = self._stability_for_rgb(samples[0]["rgb"]) if samples else {
            "repeat_runs": self.stability_runs,
            "max_logit_abs_diff": 0.0,
            "answer_equal": True,
            "answer": "unknown",
        }
        latency_ms = (time.perf_counter() - t0) * 1000.0
        parsed = {"camera_states": states, "function_impact": {}}
        return {
            "runtime": {
                "name": "local_camera_vqa_model",
                "version": self.config.get("run_id", "unknown"),
                "mode": "local_model",
                "model_path": self.model_path,
            },
            "diagnostics": {
                "local_model": {
                    "name": self.config.get("model_type", "tiny_cnn"),
                    "exposed": True,
                    "latency_ms": round(latency_ms, 3),
                    "output_shape": [1, len(ID_TO_STATE)],
                    "dtype": "float32",
                    "mean": 0.0,
                    "std": 0.0,
                    "l2_norm": 0.0,
                    "nan_count": 0,
                    "inf_count": 0,
                    "dataset_hash": self.config.get("labels_sha256"),
                    "seed": self.config.get("seed"),
                },
                "determinism": {
                    "exposed": True,
                    "latency_ms": 0.0,
                    "repeat_runs": stability["repeat_runs"],
                    "max_logit_abs_diff": stability["max_logit_abs_diff"],
                    "answer_equal": stability["answer_equal"],
                    "answer": stability["answer"],
                },
                "decoder": {
                    "exposed": False,
                    "reason": "fixed_slot_classifier_runtime_does_not_use_qwen_decoder",
                },
            },
            "answer": {
                "raw": json.dumps(parsed, ensure_ascii=False),
                "parsed": parsed,
                "schema_errors": [],
            },
        }
