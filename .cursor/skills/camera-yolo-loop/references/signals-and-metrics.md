# 验证信号与指标（无 bbox 真值下如何打分）

> 核心思想：ad-topology 的 YOLO sidecar 没有 bbox 真值。要闭环调优，必须先造一个"验证信号"当参照，
> 再在它之上算目标指标与护栏指标。**代理指标（直方图/计数/jitter）只反映稳定性，不反映正确性**——
> 单独用它们调优会 Goodhart。

## 一、四种验证信号（Step 1b 选定，可组合）

| 信号 | 怎么建参照 | 能算什么 | 成本 | 可信度 | 主要偏差风险 |
|---|---|---|---|---|---|
| `teacher` 伪真值 | yolo11x + 高 imgsz（如 1280）+ 可选 TTA 跑同一 mcap | pseudo-mAP、student 相对 teacher 的漏检/多检 | 低（纯推理） | 中 | teacher 自身错误被当真值；COCO↔AD 域差 |
| `cross_modal` 跨模态 | 提取车端 `/perception/obj_infer` 检测框（onemodel） | 与上车模型的 agreement、YOLO 独有/缺失框 | 中 | 中高（独立来源） | 坐标系/时间戳对齐；类别映射差异 |
| `held_out_gt` 人工真值 | 采样帧标 bbox（几十~几百帧），存标注集 | **真** mAP / precision / recall | 高（人工） | 高 | 样本量小、场景覆盖不足 |
| `llm_judge` VLM 裁判 | 抽样帧 + 检测框喂 VLM，问"漏检/误报/框歪" | 定性 error 计数、方向判断 | 中 | 中（有幻觉） | 提示词偏差、不稳定 |

**推荐组合**：`teacher`（主力自动信号，驱动 sweep）+ `cross_modal`（独立交叉验证，防 teacher 系统偏差）
+ `held_out_gt` 小集（几十帧，只用于**校准前两者是否可信** + 最终验收，不驱动 sweep）。

**参照可信度自检（必做）**：在 `held_out_gt` 小集上，检查 teacher/cross_modal 与真值的一致性；
若 teacher 与真值差异过大 → 该场景不适合用 teacher，降级到 held_out_gt 或换更强 teacher。

## 二、匹配与打分（pseudo-mAP 的算法约定）

对"预测框集合"vs"参照框集合"逐帧、逐类做匹配：

1. **匹配**：同 `class_id`，按 IoU 贪心一对一（IoU 阈值默认 0.5，小目标可放到 0.3 并单列）。
2. **计数**：匹配上 = TP；参照有预测无 = FN（漏检）；预测有参照无 = FP（多检/误报）。
3. **指标**：
   - `recall = TP / (TP + FN)`（对参照的召回；`teacher` 下即"追回 teacher 多少框"）
   - `precision = TP / (TP + FP)`
   - `pseudo-mAP`：按 confidence 排序算 AP（多类取 mAP@0.5，或 mAP@[.5:.95]）
4. **必须分桶**：按 **相机 / 距离档（框面积代理远近）/ 类别 / 场景（日夜）** 分开算——总分会掩盖"远处小车召回崩了"这种关键短板。

> `cross_modal` 时先做坐标系与时间戳对齐（YOLO 是像素框、obj_infer 常是 3D/BEV，需投影到同一平面或用 BEV 底边中心，
> 参考 `bev-renderer.js` 的 `projectDetectionToBev`），类别做映射表后再按上面匹配。

## 三、护栏指标（任一破线 → 该配置判负）

| 护栏 | 来源 | 典型阈值（由 Step 1b 用户定） |
|---|---|---|
| 延迟 / 吞吐 | sweep 时记录每配置推理耗时（需 sidecar 补运行元数据，见 infra-and-gaps） | 不超过基线 X ms/帧 |
| precision（误报） | 上面 pseudo/真值计算 | 不低于基线；特定类（红绿灯）误报不增 |
| jitter 时序稳定 | 现成 `computeStability`（相邻帧同类框中心位移中位数/对角线） | 不高于基线 |
| 模型体积/算力 | `/model-analyze`（参数量、算子数、文件大小） | 视部署约束 |

## 四、现成代理指标（辅助，不作唯一依据）

来自 `src/camera-panel.js`（`computeYoloMetrics` / `computeStability`）：

- **置信度直方图**：5 桶 `[0-0.4)…[0.85-1]`。用途：看阈值敏感区，**不能**用"低分框变少"当改进。
- **每相机检测数**：定位哪台相机异常（骤降=漏检，骤增=误报）。
- **时序 jitter**：相邻帧贪心 IoU 匹配（阈 0.3）后中心位移/图像对角线的中位数×100（%）。低=稳。

## 五、sidecar schema（打分输入）

`detect.py` 写出 `<mcap>.yolo.json`：

```
{ model, version, generated_at, mcap_file, conf_threshold, iou_threshold,
  frames: [ { topic, log_time_ns, image_w, image_h,
              detections: [ { class_id, class_name, confidence, bbox:[x1,y1,x2,y2](原图像素) } ] } ] }
```

注意：**无** per-frame camera 短名（用 topic）、**无** 运行元数据（device/延迟/batch）、**无** 顶层 summary。
相机 = `topic`，时间 = `log_time_ns`。AD 相关类：person/bicycle/car/motorcycle/bus/truck/traffic light/stop sign（`RELEVANT_CLASS_IDS`）。

## 六、eval_plan 输出格式（Step 12）

```yaml
eval_plan:
  signal: [teacher, cross_modal]        # 主 + 辅
  reference:
    teacher: { model: yolo11x, imgsz: 1280 }
    cross_modal: /perception/obj_infer
  holdout: { source: "标注集/独立mcap", frames: 60 }   # 只做校准+验收
  buckets: [camera, distance, class, day_night]
  targets:
    - name: 远处车召回
      metric: "recall@0.5, distance=far, class=car"
      threshold: ">= baseline + 0.10"
  guardrails:
    - { name: 延迟, metric: "ms/帧", limit: "<= baseline * 1.5" }
    - { name: 红绿灯误报, metric: "FP@traffic_light", limit: "<= baseline" }
    - { name: jitter, metric: "overallPct", limit: "<= baseline" }
  sweep:
    model: [yolo11n, yolo11s, yolo11m]
    imgsz: [640, 960, 1280]
```
