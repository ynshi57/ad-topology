# Attribution Workflow

ad-topology 的归因工作台：通过 6 个阶段结构化地分析一个 executor 模块在离线回放中的表现，自动发现问题并产出可审查的证据报告。

## 阶段定义

| Stage | Name | 作用 |
| --- | --- | --- |
| S1 | Load | 加载 .so + config，校验依赖，捕获 stderr 中的配置告警 |
| S2 | Replay | 离线回放 mcap 数据，收集每帧 process() 状态/耗时/输入输出 metrics |
| S3 | Input Health | 分析输入 topic 频率、缺失、时序抖动，标记 red/yellow/green |
| S4 | Output Diff | 比较回放输出与录制输出的大小/非空率差异，降级到 size-diff |
| S5 | Perf | perf 采样火焰图，提取热点函数 |
| S6 | Report | 汇总所有 finding，因果推理合并 root cause，产出报告 + 导出 |

状态模型：`pending | running | passed | warn | failed | skipped`

每个阶段可以独立重跑。S1 失败会 short-circuit 后续所有阶段。

## 规则引擎

规则分两层：

- `src/attribution/rules/common.js`：通用规则，所有模块适用
- `src/attribution/rules/maprouter.js`：maprouter 模块特定规则（利用业务日志和输出 invariant）

每条规则返回 `{ severity, finding, tags, confidence, rootCauseHint }`。

新增模块规则：在 `rules/` 下新建 `<module>.js`，然后在 `rules/index.js` 的 `MODULE_RULES` map 里注册。

## 因果推理

S6 的 `inferRootCauses()` 用因果模板把多条 finding 合并为 root cause：

- `upstream_gap + output_diverge` → 上游缺失是根因，输出偏差降权
- `config_fail` → short-circuit，后续 finding 不可信
- `short_circuit + output_empty` → 短路返回导致空输出

## 证据格式

每次 Run Test 产出的报告写入 `.agent_output/tasks/<slug>/`：

```json
{
  "agent": "Analyzer",
  "stage": "S6",
  "type": "ANALYSIS",
  "time": "2026-04-24T...",
  "content": {
    "version": "1.0",
    "moduleId": "map_router",
    "runtime": "nexis",
    "timestamp": "...",
    "stages": { "S1": { "status": "passed" }, ... },
    "findings": [ { "ruleId": "REQ_INPUT_MISSING", "severity": "warn", ... } ],
    "rootCauses": [ { "primary": "upstream_gap", "message": "..." } ],
    "summary": {
      "replayOkRate": "99.0%",
      "missingRequired": ["map_router_dynamic_layer"],
      "zeroOutputChannels": [],
      "topPerfHotspots": ["GenerateRoute 42%"],
      "totalFindings": 3,
      "errorFindings": 0,
      "warnFindings": 3
    }
  }
}
```

## 与 ad-agent-workflow 对接

ad-topology **不依赖** ad-agent-workflow 运行。对接方式：

1. ad-topology 的 S6 阶段点 "Export to Analysis Workflow" → 调用 `POST /agent-output-write` 写入 `.agent_output/tasks/<slug>/<slug>.json`
2. ad-agent-workflow 的 Analyzer agent 读取这些文件作为 S3/S4 阶段输入
3. 两者通过文件系统目录约定解耦，无运行时依赖

消息格式对齐 `ad-agent-workflow/templates/agents/analyzer-agent.md` 中的约定。

## perf 火焰图

前置准备（一次性）：

```bash
apt install -y linux-tools-generic linux-tools-$(uname -r)
sysctl -w kernel.perf_event_paranoid=1
```

后端接口：

- `GET /perf-check`：检查 perf 是否可用
- `POST /perf-sample`：body `{ pid, duration_sec }`，返回 folded stacks JSON

前端在 S5 阶段用 d3-flame-graph 渲染交互式火焰图。

so 编译要求：`-fno-omit-frame-pointer -g`（当前 maprouter 已满足）。

## 文件结构

```
src/attribution/
  stepper.js              # 通用 stepper 状态机 + UI
  session.js              # 一次 Run Test 的共享上下文
  flamegraph-renderer.js  # d3-flame-graph 渲染器
  stages/
    index.js              # 统一导出 ALL_STAGES
    s1-load.js            # S1 Load
    s2-replay.js          # S2 Replay（从 test-panel.js 移植）
    s3-input-health.js    # S3 Input Health
    s4-output-diff.js     # S4 Output Diff
    s5-perf-snapshot.js   # S5 Perf
    s6-report.js          # S6 Report + Export
  rules/
    index.js              # 规则调度 + 因果推理
    common.js             # 通用规则
    maprouter.js          # maprouter 特定规则
```
