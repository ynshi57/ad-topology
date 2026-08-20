# Stage 2: 基线画像（Triage）

> 核心思想：先给当前配置拍一张"体检报告"，并把验证信号的参照建好。没有基线+参照就调优 =
> 无从判断"变好了没"。同时判断短板是否**真实成立**，避免在伪问题上烧算力。

## Step 2 跑基线

用**当前默认配置**跑目标 mcap。务必**显式指定 model**（避免 UI=yolo11n vs detect.py=yolo11x 的默认差）。

```bash
# 经 API（前端/服务端）: model=yolo11n, conf=0.25, skipFisheye 按需
# 或直连 CLI 拿更多控制:
python3 tools/yolo_detect/detect.py --model yolo11n --conf 0.25 --imgsz 640 <mcap>
```

## Step 3 建参照（reference）

按 Step 1b 选定信号建立"正确答案"参照：

- `teacher`：`detect.py --model yolo11x --imgsz 1280`（可再加 TTA）跑同一 mcap，产出 teacher sidecar。
- `cross_modal`：从 mcap 提取 `/perception/obj_infer` 检测框，做坐标系/时间戳对齐 + 类别映射。
- `held_out_gt`：载入人工 bbox 真值集。
- `llm_judge`：准备抽样帧集（后续按需喂 VLM）。

**参照可信度自检**（有 held_out_gt 时必做）：teacher/cross_modal 与真值在小集上的一致性；
偏差过大 → 该场景不适合该信号，降级或换更强参照。**没有可信参照，不得进入 Phase 3。**

## Step 4 基线指标（分桶！）

用评估 harness（references/signals-and-metrics.md 第二节）算：

- **目标指标**：对参照的 pseudo-mAP / recall / precision（`teacher`/`held_out_gt`）或 agreement（`cross_modal`）。
- **护栏指标**：延迟（记录每配置耗时）、误报率、jitter（现成 `computeStability`）、模型体积（`/model-analyze`）。
- **现成代理**：置信度直方图、每相机计数（辅助定位，不作结论）。

**必须分桶**：相机 / 距离档（用框面积代理远近）/ 类别 / 日夜。总分会掩盖"远处小车召回崩了"这类关键短板。

## Step 5 Triage 判定

对照 §1 目标：

- **已达标** → 记"当前配置已足够"+ 简短归因（为何够）→ 跳 Step 21，输出结论（不空转）。
- **有短板** → 把"哪个桶、哪个指标、差多少"写入追踪文档 §2 → 继续 Step 6 根因。
- **无法判断**（参照不可信/数据不足）→ 记录原因，先补参照（回 Step 3）或缩小范围。
