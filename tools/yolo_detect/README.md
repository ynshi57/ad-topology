# yolo_detect

YOLOv11 离线推理工具：把 ad-topology 的 mcap 摄像头流跑一遍，输出 JSON sidecar 给前端叠加显示，对比 onemodel 的 `/perception/obj_infer` 输出。

## 安装

```bash
cd ad-topology/tools/yolo_detect

# 推荐用独立 venv，免得污染主环境
python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
# 第一次会下 ~110MB 的 yolo11x.pt 到 ~/.config/Ultralytics/
```

依赖说明：

| 包 | 用途 |
|---|---|
| `ultralytics` | YOLOv11 模型 + 推理 |
| `mcap` | 读 mcap 文件 |
| `av` (PyAV) | H264 解码（用于 record-converted mcap 的 VideoStream） |
| `pillow-avif-plugin` + `Pillow` | AVIF 解码（用于 camera.mcap 的 foxglove.CompressedImage） |
| `opencv-python-headless` | 图像处理 |
| `fzstd` | mcap zstd 压缩支持 |

## 用法

```bash
python detect.py --mcap /home/caros/workspace/20260416204101545.mcap

# 输出: /home/caros/workspace/20260416204101545.yolo.json
```

ad-topology 前端**自动 fetch** 同名 sidecar，没装就走原有流程，无副作用。

### 常用参数

```bash
# 切换模型（精度↑ vs 速度↑）
python detect.py --mcap ... --model yolo11n   # 2.6M  ~10ms/img CPU
python detect.py --mcap ... --model yolo11m   # 20M   ~40ms/img CPU
python detect.py --mcap ... --model yolo11x   # 57M  ~100ms/img CPU (默认)

# 指定运行设备
python detect.py --mcap ... --device cuda:0   # 有 GPU 时
python detect.py --mcap ... --device cpu      # 强制 CPU
python detect.py --mcap ... --device auto     # 默认，自动选

# 只跑指定相机
python detect.py --mcap ... --topics /sensor/camera/front_left_1/image/video,/sensor/camera/front_right_10/image/video

# 跳过 fisheye 相机（减少边缘畸变误检）
python detect.py --mcap ... --skip-fisheye

# 烟雾测试（每路只跑前 10 帧）
python detect.py --mcap ... --max-frames-per-cam 10

# 调阈值
python detect.py --mcap ... --conf 0.4 --iou 0.5

# 自定义输出路径
python detect.py --mcap input.mcap --output /tmp/custom.yolo.json
```

## 性能参考

| 数据规模 | 模型 | GPU (RTX 3090) | CPU |
|---------|-----|---------------|-----|
| 12 cam × 200 帧 = 2400 推理 | yolo11n | ~15s | ~3 min |
| 12 cam × 200 帧 = 2400 推理 | yolo11m | ~25s | ~10 min |
| 12 cam × 200 帧 = 2400 推理 | yolo11x | ~45s | ~25 min |

帧解码（H264 / AVIF）大概占 30-60s，是 CPU bound。

## 输出格式

JSON sidecar 结构：

```json
{
  "model": "yolo11x",
  "version": "1.0",
  "generated_at": "2026-05-08T16:00:00Z",
  "mcap_file": "/path/to/input.mcap",
  "conf_threshold": 0.25,
  "iou_threshold": 0.5,
  "frames": [
    {
      "topic": "/sensor/camera/front_left_1/image/video",
      "log_time_ns": 1776343246595000000,
      "image_w": 1920,
      "image_h": 1536,
      "detections": [
        {
          "class_id": 0,
          "class_name": "person",
          "confidence": 0.85,
          "bbox": [320.5, 200.0, 480.2, 600.1]
        }
      ]
    }
  ]
}
```

`bbox` 是原图像素坐标 `[x1, y1, x2, y2]`。前端按显示尺寸缩放。

## 类别过滤

默认 `--relevant-only`：只保留自动驾驶相关的 COCO 类：

| class_id | name |
|---|---|
| 0 | person |
| 1 | bicycle |
| 2 | car |
| 3 | motorcycle |
| 5 | bus |
| 7 | truck |
| 9 | traffic light |
| 11 | stop sign |

加 `--relevant-only=False`（暂未实现 toggle）可保留全部 80 类。

## 已知限制

- **Fisheye 边缘误检**：YOLO 是在透视图像上训练的，fisheye 边缘的强烈畸变会导致误检；`--skip-fisheye` 跳过 4 路鱼眼
- **TLD 类别粒度粗**：YOLO 只输出 "traffic light" 这一类，不区分红/黄/绿和方向。和 onemodel 直接比 TLD 不公平，作 reference 用
- **每路相机独立 H264 decoder**：state machine 跟着 record 顺序走，**不要并发**（PyAV codec 不是线程安全的）
- **GPU 推理**：第一次会编译 cuda kernel，cold-start 多 5-10s

## 调试

如果输出帧数明显不对，先用 mcap 工具检查：

```bash
mcap info /home/caros/workspace/20260416204101545.mcap | grep camera
```

每路相机应该有 ~150-210 条消息（10Hz × 16s）。
