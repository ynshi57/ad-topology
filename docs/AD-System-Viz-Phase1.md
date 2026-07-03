# AD-System-Viz 一期：Process Topology Player

## 1. 背景

在自动驾驶系统的开发和调试过程中，系统由 20+ 个进程组成（感知、定位、规划、控制、CAN 总线等），进程间通过 CyberRT topic 和 Nexis 框架进行通信。系统录制的 MCAP 数据文件包含了所有 topic 的消息流，但现有工具（如 Foxglove）只能查看单个 topic 的数据，**无法直观地看到整个系统的通信拓扑和实时数据流动状态**。

**核心问题**：
- 无法一眼看出哪些进程之间有数据通信
- 无法直观判断某个 topic 的帧率是否正常
- 回放 MCAP 文件时看不到消息在进程间的流动过程
- 出现通信延迟或丢帧时缺乏可视化告警

## 2. 目的

AD-System-Viz 是一个 **MCAP 数据驱动的进程拓扑可视化回放工具**，面向自动驾驶系统开发和测试团队：

- **拓扑可视化**：自动解析 MCAP 文件中的 topic，结合 Nexis 框架配置生成进程间通信拓扑图
- **数据回放**：按原始时间轴回放消息流，通过粒子动画可视化数据在进程间的流动
- **帧率监控**：实时对比每个 topic 的实际帧率 vs 设计帧率，异常时自动告警
- **问题定位**：通过 Output 日志面板记录所有帧率异常事件，辅助定位通信问题

## 3. 系统设计

### 3.1 架构

```
┌──────────────────────────────────────────────────────────┐
│                     Build Time                            │
│                                                           │
│   ad_dag/config/nexis/          scripts/                  │
│   ├── deploy/*/transport.pbtxt  build-nexis-config.js     │
│   └── resource/data.d/*.pbtxt   ──→ nexis-config.json     │
│        (进程 pub/sub 关系)          (23个进程, 59个topic)    │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                     Browser Runtime                       │
│                                                           │
│   用户拖入 .mcap 文件                                       │
│      ↓                                                    │
│   @mcap/core 解析 → channels (topic, schema, Hz, 消息数)   │
│      ↓                                                    │
│   融合引擎: mcap topics × nexis-config.json                │
│      ↓                                                    │
│   ┌─────────────┬──────────────┬─────────────┐           │
│   │ 拓扑图(D3)   │ Topic面板     │ 时间轴        │           │
│   │ 节点=进程    │ mcap实际数据  │ Play/暂停     │           │
│   │ 连线=pub/sub │ 按进程分组    │ 0.5x~4x倍速  │           │
│   │ 粒子=消息流  │ Hz/消息数     │ 拖拽定位      │           │
│   └─────────────┴──────────────┴─────────────┘           │
│   ┌──────────────────────────────────────────┐           │
│   │ Output 日志面板: 帧率异常告警              │           │
│   └──────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────┘
```

### 3.2 数据来源

| 数据 | 来源 | 内容 |
|------|------|------|
| **Topic 实际数据** | MCAP 文件 | topic 名、schema、实际帧率、消息数、时间戳 |
| **进程间关系** | nexis-config.json（预构建） | 哪个进程发布哪个 topic、哪个进程订阅哪个 topic |

### 3.3 MCAP 数据文件

MCAP 是自动驾驶领域的标准录制格式（由 Foxglove 开发），支持 protobuf / flatbuffers / JSON 等多种序列化格式，带 zstd 压缩。

本工具支持加载任意 `.mcap` 文件，典型录制文件：

| 文件 | 大小 | 内容 |
|------|------|------|
| `*.lite.mcap` | ~30MB | 感知、规划、控制等数据 topic（79 channels） |
| `*.camera.mcap` | ~26MB | 12 路摄像头视频流（28 channels） |

### 3.4 Camera 可视化

加载 `camera.mcap` 后，点击顶栏 **Camera** 按钮进入 Camera View：

- **左侧**：摄像头选择列表（默认显示前 6 路，可勾选切换）
- **主区域**：自适应网格显示已选摄像头画面，每帧标注摄像头名称和实时帧率
- **点击单路**：进入全屏模式，可查看 CameraCalibration 内参/外参信息
- **图像格式**：foxglove.CompressedImage（AVIF），需 Chrome 85+ / Firefox 93+
- **同步回放**：Camera View 与 Timeline 完全同步，支持变速回放

### 3.6 Nexis 连接关系

拓扑配置由**所选平台的 app_config 驱动**生成（`scripts/build-nexis-config.js`）。
按 `ad_dag/conf/<platform>/app_config.json` 取 `enabled` 的 app，nexis_app 按
`-p <profile>` 解析到 `deploy/<profile>/transport.pbtxt`，mainboard 进程用内置
`CODE_TOPICS` 兜底；节点 id = app `name`。这样 `25_*`/`26_*`/`test_*` 版本化与仿真
目录不会被混入，平台之间也不会互相污染。

| 配置源 | 路径 | 内容 |
|--------|------|------|
| 启动清单 | `ad_dag/conf/<platform>/app_config.json` | 启用哪些 app、运行框架(nexis_app/mainboard)、`-p` 部署 profile |
| Transport 配置 | `ad_dag/config/nexis/deploy/<profile>/transport.pbtxt` | Nexis 进程的 pub/sub topic 绑定（权威来源） |
| Data 定义 | `ad_dag/config/nexis/resource/data.d/*.pbtxt` | 逻辑数据名 → protobuf 类型映射 |
| CyberRT 代码 topic | `scripts/build-nexis-config.js` 的 `CODE_TOPICS` | mainboard 进程在代码中定义的 topic，仅兜底，不覆盖 transport |

平台：`25_6090` 与 `26_6012`（仅 canbus / localization / model_infer 三处不同）。
生成 `src/nexis-config.<platform>.json` 各一份，并镜像默认平台为 `src/nexis-config.json`。
UI 顶栏平台下拉可实时切换。

### 3.7 可视化功能

**拓扑图**
- 分层 DAG 布局：INPUT → STATE → PRE-PROCESS → PERCEPTION → PLANNING → CONTROL → AUX
- 节点颜色按域区分：Sensor(青) / Perception(橙) / Localization(绿) / PNC(蓝) / System(紫)
- 连线自动绕开中间节点，不穿越
- 鼠标悬停节点高亮关联连线，显示 tooltip（mcap 实际数据）
- 支持拖拽节点、缩放平移

**粒子动画（Play 回放）**
- 每条连线上的粒子代表消息流动
- 粒子密度 = topic 实际帧率（100Hz 密集、5Hz 稀疏）
- 粒子带尾巴显示流动方向（head 大 → tail 小）
- 粒子颜色反映帧率健康状态：白色(正常) / 橙色(降频) / 红色(丢帧)

**帧率监控**
- 1 秒滑动窗口实时计算每个 topic 的瞬时帧率
- 每个 topic 从自己的第一条消息开始计时（避免录制起始不完整的虚假告警）
- 与设计帧率对比：>=80% 正常 / 50-80% WARN / <50% ERROR / 0 msg CRITICAL

**Output 日志面板**
- 底部可折叠面板，记录所有帧率异常事件
- 格式：`[3.21s] WARN /pnc/control: freq 32.0Hz / 48.7Hz (65%)`
- 支持 Clear、自动滚动

## 4. 如何使用

### 4.1 方式一：直接使用预构建版本（推荐）

```bash
# 1. 从共享目录获取 dist.tar.gz（约 200KB）
scp user@server:/path/to/ad-topology-dist.tar.gz ./

# 2. 解压
tar xzf ad-topology-dist.tar.gz

# 3. 启动 HTTP 服务器
cd dist
python3 -m http.server 8080

# 4. 浏览器访问
open http://localhost:8080
```

打开后：
1. 将 `.mcap` 文件**拖入**页面（或点击 Select Files）
2. 等待消息索引构建完成（底部显示进度）
3. 点击 ▶ Play 按钮回放
4. 观察粒子流动和帧率告警

### 4.2 方式二：从源码运行（开发用）

```bash
# 1. 克隆代码
git clone <repo> && cd ad-topology

# 2. 安装依赖
npm install

# 3. 构建 nexis 配置（需要 ad_dag 目录在 ../）
npm run prebuild

# 4. 启动开发服务器
npm run dev

# 5. 浏览器访问
open http://localhost:5173
```

### 4.3 远程开发机访问

如果工具运行在远程开发机上：

```bash
# 本地终端执行端口转发
ssh -p <port> -L 15173:localhost:5173 user@<remote-ip>

# 本地浏览器访问
open http://localhost:15173
```

### 4.4 打包分发

```bash
cd ad-topology

# 构建生产版本
npm run build

# 打包（不含 mcap 示例文件）
cd dist && tar czf ../ad-topology-dist.tar.gz . && cd ..

# 分发 ad-topology-dist.tar.gz（约 200KB）
```

## 5. 界面截图

### 5.1 拓扑图 + 粒子动画回放

播放状态下，粒子沿连线流动，密度反映帧率。白色=正常，橙色=降频告警。

> （请参考附件截图：播放中的完整界面，包含拓扑图、粒子流、Topic 面板、时间轴和 Output 面板）

### 5.2 帧率告警 Output

Output 面板显示帧率异常事件，包含时间、级别、topic 名和具体帧率对比。

## 6. 项目结构

```
ad-topology/
├── index.html                      # 入口 HTML
├── package.json                    # 依赖和脚本
├── scripts/
│   └── build-nexis-config.js       # 预构建: pbtxt → JSON
├── src/
│   ├── main.js                     # 应用主逻辑: 文件加载、索引构建、回放驱动
│   ├── graph.js                    # D3 拓扑图: 布局、渲染、粒子动画、帧率着色
│   ├── timeline.js                 # 时间轴控件: play/pause/scrub/speed
│   ├── topic-panel.js              # 右侧 Topic 面板
│   ├── output-panel.js             # 底部 Output 日志面板
│   ├── mcap-loader.js              # MCAP 文件解析 (@mcap/core + fzstd)
│   ├── camera-panel.js             # Camera View: 多路摄像头网格 + 全屏 + 标定信息
│   ├── camera-decoder.js           # 摄像头 protobuf 解码器 (CompressedImage/Calibration/Transform)
│   ├── topology-builder.js         # 融合引擎: mcap × nexis-config → 拓扑数据
│   ├── nexis-config.json           # 预构建的进程通信关系 (自动生成)
│   └── style.css                   # Uber Design System 风格样式
├── public/                         # 静态资源 (mcap 示例文件软链接)
└── dist/                           # 构建输出
```

## 7. 技术栈

| 技术 | 用途 |
|------|------|
| Vite 8 | 构建工具 |
| D3.js 7 | SVG 拓扑图渲染 + 粒子动画 |
| @mcap/core + @mcap/browser | 浏览器端 MCAP 文件解析 |
| fzstd | 纯 JS 的 zstd 解压（MCAP 消息解压） |
| Inter 字体 | Uber Design System 替代字体 |

## 8. 后续规划（二期）

- 支持实时连接 CyberRT 系统（WebSocket），不只是 MCAP 回放
- 消息内容解码和展示（protobuf 反序列化）
- 多 MCAP 文件对比分析
- 时间线上标注关键事件（如紧急制动、故障注入）
- 导出帧率分析报告

---

*文档版本: v1.0 | 日期: 2026-04-08 | 维护: AD Platform Team*
