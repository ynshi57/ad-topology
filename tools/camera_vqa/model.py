"""Trainable fixed-slot Camera VQA classifier models."""

import torch
from torch import nn

from tools.camera_vqa.dataset import STATE_LABELS, SEVERITY_LABELS


class TinyCameraVqaNet(nn.Module):
    """Small deterministic baseline for camera health classification.

    This is intentionally simple and trainable from scratch. It provides the
    0-to-1 model path before swapping in a stronger open-source encoder.
    """

    def __init__(self, num_states=len(STATE_LABELS), num_severities=len(SEVERITY_LABELS)):
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Conv2d(3, 32, 3, stride=2, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, stride=2, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.Conv2d(64, 128, 3, stride=2, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Linear(128, 128), nn.ReLU(inplace=True))
        self.state_head = nn.Linear(128, num_states)
        self.severity_head = nn.Linear(128, num_severities)

    def forward(self, x):
        feat = self.head(self.encoder(x))
        return {
            "state_logits": self.state_head(feat),
            "severity_logits": self.severity_head(feat),
        }


class MultiCameraPerceiverVqaNet(nn.Module):
    """Optional 12-camera context model.

    This is not the default training path. It exists so the same model module
    has a production-shaped upgrade point after the single-camera baseline is
    measured. Input shape: [B, 12, 3, H, W]. Output logits are [B, 12, C].
    """

    def __init__(self, num_cameras=12, d_model=128,
                 num_states=len(STATE_LABELS), num_severities=len(SEVERITY_LABELS)):
        super().__init__()
        self.num_cameras = num_cameras
        self.encoder = TinyCameraVqaNet(num_states=num_states, num_severities=num_severities).encoder
        self.project = nn.Sequential(nn.Flatten(), nn.Linear(128, d_model), nn.ReLU(inplace=True))
        self.camera_embed = nn.Embedding(num_cameras, d_model)
        self.attn = nn.MultiheadAttention(d_model, num_heads=4, batch_first=True, dropout=0.0)
        self.ffn = nn.Sequential(
            nn.LayerNorm(d_model),
            nn.Linear(d_model, d_model * 2),
            nn.ReLU(inplace=True),
            nn.Linear(d_model * 2, d_model),
        )
        self.state_head = nn.Linear(d_model, num_states)
        self.severity_head = nn.Linear(d_model, num_severities)

    def forward(self, x, camera_mask=None):
        b, n, c, h, w = x.shape
        if n != self.num_cameras:
            raise ValueError(f"expected {self.num_cameras} cameras, got {n}")
        flat = x.reshape(b * n, c, h, w)
        feat = self.project(self.encoder(flat)).reshape(b, n, -1)
        cam_ids = torch.arange(n, device=x.device).unsqueeze(0).expand(b, n)
        feat = feat + self.camera_embed(cam_ids)
        key_padding_mask = None
        if camera_mask is not None:
            key_padding_mask = ~camera_mask.bool()
        ctx, weights = self.attn(feat, feat, feat, key_padding_mask=key_padding_mask, need_weights=True)
        ctx = ctx + self.ffn(ctx)
        return {
            "state_logits": self.state_head(ctx),
            "severity_logits": self.severity_head(ctx),
            "attention": weights,
        }


def build_model(config=None):
    config = config or {}
    model_type = config.get("model_type", "tiny_cnn")
    if model_type == "tiny_cnn":
        return TinyCameraVqaNet()
    if model_type == "perceiver_context":
        return MultiCameraPerceiverVqaNet()
    raise ValueError(f"unsupported model_type: {model_type}")
