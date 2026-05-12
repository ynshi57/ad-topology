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

## 模型可视化（Netron 集成）

ad-topology Camera View 的 YOLO 面板自带一个 **View Model** 按钮，可以直接打开 Netron 查看模型每一层的 input/output shape 和参数量。

### 用法

1. Camera View → 右下 YOLO panel
2. 选模型（默认是最近一次 Run 用的那个）：`yolo11n` / `yolo11s` / `yolo11m` / `yolo11l` / `yolo11x`
3. 点 **View Model** —— 新 tab 自动打开，加载 Netron + 模型 graph

### 工作流程（**重构后：无子进程**）

Netron 的 `server.py` 实际上只是一个静态文件服务器（serves the netron python package + 一个用户传入的 model 文件）。我们 Express **直接接管**这件事，不再 spawn netron 子进程。

```
点击按钮
   ↓
POST /netron-launch { model: "yolo11x" }
   ↓
Express 检查 /home/caros/workspace/yolo_weights/<model>.onnx
   ├── 不存在 → spawn export_onnx.py 自动导出（首次 ~10-30s）
   └── 已存在 → 直接 return
   ↓
返回 { proxyPath: "/netron/<model>/" }      （不 spawn 任何 viewer 进程）
   ↓
浏览器新 tab → http://<host>/netron/<model>/   （vite 把 /netron/* 代理到 :8765）
   ↓
Express 直接 read netron 包目录的 index.html / grapher.css / index.js / *.json /
icon.png 返回；index.html 注入 <meta name="file" content="/netron/<model>/data/<model>.onnx">
   ↓
Netron 前端 fetch /netron/<model>/data/<model>.onnx
   ↓
Express 把 yolo_weights/<model>.onnx 直接 stream 回去
   ↓
Netron 渲染完整模型 graph
```

#### 这个架构能彻底避免

| 旧问题 | 新实现 |
|---|---|
| netron 子进程占用端口、`EADDRINUSE` | 没有子进程 |
| Express 重启后 `netronProcs` Map 丢失 → 503 | 无状态，任何时候 GET 都能跑 |
| 切模型导致多个 netron 进程累积 | 同上 |
| readiness race（端口被孤儿占着，假阳性 ready） | 没有 spawn |
| Express crash 后留下孤儿 netron 进程 | 没有可孤儿化的进程 |

### 排错

- **报错 "netron python package not installed"**：`pip3 install --user netron`
- **报错 "ONNX export failed"**：模型 `.pt` 是 LFS pointer（134 字节），不是真模型文件。把真 `.pt` 拷到 `/home/caros/workspace/yolo_weights/`
- **Netron 页面打开但模型不加载**：用主界面右下的 **Debug Log** 面板看 Network 错误（`/netron/<model>/data/...` 是否 404）
- **首次点击等 10–30s**：那是 `export_onnx.py` 在跑，正常；后续切回同模型瞬开
- **netron 升级后路径变了**：server 启动时执行 `python3 -c "import netron"` 动态拿包路径，不需要硬编码

## In-app Debug Log

ad-topology 现在自带一个浏览器内的 Debug Log 面板（屏幕底部一条窄条，点击展开），统一展示：

- **前端 console.log/info/warn/error**（拦截，原 stdout 仍正常输出）
- **后端 Express 输出**（通过 `GET /server-log/stream` SSE 实时推过来；server 启动时拦截 `console.*` 写入 ring buffer，新连接会重放最近 500 条）
- **window error / unhandledrejection** 也会被吃进来

不需要再开浏览器开发者模式即可调试。控件：

- `Pause` / `Resume`：暂停接收
- `Clear`：清空历史
- `FE` / `BE`：过滤来源
- 等级下拉：log / info / warn / error 最低过滤
- 拖拽（点击 header）展开/收起

### 手动 CLI 用法（不通过 UI）

```bash
# 导出指定模型为 ONNX
python3 tools/yolo_detect/export_onnx.py yolo11x

# 导出全部 5 个模型
python3 tools/yolo_detect/export_onnx.py --all

# 重新导出（覆盖已存在的 .onnx）
python3 tools/yolo_detect/export_onnx.py yolo11x --force

# 直接打开 Netron（不通过 ad-topology）
netron /home/caros/workspace/yolo_weights/yolo11x.onnx
# → 浏览器自动打开 localhost:8080
```
