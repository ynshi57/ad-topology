# AD-Topology — Process Topology Visualization & Module Replay Testing

自动驾驶系统进程通信拓扑可视化工具 + MCAP 数据回放 + 3D 场景渲染 + 模块级回放测试。

## 快速开始

### 方式一：使用预构建版本（推荐）

```bash
# 解压发布包
tar xzf ad-topology-release.tar.gz
cd ad-topology-release

# 安装 Node.js 依赖（仅首次）
npm install ws

# 启动前端静态文件服务
cd dist && python3 -m http.server 8080 &
cd ..

# 启动后端服务（Replay Test + URL 代理）
WS_PORT=8766 node server/index.js &

# 浏览器访问
# 本机: http://localhost:8080
# 远程: ssh -p <port> -L 8080:localhost:8080 -L 8766:localhost:8766 user@<ip>
#        然后访问 http://localhost:8080
```

### 方式二：从源码运行（开发用）

```bash
cd ad-topology

# 安装依赖
npm install

# 构建 nexis 配置（需要 ad_dag 目录在 ../）
npm run prebuild

# 启动开发服务器
npm run dev

# 启动后端服务（另一个终端）
WS_PORT=8766 node server/index.js

# 浏览器访问 http://localhost:5173
```

### 方式三：构建 C++ 后端（首次或模块更新时）

```bash
cd ad-topology/backend
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
make -j4
```

## 功能

### 1. 进程拓扑图

- 加载 MCAP 文件后自动生成进程间通信拓扑图
- 节点 = 进程（neo_sensor, location, planning, control 等）
- 连线 = pub/sub topic 关系（来自 nexis 框架配置）
- 分层 DAG 布局：INPUT → STATE → PRE-PROCESS → PERCEPTION → PLANNING → CONTROL

### 2. 粒子动画回放

- 点击 Play 按钮回放 MCAP 消息流
- 粒子沿连线流动，间距固定 40px，速度反映帧率
- 帧率监控：正常(绿) / 降频(橙) / 丢帧(红)
- 每个 topic 从第一条消息开始独立计时

### 3. Node Detail View

- 双击任意节点进入详细视图
- 显示上下游节点关系
- 选择 topic 查看实时 JSON 消息内容（protobuf 自动反序列化）
- 消息面板支持水平滚动，JSON 点击展开/收起

### 4. 3D 场景可视化

- 点击顶部 **3D** 按钮切换到 3D 视图
- 渲染 foxglove.SceneUpdate 消息：车道线、障碍物、地图、轨迹
- 左侧 topic 列表支持动态开关每个 3D 图层
- EGO 车辆标记始终显示在原点
- 支持鼠标旋转、缩放、平移

### 5. Replay Test（模块回放测试）

- 在 Node Detail View 点击 **Replay Test** 按钮
- 自动检测模块类型：Nexis IExecutor 或 CyberRT Component
- 支持 **Run Test**（直接测试）和 **Rebuild & Test**（先编译再测试）
- 结果实时显示：帧状态、耗时、错误信息

### 6. URL 加载

- Drop Zone 支持粘贴 viz.data.neolix.cn 平台 URL
- 自动解析 S3 签名 URL，通过后端代理下载 MCAP 文件
- 支持同时加载多个 MCAP 文件（lite + camera）

### 7. Output 日志

- 底部可折叠面板，记录帧率异常事件
- 格式：`[时间] WARN/ERROR topic: 频率详情`
- 支持 Clear 和自动滚动

## 加载 MCAP 文件

三种方式：

1. **拖拽** — 直接拖 .mcap 文件到页面
2. **选择文件** — 点击 Select Files 按钮
3. **粘贴 URL** — 从 viz 平台复制链接粘贴到输入框

## 远程开发机访问

如果工具运行在远程开发机上：

```bash
# 同时转发前端和后端端口
ssh -p <ssh_port> \
    -L 8080:localhost:8080 \
    -L 8766:localhost:8766 \
    user@<remote_ip>

# 本地浏览器访问 http://localhost:8080
```

开发模式下端口为 5173：

```bash
ssh -p <ssh_port> \
    -L 15173:localhost:5173 \
    -L 8766:localhost:8766 \
    user@<remote_ip>

# 本地浏览器访问 http://localhost:15173
```

## 项目结构

```
ad-topology/
├── src/                          # 前端源码
│   ├── main.js                   # 应用入口、视图管理、消息索引
│   ├── graph.js                  # 全 Canvas 拓扑图渲染 + 粒子动画
│   ├── scene-3d.js               # Three.js 3D 场景渲染
│   ├── scene-topics.js           # 3D topic 控制面板
│   ├── timeline.js               # 播放时间轴
│   ├── topic-panel.js            # 右侧 topic 列表
│   ├── node-detail.js            # 节点详情视图
│   ├── output-panel.js           # 底部 Output 日志
│   ├── test-panel.js             # Replay Test 面板
│   ├── mcap-loader.js            # MCAP 文件解析
│   ├── topology-builder.js       # 拓扑构建（mcap + nexis 融合）
│   ├── proto-decoder.js          # Protobuf 浏览器端解码
│   ├── nexis-config.json         # 预构建的进程通信关系
│   └── style.css                 # Uber Design System 风格样式
├── server/
│   └── index.js                  # Node.js WS 服务 + URL 代理 + C++ harness 桥接
├── backend/
│   ├── CMakeLists.txt            # C++ 构建
│   └── src/
│       ├── main.cpp              # 双模式 harness 入口
│       ├── executor_harness.*    # Nexis IExecutor 加载
│       └── cyber_harness.*       # CyberRT Component 加载
├── scripts/
│   └── build-nexis-config.js     # nexis pbtxt → JSON 预处理
├── docs/
│   └── AD-System-Viz-Phase1.md   # 项目文档
└── package.json
```

## 技术栈

| 技术 | 用途 |
|------|------|
| Vite 8 | 构建工具 |
| Canvas 2D | 拓扑图渲染（节点、连线、粒子） |
| Three.js | 3D 场景渲染 |
| D3.js | 缩放/平移交互 |
| @mcap/core + @mcap/browser | MCAP 文件解析 |
| protobufjs | Protobuf 反序列化 |
| fzstd | zstd 解压 |
| ws | WebSocket 服务 |
| C++ (nexis_kernel + libcyber) | 模块回放 harness |

## 已知限制

- CyberRT Component 的 Replay Test 需要完整的 Cyber 运行环境，部分模块（如 location）因等待时间同步服务会超时
- 3D 场景中 foxglove.Grid 渲染为简单灰度纹理，未做颜色映射
- S3 签名 URL 有 7 天有效期，过期需重新获取
- 容器环境内存有限时，大型 MCAP 文件可能导致 OOM

## 配置更新

当 nexis 框架配置变更时（transport.pbtxt 等）：

```bash
npm run prebuild
```

当新增 CyberRT 进程时，需要在 `scripts/build-nexis-config.js` 的 `CYBER_PROCESSES` 中添加 topic 定义。
