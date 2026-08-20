---
name: camera-yolo-loop
description: >-
  ad-topology 相机 YOLO 检测的 AI 自闭环调优。用户给一个优化目标（如"前视远处车漏检多"、
  "红绿灯误报"、"换相机就抖"、"想在精度不掉的前提下更快"）+ 一个或多个 mcap，Agent 自动执行：
  目标接入 → 基线画像 → 根因分析 → 方案（旋钮/预处理/微调）→ sweep 执行 → 多目标验证 → 失败回溯 → 最优配置沉淀
  的完整闭环。核心约束：ad-topology 里 YOLO 无 bbox 真值，故用 teacher 伪真值 / 跨模态 obj_infer /
  小 held-out 真值 / LLM 裁判 作为验证信号，优化的是"精度↔召回↔延迟↔稳定"的多目标权衡而非单一 pass/fail。
  当用户提到 YOLO 调优/优化、camera 检测指标、漏检/误报、换模型或调 conf/iou/分辨率、
  ad-topology camera view 的 Model Lab 时使用。
---

# Camera YOLO 自闭环调优

本 Skill 让 Agent 对 ad-topology 相机视图里的 YOLO 检测做**证据驱动的自闭环调优**:
目标接入 → 基线画像 → 根因分析 → 方案(旋钮/预处理/微调) → sweep 执行 → 多目标验证 → 失败回溯 → 最优配置沉淀。
全程用追踪文档留证、用独立 Critic 对抗审查、迭代有界。以下三条铁律**违反视为执行失败**。

> 设计思想借鉴自 planning 仓库的 pnc-self-loop,但本 skill **自包含**、面向 YOLO 检测业务,无需阅读该 skill 即可执行。

## 铁律（相机 YOLO 调优的三条根本约束，必须先内化）

1. **无客观真值 → 必须先锚定"验证信号"**。ad-topology 的 YOLO sidecar 没有 bbox GT、没有 mAP。
   任何"变好了"的结论**必须**建立在一个显式验证信号上（Step 1b 强制选定），四选一或组合：
   - `teacher`：大模型/高分辨率(yolo11x@高 imgsz)当伪真值，算 pseudo-mAP / 漏检-多检（推荐主力，零标注）
   - `cross_modal`：与车端感知 `/perception/obj_infer` 对齐，agreement 当信号（独立来源，推荐辅助）
   - `held_out_gt`：人工标少量 bbox 真值（几十~几百帧）算**真** mAP（最可信，最终校准锚）
   - `llm_judge`：VLM 抽样判"漏检/误报"（近似 Critic，防代理刷分）
2. **多目标权衡，非二元 pass/fail**。不存在单一"修好/没修好"：优化的是帕累托前沿，验收 =
   **目标指标达到阈值 且 护栏指标不回退**（延迟、precision、误报、jitter），二者由 Step 1b / Step 12 定死。
3. **反 Goodhart 是第一优先**。代理信号（直方图/计数/jitter）**只是"看起来稳不稳",不是"对不对"**。
   严禁用"提高 conf 让直方图变干净"这类刷代理分数冒充改进。每次"改进"必须过 Critic + 护栏 + 参照集三重复核（Step 17）。

## 模式选择（2×2）

| 维度 1 执行模式 | 维度 2 闭环模式 |
|---|---|
| `strict` 逐步不跳步 / `flexible` 以本 Skill 为参考框架 | `hitl` 关键点暂停 / `auto` 全自动 |

未选默认 `strict + hitl`。用户在调用时可预先指定（如"flexible+auto 跑这个"），否则 Step 1c 用 `AskQuestion` 询问。
`🅰` 标记的步骤在 hitl 暂停、auto 跳过。

## Critic Verdict 处置（强制）

Critic subagent（Step 9 根因审查 + Step 13 方案审查 + Step 17 反 Goodhart 复核）返回 verdict 机械处置：

| Verdict | 处置 | 计数 |
|---|---|---|
| PASS | 继续 | — |
| CHALLENGE / REVISE | 补证据/改细节 → 重审（同假设，`critic_subround +1`，≤3 轮） | critic_subround |
| REJECT | 该假设/方案废弃 → 用反证当种子回到 Step 6（根因）或 Step 11（方案），`round_count +1` | round_count |

- `critic_subround` per-假设 ≥3 且未 PASS → 视为 REJECT。
- `round_count`（全局重生成次数）> 5 **且** 至少跑过 1 次完整 sweep 验证仍未达标 → 才触发 Step 20 人工介入。
- **严禁**把 REJECT 当失败退场；REJECT 是下一轮的种子。**严禁**列 A/B/C 配置清单让用户选而不实施——本 skill 的职责是**实施 + 验证**,不是把决策推回用户。

---

## Phase 1: 目标接入

> 参考: [stages/01-intake.md](stages/01-intake.md), [stages/00-tracking-doc.md](stages/00-tracking-doc.md)

顺序: Step 1a → **Step 1b（★ 校验 Gate，最先）** → Step 1c（模式）→ Step 1d（数据准备）。

**Step 1a** — 识别输入: mcap 路径/URL、优化目标描述文字、（可选）已有 sidecar。只分类不深挖。

**Step 1b** — 三段式 ★ 强制校验（**只看用户 chat 实质描述**，缺任一字段必须暂停追问，不接受"待分析"占位）:

| 段 | 字段 | 说明 |
|---|---|---|
| §1 目标 | ★ 优化对象 | 哪些相机/场景（前视远距离 / 夜间 / 鱼眼 / 路口…） |
| | ★ 当前不满意的表现 | 漏检远车 / 误报红绿灯 / 换相机就抖 / 太慢… |
| | ★ 什么算"更好" | 目标指标 + 期望方向（如"远处车召回↑"） |
| §2 约束 | ★ 护栏指标 | 不许回退的（延迟上限、precision 下限、误报上限、jitter 上限） |
| | ★ 优化范围 | `infer_cfg`(model/conf/iou/imgsz/device) / `+preprocess` / `+finetune` |
| §3 验证 | ★ 验证信号 | teacher / cross_modal / held_out_gt / llm_judge（见铁律 1，可组合） |
| | ★ 验收方式 | 在哪个 mcap 集上、目标指标达到多少、护栏不破 |

**Step 1c** — 确认 `exec_mode` + `loop_mode`（`AskQuestion` 结构化选项；已预选则复用）。

**Step 1d** — 数据准备: 确认 mcap 是**服务器绝对路径**（`/yolo-detect` 需要，见 [references/infra-and-gaps.md](references/infra-and-gaps.md)）;
`held_out_gt` 时确认/建立标注集; 创建追踪文档 `/tmp/yolo_loop_tracking/{case_id}.md`（`case_id = {mcap stem}-{目标关键词}`）。

**Step 1e** — 合并 §1/§2/§3 写入追踪文档，7 个 ★ 全为用户实质回答方可继续。

---

## Phase 2: 基线画像（Triage）

> 参考: [stages/02-baseline-triage.md](stages/02-baseline-triage.md)

**Step 2** — 跑当前配置。用 `/yolo-detect`（或 `detect.py`）以**当前默认配置**（UI 默认 yolo11n@conf0.25）跑目标 mcap，得基线 sidecar。

**Step 3** — 建参照（reference）。按 Step 1b 选定的验证信号建立参照:
`teacher` → 用 yolo11x + 高 imgsz 跑同一 mcap 当伪真值; `cross_modal` → 提取 `/perception/obj_infer` 检测框;
`held_out_gt` → 载入人工真值; `llm_judge` → 备好抽样帧。**没有参照 = 无法验证 = 不允许进入后续 Phase**。

**Step 4** — 基线指标。用评估 harness（[references/signals-and-metrics.md](references/signals-and-metrics.md)）算:
目标指标（对参照的 pseudo-mAP/召回/精度 或 agreement）、护栏指标（延迟、误报率、jitter）、以及现成代理指标（置信度直方图/每相机计数/时序 jitter）。**分场景/分相机拆开**，别只看总分。

**Step 5** — Triage 判定。对比基线指标 vs 用户目标: 短板是否真实成立?
- 已达标 → 记录"当前配置已足够"+归因 → 跳 Step 21
- 有明确短板 → 写入 §2，继续 Step 6

---

## Phase 3: 根因分析（为什么检测差）

> 参考: [stages/03-root-cause.md](stages/03-root-cause.md)

**Step 6** — 生成 **≥3 个** 候选假设（每个含 description / confidence / 证伪方式）。常见根因谱系:
模型容量不足(yolo11n) · conf 阈值不当 · 输入分辨率/letterbox 丢小目标 · 鱼眼畸变 · 解码质量(AVIF/H264 伪影) · 类别混淆 · COCO↔AD 域差 · NMS(iou) 过严/过松。

**Step 7** — 逐个证伪，分层置信度（**每验一个立即写追踪文档**）:
- L1 配置/代码(+0.1) · L2 指标对比(+0.3,必须) · L3 分场景/时序(+0.2,必须) · L4 视觉抽帧(+0.2)
- 典型证伪: 换高分辨率能捞回远车 → 分辨率瓶颈; teacher 有 student 没有 → 容量瓶颈; 仅鱼眼相机差 → 畸变。

**Step 8** — 视觉抽帧确认（条件）。从目标相机抽 ≥3 帧叠框图（漏/误报点位），存 `{tracking_dir}/frames/`,肉眼确认与指标结论一致。

**Step 9** — Dispatch Critic subagent（根因 + 证据链 + checklist）。原文入档,按 § Critic 处置。**禁止 self-review**。

**Step 10** `🅰` — 展示根因,等确认（auto 跳过）。

---

## Phase 4: 聚类匹配

**Step 11a** — 匹配已知失败模式（小目标/夜间/运动模糊/鱼眼/远距离）+ 历史最优配置卡（Phase 7 沉淀）。命中则复用其方案方向。

---

## Phase 5: 方案 + 评估计划

> 参考: [stages/05-sweep-and-eval.md](stages/05-sweep-and-eval.md)

**Step 11** — 定义 sweep 空间。按根因 + `优化范围` 选旋钮及取值:
`model`(n/s/m/l/x) · `conf` · `iou` · `imgsz` · `device`;（`+preprocess` 时含鱼眼校正/分辨率/解码; `+finetune` 时转训练闭环）。
一次聚焦 **1~2 个主旋钮**，避免维度爆炸。

**Step 12** — 定评估计划（本闭环的多目标验收标尺，先定死"怎么算赢"）:
- **目标指标 + 达标阈值**（对参照）
- **护栏指标 + 下限/上限**（延迟、precision、误报、jitter，任一破线该配置判负）
- **参照集 + held-out 划分**（防止对参照过拟合）
- 输出 `eval_plan`（YAML，格式见 stages 文档）

**Step 13** — Dispatch Critic（方案 + 评估计划审查: 旋钮是否对症、护栏是否齐全、是否会 Goodhart）。原文入档,按 § 处置。

**Step 14** `🅰` — 展示方案,等确认（auto 跳过）。

---

## Phase 6: 执行 + 验证

> 参考: [stages/06-verification.md](stages/06-verification.md)

**Step 15** — 跑 sweep。对 sweep 空间每个配置调 `/yolo-detect` 产出 sidecar（并行/批量;记录每配置的 model/conf/device/延迟）。

**Step 16** — 打分。用 harness 对每个 sidecar vs 参照算目标指标 + 护栏指标,生成 **before/after + 帕累托表**。

**Step 17** — 反 Goodhart 三重复核（**核心**）:
1. **护栏**: 目标指标↑ 但任一护栏破线 → 判负。
2. **held-out**: 在未用于选参照的数据上复算,提升是否保持。
3. **视觉双通道**: 抽帧对比 before/after（漏检是否真减少、误报是否真下降）,存 `{tracking_dir}/verify_frames/`。
- 三者一致才算真改进; 矛盾 → Dispatch Critic 复查 → 按 § 处置（可能回 Step 6/11）。

**Step 18** — 判定: 目标达标 + 护栏守住 + 视觉确认 → Step 21; 否则 → Step 19。

## Phase 6.5: 失败回溯

**Step 19** — 诊断: 根因错 / 旋钮选错 / 评估信号不可信 / 参照有偏。写入追踪文档。

**Step 20** — 回退（`🅰` 展示诊断,auto 自选）:
- 根因错 → Step 6（`round_count +1`）· 旋钮错 → Step 11 · 信号/参照有偏 → Step 3 重建参照 · 达 Step 20 硬条件 → 人工介入报告并终止。

---

## Phase 7: 沉淀

**Step 21** — 写"最优配置卡": 场景 → 推荐 (model, conf, iou, imgsz, device) + 达到的指标 + 权衡说明。

**Step 22** — 教训总结: 该场景的瓶颈类型、参照信号可信度评估、同类调优方向。

**Step 23** — 输出报告 + （可选）把最优默认写回 UI 默认值建议（**只建议,不擅改代码**,除非用户批准）。

---

## 回退路径速查

| 条件 | 回退到 |
|---|---|
| Triage 已达标 | Step 21 |
| 根因 Critic REJECT | Step 6（`round_count +1`） |
| 方案 Critic REJECT | Step 11 |
| Step 17 护栏破/held-out 不保持/视觉矛盾 | Step 6 或 Step 11（按诊断） |
| 评估信号/参照被判不可信 | Step 3 重建参照 |
| `round_count > 5` 且 ≥1 次完整 sweep 未达标 | Step 20 人工介入 |

## 依赖与现有基础

| 用途 | 位置 |
|---|---|
| 参数化推理 | `POST /yolo-detect`（model/device/conf/skipFisheye/maxFramesPerCam，NDJSON 流式） |
| 检测 CLI（更多旋钮） | `tools/yolo_detect/detect.py`（iou/imgsz 经 export/batch/topics/relevant-only） |
| sidecar schema / 指标 | 见 [references/signals-and-metrics.md](references/signals-and-metrics.md) |
| 现成代理指标 | `src/camera-panel.js` computeYoloMetrics/computeStability（直方图/每相机/jitter） |
| 静态模型成本 | `POST /model-analyze`（算子/大小/健康） + Netron |
| 跨模态参照 | 车端 `/perception/obj_infer`（onemodel 检测框） |
| **需补的基础设施** | Python 评估 harness（pseudo-mAP/agreement）、暴露 iou/imgsz、sidecar 补运行元数据、bbox 标注（held-out）。见 [references/infra-and-gaps.md](references/infra-and-gaps.md) |
