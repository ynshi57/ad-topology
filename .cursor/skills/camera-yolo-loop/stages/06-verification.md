# Stage 6: 执行 + 验证（含反 Goodhart）

> 核心思想：跑 sweep 拿到一堆配置后，最危险的不是"没提升"，而是"代理指标提升了但实际变差"。
> 所以验证的重心是**反 Goodhart 三重复核**：护栏、held-out、视觉双通道，三者一致才算真赢。

## Step 15 跑 sweep

对 sweep 空间每个配置调 `/yolo-detect`（或 `detect.py` 直连拿 iou/imgsz）产 sidecar。
**记录每配置的运行元数据**（model/conf/imgsz/device/推理延迟）——延迟护栏靠它（sidecar 目前不存，需从 NDJSON 日志或计时抓，见 infra-and-gaps）。

## Step 16 打分

用 harness 对每个 sidecar vs 参照算 目标指标 + 护栏指标，**分桶**。产出：

- before/after 表（基线 vs 各配置）
- 帕累托表（目标指标 × 延迟/precision），标出被护栏淘汰的配置

## Step 17 反 Goodhart 三重复核（核心，缺一不可）

1. **护栏**：目标指标↑ 但任一护栏破线 → 判负，不算改进。
2. **held-out 复算**：在**未用于选参照/调参**的数据（held_out_gt 小集或独立 mcap）上复算目标指标，提升是否保持。
   - 若参照是 teacher：额外确认不是"只对 teacher 的错误过拟合"——held_out_gt 上是否也提升。
3. **视觉双通道**：抽同一批点位的帧，before/after 叠框对比，肉眼确认漏检真减少、误报真下降。存 `{tracking_dir}/verify_frames/`。

三者一致 → 真改进。任何矛盾（指标升但视觉更糟 / held-out 不保持）→ Dispatch Critic 复查，按 § 处置（多半回 Step 6 或 Step 11）。

## Step 18 判定

- 目标达标 + 护栏守住 + 视觉确认 → 选定最优配置 → Step 21 沉淀。
- 否则 → Step 19 失败回溯。

## Step 19 诊断失败类型

- **根因错**：换了对症旋钮也没用 → 根因判断有误 → Step 6（`round_count +1`）
- **旋钮/取值错**：方向对但范围不够/选错值 → Step 11
- **信号/参照有偏**：teacher 本身不靠谱、cross_modal 对齐错 → Step 3 重建参照
- **达 Step 20 硬条件**（`round_count > 5` 且 ≥1 次完整 sweep 未达标）→ 人工介入报告并终止

## Step 20 人工介入（硬触发才可进）

生成结构化报告：已验证事实、已排除假设、缩小后的瓶颈范围、参照可信度评估、下一步建议（如"该场景 COCO 域差大，需 finetune + 标注"）。写入追踪文档 → 终止。
**严禁**因 Critic REJECT 累计 / 多层根因 / "诚实汇报" 而提前退到 Step 20。
