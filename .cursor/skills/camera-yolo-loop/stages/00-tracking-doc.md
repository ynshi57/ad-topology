# Stage 0: 调优追踪文档

> 核心思想：追踪文档是**调优实验日志**，不是事后总结。每完成一个 Phase 立即写，回溯时**追加新 Round 不覆盖**。
> 保证每个"变好了"的结论都能追溯到：用哪个验证信号、对哪个参照、分哪个桶、护栏有没有守住。

创建于 Step 1d：`/tmp/yolo_loop_tracking/{case_id}.md`（`case_id = {mcap stem}-{目标关键词}`）。

## 模板

```markdown
# [{case_id}] YOLO 调优追踪文档

## 基本信息
- Case ID / 创建时间 / 最后更新 / 当前状态（🔄 Round N/5 / ✅ 达标 / ⏸️ 人工介入）
- 执行模式: strict/flexible · 闭环模式: hitl/auto
- mcap 集: <路径列表>

## Phase 1: 目标接入（Step 1b/1e）
### §1 目标（★ 用户实质回答）
- ★ 优化对象 / ★ 当前不满意表现 / ★ 什么算更好
### §2 约束（★）
- ★ 护栏指标（含阈值） / ★ 优化范围（infer_cfg/+preprocess/+finetune）
### §3 验证（★）
- ★ 验证信号（teacher/cross_modal/held_out_gt/llm_judge） / ★ 验收方式

## Phase 2: 基线画像（Step 2-5）
- 基线配置: model=? conf=? imgsz=? device=?
- 参照: <信号 + 如何建>
- 基线指标（分桶）:
  | 桶（相机/距离/类别/日夜） | 目标指标 | 护栏指标 |
- Triage 判定: 已达标 / 有短板（短板描述）

## Phase 3: 根因（每轮追加 Round，不删旧）
### Round 1
- 假设表: | ID | 假设 | 初始 conf | 证伪方式 |
- 验证过程（每验一个立即写）: [时间戳] 验 Hx: 操作/数据结果/判定/证据路径
- 视觉抽帧: frames/*.png + 结论
- Confidence: L1+L2+L3+L4 = total（未执行层为 0）
- Critic 原文（完整粘贴）+ verdict
- 根因结论 + 证据链

## Phase 5: 方案 + 评估计划（每轮追加）
- sweep 空间 / eval_plan（YAML） / Critic 原文 + verdict

## Phase 6: 执行 + 验证（每轮追加）
- sweep 结果表（每配置: 目标指标 + 护栏 + 是否破线）
- before/after + 帕累托表
- 反 Goodhart 三重复核: 护栏 / held-out 复算 / 视觉双通道（verify_frames/）
- 判定: 达标 / 未达标

## Phase 6.5: 回溯记录（每次追加）
- 时间戳 / 失败类型（根因错/旋钮错/信号不可信/参照有偏） / 诊断 / 回退到 Step N

## Phase 7: 沉淀
- 最优配置卡: 场景 → (model,conf,iou,imgsz,device) + 达到指标 + 权衡
- 教训 / 参照信号可信度评估
```

## 写入规则

- Phase 完成即写；Step 7（每验一个假设）、Critic 返回、Step 16 打分、Step 17 复核 **立即写**。
- 回溯 = 追加新 Round + 在 §Phase 6.5 记一条，**绝不覆盖旧 Round**。
- 每次写入更新"最后更新"时间戳与"当前状态"。
