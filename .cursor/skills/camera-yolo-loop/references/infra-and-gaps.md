# 现有基础设施与缺口（调优前必读）

盘点自 ad-topology 现状。**"已现成"可直接当积木；"缺口"需要先补，或在 flexible 模式下用 `detect.py` 直连绕过。**

## 已现成

### 参数化推理 API — `POST /yolo-detect`（`server/index.js` `handleYoloDetect`）

- Body: `{ mcapPath, model, device, conf, skipFisheye, maxFramesPerCam }`，NDJSON 流式（`start`/`log`/`done`）。
- 前置：`mcapPath` 必须是**服务器绝对路径**（UI 用"Load from server path"加载的才有）。缺失时 Run 报 "No mcap server path"。
- 输出固定：`<mcapPath 去 .mcap>.yolo.json`。
- 服务端兜底：非法 model→`yolo11n`；conf 夹到 `[0.01,0.99]`；`maxFramesPerCam` 支持但 UI 不传。
- 前端驱动：`src/yolo-runner.js` `runYoloDetect(opts)`。

### 检测 CLI（更多旋钮）— `tools/yolo_detect/detect.py`

argparse 支持且 **API 未透出** 的旋钮：`--iou`(默认0.5) · `--imgsz`(经 export，默认640) · `--batch`(8) ·
`--topics` · `--relevant-only`(默认True，仅 8 类) · `--max-frames-per-cam`。
权重解析序：`$YOLO_WEIGHTS_DIR/<model>.pt` → `/home/caros/workspace/yolo_weights/<model>.pt` → 脚本目录 → Ultralytics 自动下载。
> flexible 模式下需要 iou/imgsz sweep 时，直接命令行调 `detect.py` 指定输出路径，绕过 API 限制。

### 现成指标（JS）— `src/camera-panel.js`

`computeYoloMetrics`（直方图/每相机/类别计数）、`computeStability`（时序 jitter，相邻帧贪心 IoU 匹配阈 0.3）。
**注意：都在浏览器端**，harness 化需在 Python 侧重写（见下）。

### 静态模型成本 — `POST /model-analyze` + Netron

返回 ONNX 算子分布/数量、参数量、文件大小、健康检查（checker/shape-inference）、Ultralytics 元信息。
用于护栏里的"模型体积/算力"。`POST /netron-launch` 开可视化。测试参考 `scripts/test-model-analyze.js`。

### 跨模态参照 — 车端 `/perception/obj_infer`

onemodel 的感知检测框，可作 `cross_modal` 验证信号的独立来源。BEV 投影可参考 `src/bev-renderer.js` `projectDetectionToBev`。

### 已有 sidecar 发现 — `list-mcaps` 的 `sidecarSummary`

`{model, frames, totalDetections}`，drop-zone recents 显示 `YOLO yolo11x · N dets`。可用于跳过重复推理。

### 可当 eval-harness 模板的 camera_vqa 栈

`tools/camera_vqa/{train,evaluate}.py` + `POST /camera-vqa-train|evaluate`：分类精度/混淆矩阵/确定性重跑的**流程骨架**可借鉴（但那是图像级分类，不是检测）。

## 缺口（需补，按优先级）

1. **Python 评估 harness（最核心）**：输入两个 sidecar（预测 + teacher 参照）或 sidecar + obj_infer/真值，
   输出分桶 pseudo-mAP/recall/precision + agreement。现状指标全在 JS 且**无任何真值/参照对比**。
   → 建议新增 `tools/yolo_eval/score.py`（匹配算法见 signals-and-metrics.md 第二节）。
2. **暴露 iou/imgsz（及 batch/topics）到 API**：sweep 分辨率/NMS 必需；现仅 `detect.py` 命令行可用。
3. **sidecar 补运行元数据**：device / 每配置推理延迟 / batch / imgsz —— 否则无法做"精度 vs 延迟"权衡（护栏缺延迟项）。
4. **bbox 标注（held_out）**：Label Tool 现只做 VQA 图像级状态（clean/wet/blur…），**无 bbox schema/UI**。
   做真值集需扩 schema + 标注界面（或用外部工具标好导入）。
5. **sweep 编排器**：把"多配置 × /yolo-detect × harness 打分 × 帕累托表"串起来（可先脚本化）。

## 关键默认值坑

- **默认 model 不一致**：UI/`yolo-runner`/服务端兜底 = `yolo11n`；`detect.py` 独立跑默认 `yolo11x`。基线务必**显式指定 model**，别踩这个默认差。
- `skipFisheye`：UI 默认**勾选**（跳过鱼眼），`detect.py` 默认 False。鱼眼场景调优记得关掉。
