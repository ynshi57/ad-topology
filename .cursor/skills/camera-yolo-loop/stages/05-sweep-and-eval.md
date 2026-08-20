# Stage 5: 方案（sweep）+ 评估计划

> 核心思想：把根因翻译成"调哪个旋钮、扫哪些值"，并**先定死怎么算赢**（目标 + 护栏 + 参照 + held-out）。
> 评估计划是本闭环的验收标尺——不是二元"修好/没修好"，而是"目标指标达阈值 且 护栏指标不回退"的多目标判定。

## Step 11 定义 sweep 空间

按根因 + `优化范围` 选旋钮，**一次聚焦 1~2 个主旋钮**（避免维度爆炸）：

| 根因 | 主旋钮 | 备注 |
|---|---|---|
| 容量不足 | `model` [n,s,m,l,x] | 配合延迟护栏做精度-延迟权衡 |
| 小目标/远处漏 | `imgsz` [640,960,1280] | 经 detect.py（API 未透出，见 infra-and-gaps） |
| 召回/误报平衡 | `conf` [0.15…0.4] | 扫 PR 曲线选工作点 |
| 重叠目标 | `iou` [0.3…0.7] | NMS，detect.py |
| 鱼眼 | `skipFisheye` / 畸变校正 | `+preprocess` 范围才做 |
| 域差严重 | → 转 `+finetune` | 重成本闭环，需 GT/训练数据 |

`+finetune` 时转训练：需 held_out_gt 扩成训练集，参考 `tools/camera_vqa/train.py` 的流程骨架（那是分类，检测需换 Ultralytics 训练管线）。

## Step 12 评估计划（eval_plan）

输出 YAML（完整字段见 references/signals-and-metrics.md 第六节），必含：

- `signal` + `reference`：主/辅验证信号及如何建参照
- `holdout`：只用于校准信号可信度 + 最终验收，**不参与选参照/调参**（防过拟合参照）
- `buckets`：相机/距离/类别/日夜
- `targets`：目标指标 + 达标阈值（相对 baseline）
- `guardrails`：延迟/precision/误报/jitter/体积 的上下限（**任一破线该配置判负**）

## Step 13 Critic subagent（方案 + 评估计划审查）

checklist：旋钮是否对症根因、护栏是否齐全（尤其延迟与误报）、参照是否会导致 Goodhart（如只对 teacher 过拟合）、
held-out 是否真正独立。原文入档，verdict 按 § 处置（REJECT→回 Step 11；根因存疑→回 Step 6）。

## Step 14 `🅰` 展示方案确认

hitl 暂停；auto 跳过。REJECT → 回 Step 11。
