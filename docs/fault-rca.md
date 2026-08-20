# Fault RCA (故障归因) 视图

对齐 `/nexis/security/alarm/alarm_state_data`(各模块原始告警) 与
`/nexis/security/alarm/fault_process`(fault_manager 去抖+仲裁输出),为每个下发
FSM 的故障事件推断根因链。

入口:拓扑视图顶栏 `Fault RCA` 按钮,或 `fault_manager` 节点详情里的 `Fault RCA` 按钮。

## 数据与模块

| 文件 | 职责 |
|------|------|
| `src/fault-rca/fault-code.js` | 64-bit alarm code 位域解析(SOC/APP/Module/SubModule/Category/Level/Reason/Duration) + `classifyDomain`(对齐 fault_manager)。用 BigInt,规避 code > 2^53 的精度丢失。 |
| `src/fault-rca/fault-events.js` | 从 `msgDataCache` 抽两条 topic 时间流;告警展开为按 code 的 RAISE/CLEAR 区间轨;`fault_process` 折叠为显著变化的离散事件(移植 `summarizeFaultProcess`)。 |
| `src/fault-rca/attribution.js` | 归因引擎(纯函数)。 |
| `src/fault-rca/fault-catalog.js` | 按 `code_dec` join `src/fault-analysis.json`,补 desc/topic/producer/上下游/SD。 |
| `src/fault-rca/fault-rca-view.js` | UI:事件列表 / 根因链+因果图 / 告警泳道甘特条。 |

解码用 `decodeMessageStrings`(longs 保留为字符串),故障码精度无损。

## 归因模型(推断式,可解释)

**数据里没有显式因果**(`AlarmStateData` 无父码;`highLevelCode` 级联在
`nexis_alarm.cpp` 被打桩)。因此所有因果边都是**推断**,并带置信标签:

- `OBSERVED` 观测:共现簇内按时间先后,最早 RAISE 为根因候选。
- `CONFIGURED` 配置:两故障 `category` 为同一 topic,一方是 topic-health(源/生产侧,
  如 topic_monitor 帧率降级),另一方是消费侧 data-starvation(如 kDataDelayTooMuch)。
- `INFERRED` 推断:源故障 topic 的发布者→该 topic 订阅者(用 nexis-config 的
  pub/sub 图),对应下游 data-starvation 故障。

对每个输出事件 E(时刻 t):取 `[t-W, t]`(窗口 W 默认 3s,可在顶栏调) 内 active 告警组成
共现簇 → 两两推断因果边 → 入度为 0 且最早 RAISE 者为根因(roots);无因果边时退化为
纯时间先后取最早 RAISE。

**仲裁上下文单独展示**(赢家域 / 活跃域 / 多域升级),用于解释"为何报此输出",
**不等于根因**。

## 已知限制

- 依赖 mcap 内嵌 FileDescriptorSet(含 `nexis.security.alarm.*`)才能解码;缺失时视图给出
  明确提示并列出两条 topic 的存在/解码状态。
- 因果为推断,非确定;UI 每条边显式标注置信标签,供人工判断。
- `/neo_map/maps` 等 ad_dag 侧接线问题会如实呈现为悬空关系,不做隐式修正。

## 测试

- `scripts/test-fault-code.js`:位域解析对照 `fault_table.pbtxt` 已知 code。
- `scripts/test-fault-attribution.js`:producer→consumer 场景断言根因/边标签/最早RAISE。

均挂在 `npm test`。
