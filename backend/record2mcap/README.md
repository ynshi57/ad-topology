# record2mcap

离线 CLI：把 Apollo Cyber Record 无损转成 MCAP，供 `ad-topology` 等 MCAP 消费方直接使用。

## 设计原则

- **离线**：独立可执行，不经前端上传/转换
- **无损**：timestamp / schema / message bytes 三项都 byte-for-byte 保留
- **不解码视频**：H264 payload 按字节原样保留（不会出现 850M→28G 的膨胀）
- **可验证**：内置 `--verify` 抽样比对 + 结构化 `transform_report.json`

数据映射：

| Apollo Record | MCAP | 无损方式 |
| --- | --- | --- |
| `channel_name` | `Channel.topic` | 1:1 复制 |
| `message_type` | `Schema.name` | 1:1 复制 |
| `proto_desc` (FileDescriptorSet bytes) | `Schema.data` (encoding = `protobuf`) | 按字节写入 |
| `message.content` | `Message.data` | 按字节写入 |
| `message.time` (ns) | `Message.logTime` 和 `Message.publishTime` | 纳秒精度完整保留 |

## 构建

### 单独构建

```bash
cd ad-topology/backend/record2mcap
mkdir -p build && cd build
cmake ..
make -j
# 产物：./record2mcap
```

### 和 executor_harness 一起构建

```bash
cd ad-topology/backend
mkdir -p build && cd build
cmake ..
make -j
# 产物：
#   build/executor_harness
#   build/record2mcap/record2mcap
```

### 启用单元测试

```bash
cd ad-topology/backend/record2mcap
mkdir -p build && cd build
cmake .. -DRECORD2MCAP_BUILD_TESTS=ON
make record2mcap_test -j
./record2mcap_test
```

单测会生成一份 mini record、转换为 mcap，然后逐条 byte-level 对比。后续有人改动转换逻辑时，任何静默的丢字节/丢时间戳都会被这个测试直接打出来。

## 使用

```bash
./record2mcap <input.record> <output.mcap> [options]
```

### 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--compression <none\|zstd\|lz4>` | `zstd` | Chunk 压缩算法 |
| `--include topic1,topic2,...` | 无 | 只保留这些 topic |
| `--exclude topic1,topic2,...` | 无 | 丢弃这些 topic |
| `--verify` | off | 转换完毕后回读 mcap，与 record 做抽样 byte-level 比对 |
| `--verify-samples N` | 100 | `--verify` 抽样条数 |
| `--report <path.json>` | `<output>.report.json` | transform report 输出位置 |
| `--platform <name>` | 无 | 注入摄像头标定，例如 `X3PRO_25_L`、`X6`、`X6S`、`X2O`、`LONG_V2`、`ORIN`、`PRO`。注入 12 路 `*_camera_info` (foxglove.CameraCalibration) 和 12 路 `*_transform` (foxglove.FrameTransform) channel |
| `--calib-param-root <dir>` | `perception/.../DefaultParam` | 覆盖摄像头 YAML 根目录 |
| `--vehicle-config-root <dir>` | `common_neolix/conf/vehicle_config` | 覆盖 vehicle_config_*.json 目录 |
| `--lidar-imu-yaml <path>` | `tools/autostart/adu/params/velodyne16_back_novatel_extrinsics.yaml` | 覆盖 lidar->IMU 标定 YAML |
| `--quiet` | off | 抑制进度输出 |

### 常用示例

```bash
# 最基本：无损转换
./record2mcap demo.record.00000 demo.mcap

# 带验证（生产推荐）
./record2mcap demo.record.00000 demo.mcap --verify

# 拓扑可视化优化：丢弃所有摄像头视频流（降体积）
./record2mcap demo.record.00000 demo.mcap \
  --exclude /sensor/camera/front_left_1/image/video,/sensor/camera/front_right_10/image/video

# 只关心 PNC 链路
./record2mcap demo.record.00000 demo.mcap \
  --include /pnc/control,/pnc/planning,/pnc/prediction,/maprouter/maps

# 注入摄像头标定（12 路 camera_info + 12 路 transform）
./record2mcap demo.record.00000 demo.mcap --platform X3PRO_25_L
```

## 摄像头标定注入

传入 `--platform` 时，转换器会读取车型对应的标定文件并注入到输出 mcap 中：

| 数据来源 | 路径 | 用途 |
| --- | --- | --- |
| 摄像头内参 | `<calib-param-root>/<platform>/x3p_camera_<idx>_*_intrinsics.yaml` | 12 路相机的 K、distortion 等 |
| 摄像头到 lidar 的外参 | `<calib-param-root>/<platform>/x3p_camera_<idx>_*_to_velodyne16_back_extrinsics.yaml` | 摄像头相对 lidar 的位姿 |
| lidar 到 IMU 的外参 | `<lidar-imu-yaml>` | velodyne_back 相对 novatel IMU |
| IMU 到 BEV 的外参 | `<vehicle-config-root>/vehicle_config_<platform_lc>.json` | `imu_to_rear_axle_center_dist` |

注入到输出 mcap 的 channel：

- `/sensor/camera/<name>/image/video_camera_info` → `foxglove.CameraCalibration`（每路 1 条静态消息）
- `/sensor/camera/<name>/image/video_transform` → `foxglove.FrameTransform`（每路 1 条静态消息，parent=`bev`，child=相机 frame）

变换链：`bev <- imu <- velodyne16_back <- camera`，最终 transform 表达 camera 在车体后轴中心坐标系下的位姿。

注意：DefaultParam 是车型默认标定，单车精标定可能略有偏差（约 0.5 m 量级）。如果需要某辆具体车的标定，传入 `--calib-param-root` 指向该车的 `/home/caros/adu/params` 目录即可。

## 报告格式

每次转换都会写 `transform_report.json`：

```json
{
  "input_path": "...",
  "output_path": "...",
  "compression": "zstd",
  "total_messages": 23639,
  "kept_messages": 2172,
  "skipped_messages": 21467,
  "first_ns": 1776343246547000000,
  "last_ns": 1776343266543000000,
  "duration_ns": 19996000000,
  "lossless_check": {
    "timestamps_preserved": true,
    "proto_desc_preserved": true,
    "message_bytes_preserved": true
  },
  "verify": {
    "ran": true,
    "samples": 50,
    "mismatches": 0,
    "notes": ""
  },
  "channels": [
    {
      "topic": "/pnc/control",
      "proto_type": "neodrive.global.control.ControlCommand",
      "schema_hash_fnv1a": "90404224b7cfa167",
      "message_count": 998,
      "first_ns": 1776343246547000000,
      "last_ns": 1776343266543000000
    }
  ]
}
```

出现 `"timestamps_preserved": false`、`"proto_desc_preserved": false`、`"message_bytes_preserved": false` 或 `verify.mismatches > 0` 时，**不要信任这份 mcap**；先回溯是哪一步偏离了 byte-level passthrough。

## 与 ad-topology 的关系

`ad-topology` 的 UI 不需要任何改动。转换流程是独立的：

1. 用一次 `record2mcap`，得到无损 `.mcap`
2. 打开 `http://localhost:5173/`，把 `.mcap` 拖进去即可走原有 mcap 链路（拓扑、时间轴、详情、3D、回放测试）

## 依赖

- Apollo CyberRT (`libcyber.so`，提供 `RecordReader`)
- foxglove 官方 `mcap` header-only 库（vendor 进 `third_party/mcap/`，MIT license）
- `libzstd`、`liblz4`（`mcap` 压缩后端）
- `jsoncpp`（仅沿用 executor_harness 的依赖集合，方便同 CMake 构建）
