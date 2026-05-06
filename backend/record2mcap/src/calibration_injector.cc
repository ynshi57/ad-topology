#include "calibration_injector.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <unordered_set>

#include <jsoncpp/json/json.h>
#include <yaml-cpp/yaml.h>

#include "CameraCalibration.pb.h"
#include "FrameTransform.pb.h"
#include "foxglove_fds_data.h"
#include "mcap/mcap.hpp"

namespace record2mcap {

namespace {

constexpr const char* kDefaultParamRootDefault =
    "/home/caros/workspace/perception/src/perception/production/data/perception/DefaultParam";
constexpr const char* kVehicleConfigRootDefault =
    "/home/caros/workspace/common_neolix/conf/vehicle_config";
constexpr const char* kLidarImuYamlDefault =
    "/home/caros/workspace/tools/autostart/adu/params/velodyne16_back_novatel_extrinsics.yaml";

constexpr const char* kCameraCalibSchemaName = "foxglove.CameraCalibration";
constexpr const char* kFrameTransformSchemaName = "foxglove.FrameTransform";
constexpr const char* kBevFrameId = "bev";

// Quaternion (w, x, y, z) and translation (x, y, z).
struct Transform {
    std::array<double, 4> q{1.0, 0.0, 0.0, 0.0};   // w, x, y, z
    std::array<double, 3> t{0.0, 0.0, 0.0};
};

// Hamilton product: r = a * b.
std::array<double, 4> QuatMul(const std::array<double, 4>& a,
                              const std::array<double, 4>& b) {
    return {
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    };
}

// Rotate vector v by quaternion q. q = (w, x, y, z).
std::array<double, 3> QuatRotate(const std::array<double, 4>& q,
                                 const std::array<double, 3>& v) {
    const double w = q[0], x = q[1], y = q[2], z = q[3];
    // p' = q * p * q^-1, with p = (0, v)
    const double xx = x * x, yy = y * y, zz = z * z;
    const double xy = x * y, xz = x * z, yz = y * z;
    const double wx = w * x, wy = w * y, wz = w * z;
    return {
        v[0] * (1.0 - 2.0 * (yy + zz)) + v[1] * 2.0 * (xy - wz)       + v[2] * 2.0 * (xz + wy),
        v[0] * 2.0 * (xy + wz)         + v[1] * (1.0 - 2.0 * (xx + zz)) + v[2] * 2.0 * (yz - wx),
        v[0] * 2.0 * (xz - wy)         + v[1] * 2.0 * (yz + wx)       + v[2] * (1.0 - 2.0 * (xx + yy)),
    };
}

// result = a * b (i.e. apply b first, then a, in transform composition).
Transform Compose(const Transform& a, const Transform& b) {
    Transform r;
    r.q = QuatMul(a.q, b.q);
    auto rotated = QuatRotate(a.q, b.t);
    r.t = {a.t[0] + rotated[0], a.t[1] + rotated[1], a.t[2] + rotated[2]};
    return r;
}

bool LoadTransformYaml(const std::string& path, Transform* out, std::string* errorOut) {
    YAML::Node root;
    try {
        root = YAML::LoadFile(path);
    } catch (const std::exception& e) {
        if (errorOut) {
            *errorOut = "yaml load failed: " + path + " (" + e.what() + ")";
        }
        return false;
    }
    if (!root["transform"] || !root["transform"]["rotation"] ||
        !root["transform"]["translation"]) {
        if (errorOut) {
            *errorOut = "missing transform/rotation/translation in: " + path;
        }
        return false;
    }
    try {
        const auto& rot = root["transform"]["rotation"];
        const auto& trans = root["transform"]["translation"];
        out->q = {rot["w"].as<double>(), rot["x"].as<double>(),
                  rot["y"].as<double>(), rot["z"].as<double>()};
        out->t = {trans["x"].as<double>(), trans["y"].as<double>(),
                  trans["z"].as<double>()};
    } catch (const std::exception& e) {
        if (errorOut) {
            *errorOut = "yaml field parse error: " + path + " (" + e.what() + ")";
        }
        return false;
    }
    return true;
}

// Load IMU->BEV (rear axle center) transform from vehicle_config_*.json.
// Mirrors the convention in
// perception/src/perception/common/cpm/CalibParamManager.cc::loadVehicleParams:
//
//   angle      = -PI/2  (rotate -90 deg around Z axis: from IMU frame
//                        right-front-up to vehicle frame front-left-up)
//   half_angle = angle / 2 = -PI/4
//   imu_to_vehicle.translation = {-y, x, -z}
//   imu_to_vehicle.rotation    = {cos(half_angle), 0, 0, sin(half_angle)}
//                              ~= (0.7071, 0, 0, -0.7071)
//
// We replicate the exact same convention so output matches what perception
// (and downstream consumers) expect.
bool LoadImuToBev(const std::string& vehicleConfigJsonPath, Transform* out,
                  std::string* errorOut) {
    std::ifstream ifs(vehicleConfigJsonPath);
    if (!ifs) {
        if (errorOut) {
            *errorOut = "cannot open vehicle_config: " + vehicleConfigJsonPath;
        }
        return false;
    }
    Json::Value root;
    Json::CharReaderBuilder builder;
    std::string parseErr;
    if (!Json::parseFromStream(builder, ifs, &root, &parseErr)) {
        if (errorOut) {
            *errorOut = "json parse failed: " + vehicleConfigJsonPath + " (" + parseErr + ")";
        }
        return false;
    }
    const auto& imu = root["imu_installation_params"];
    if (imu.isNull() || !imu.isMember("imu_to_rear_axle_center_dist")) {
        if (errorOut) {
            *errorOut = "missing imu_installation_params.imu_to_rear_axle_center_dist in: " +
                        vehicleConfigJsonPath;
        }
        return false;
    }
    const auto& dist = imu["imu_to_rear_axle_center_dist"];
    if (!dist.isMember("x") || !dist.isMember("y") || !dist.isMember("z")) {
        if (errorOut) {
            *errorOut = "imu_to_rear_axle_center_dist missing x/y/z";
        }
        return false;
    }
    const double x = dist["x"].asDouble();
    const double y = dist["y"].asDouble();
    const double z = dist["z"].asDouble();

    // -90 deg rotation around Z axis (from IMU right-front-up to vehicle
    // front-left-up convention). q = (cos(-pi/4), 0, 0, sin(-pi/4)).
    constexpr double kHalfAngle = -M_PI / 4.0;
    out->q = {std::cos(kHalfAngle), 0.0, 0.0, std::sin(kHalfAngle)};
    out->t = {-y, x, -z};
    return true;
}

// Read intrinsics yaml. Returns false on parse failure.
bool LoadIntrinsicsYaml(const std::string& path, CameraCalib* out,
                        std::string* errorOut) {
    YAML::Node root;
    try {
        root = YAML::LoadFile(path);
    } catch (const std::exception& e) {
        if (errorOut) {
            *errorOut = "yaml load failed: " + path + " (" + e.what() + ")";
        }
        return false;
    }
    try {
        out->width = root["width"].as<int>();
        out->height = root["height"].as<int>();
        out->distortionModel = root["distortion_model"].as<std::string>();
        if (!root["K"]) {
            if (errorOut) {
                *errorOut = "missing K in: " + path;
            }
            return false;
        }
        auto K = root["K"].as<std::vector<double>>();
        if (K.size() != 9) {
            if (errorOut) {
                *errorOut = "K must have 9 elements in: " + path;
            }
            return false;
        }
        out->fx = K[0];
        out->fy = K[4];
        out->cx = K[2];
        out->cy = K[5];
        if (root["D"]) {
            out->D = root["D"].as<std::vector<double>>();
        }
    } catch (const std::exception& e) {
        if (errorOut) {
            *errorOut = "yaml field parse error: " + path + " (" + e.what() + ")";
        }
        return false;
    }
    return true;
}

// Walk a DefaultParam directory and collect basename-stems that look like
// camera files: "x3p_camera_<idx>_<position>_<focal>_mm_*.yaml".
// Returns map from yamlCamName ("idx_position") to {intrinsics_path, extrinsics_path}.
struct CameraFiles {
    std::string intrinsicsPath;
    std::string extrinsicsPath;
};

std::unordered_map<std::string, CameraFiles> ScanCameraFiles(const std::string& dir) {
    std::unordered_map<std::string, CameraFiles> result;
    if (!std::filesystem::exists(dir) || !std::filesystem::is_directory(dir)) {
        return result;
    }
    for (const auto& entry : std::filesystem::directory_iterator(dir)) {
        const std::string filename = entry.path().filename().string();
        if (filename.find("x3p_camera_") != 0) {
            continue;
        }
        const bool isIntrinsics = filename.find("_intrinsics.yaml") != std::string::npos;
        const bool isExtrinsics = filename.find("_to_velodyne16_back_extrinsics.yaml") !=
                                   std::string::npos;
        if (!isIntrinsics && !isExtrinsics) {
            continue;
        }
        // Extract "<idx>_<position>" from "x3p_camera_<idx>_<position>_<focal>_mm_..."
        const std::string prefix = "x3p_camera_";
        const std::string mmTag = "_mm_";
        const auto mmPos = filename.rfind(mmTag);
        if (mmPos == std::string::npos || mmPos <= prefix.size()) {
            continue;
        }
        std::string mid = filename.substr(prefix.size(), mmPos - prefix.size());
        // mid = "<idx>_<position>_<focal>" (focal may be like "1-5" or "3" or "6")
        // Strip trailing "_<focal>" segment.
        const auto lastUs = mid.rfind('_');
        if (lastUs == std::string::npos) {
            continue;
        }
        const std::string yamlCamName = mid.substr(0, lastUs);

        auto& files = result[yamlCamName];
        if (isIntrinsics) {
            files.intrinsicsPath = entry.path().string();
        } else {
            files.extrinsicsPath = entry.path().string();
        }
    }
    return result;
}

// Encode foxglove.CameraCalibration to bytes.
std::string EncodeCameraCalibration(const CameraCalib& calib, uint64_t timestampNs,
                                    const std::string& cameraFrameId) {
    foxglove::CameraCalibration msg;
    auto* ts = msg.mutable_timestamp();
    ts->set_sec(static_cast<int32_t>(timestampNs / 1'000'000'000ULL));
    ts->set_nsec(static_cast<uint32_t>(timestampNs % 1'000'000'000ULL));
    msg.set_frame_id(cameraFrameId);
    msg.set_width(static_cast<uint32_t>(calib.width));
    msg.set_height(static_cast<uint32_t>(calib.height));
    msg.set_distortion_model(calib.distortionModel);
    for (double d : calib.D) {
        msg.add_d(d);
    }
    // K is 3x3 row-major: [fx, 0, cx, 0, fy, cy, 0, 0, 1]
    msg.add_k(calib.fx); msg.add_k(0.0);     msg.add_k(calib.cx);
    msg.add_k(0.0);     msg.add_k(calib.fy); msg.add_k(calib.cy);
    msg.add_k(0.0);     msg.add_k(0.0);     msg.add_k(1.0);

    std::string out;
    msg.SerializeToString(&out);
    return out;
}

// Encode foxglove.FrameTransform to bytes.
std::string EncodeFrameTransform(const Transform& t, uint64_t timestampNs,
                                  const std::string& parentFrameId,
                                  const std::string& childFrameId) {
    foxglove::FrameTransform msg;
    auto* ts = msg.mutable_timestamp();
    ts->set_sec(static_cast<int32_t>(timestampNs / 1'000'000'000ULL));
    ts->set_nsec(static_cast<uint32_t>(timestampNs % 1'000'000'000ULL));
    msg.set_parent_frame_id(parentFrameId);
    msg.set_child_frame_id(childFrameId);
    auto* tr = msg.mutable_translation();
    tr->set_x(t.t[0]);
    tr->set_y(t.t[1]);
    tr->set_z(t.t[2]);
    auto* rot = msg.mutable_rotation();
    // Foxglove Quaternion is (x, y, z, w); our internal q is (w, x, y, z).
    rot->set_w(t.q[0]);
    rot->set_x(t.q[1]);
    rot->set_y(t.q[2]);
    rot->set_z(t.q[3]);

    std::string out;
    msg.SerializeToString(&out);
    return out;
}

// Convert "/sensor/camera/front_middle_fisheye_0/image/video" -> "front_middle_fisheye_0".
std::string ExtractTopicCamName(const std::string& videoTopic) {
    const std::string prefix = "/sensor/camera/";
    const std::string suffix = "/image/video";
    if (videoTopic.size() <= prefix.size() + suffix.size()) {
        return "";
    }
    if (videoTopic.compare(0, prefix.size(), prefix) != 0) {
        return "";
    }
    if (videoTopic.compare(videoTopic.size() - suffix.size(), suffix.size(), suffix) != 0) {
        return "";
    }
    return videoTopic.substr(prefix.size(),
                             videoTopic.size() - prefix.size() - suffix.size());
}

// camera frame_id used in foxglove messages, mirroring camera.mcap convention.
std::string MakeCameraFrameId(const std::string& topicCamName) {
    return "_sensor_camera_" + topicCamName + "_image_video";
}

}  // namespace

// Public helpers (used by tests).

std::string TopicToYamlCamName(const std::string& videoTopic) {
    const std::string topicCamName = ExtractTopicCamName(videoTopic);
    if (topicCamName.empty()) {
        return "";
    }
    // topic forms: <position>_<idx>  or  <position>_fisheye_<idx>
    // YAML: <idx>_<position>
    const auto lastUs = topicCamName.rfind('_');
    if (lastUs == std::string::npos) {
        return "";
    }
    const std::string idx = topicCamName.substr(lastUs + 1);
    std::string position = topicCamName.substr(0, lastUs);
    const std::string fisheyeTag = "_fisheye";
    if (position.size() >= fisheyeTag.size() &&
        position.compare(position.size() - fisheyeTag.size(), fisheyeTag.size(),
                         fisheyeTag) == 0) {
        position = position.substr(0, position.size() - fisheyeTag.size());
    }
    return idx + "_" + position;
}

std::string PlatformToVehicleConfigSuffix(const std::string& platform) {
    std::string lower = platform;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return lower;
}

bool InjectCalibration(mcap::McapWriter& writer,
                       const CalibrationInjectionOptions& options,
                       CalibrationInjectionReport* report) {
    if (!report) {
        return false;
    }
    report->ran = false;
    if (options.platform.empty()) {
        return true;  // nothing to do, caller did not request injection
    }
    report->ran = true;

    const std::string defaultParamRoot = options.defaultParamRoot.empty()
        ? kDefaultParamRootDefault : options.defaultParamRoot;
    const std::string vehicleConfigRoot = options.vehicleConfigRoot.empty()
        ? kVehicleConfigRootDefault : options.vehicleConfigRoot;
    const std::string lidarImuYaml = options.lidarImuYamlPath.empty()
        ? kLidarImuYamlDefault : options.lidarImuYamlPath;

    const std::string platformDir = defaultParamRoot + "/" + options.platform;
    const std::string vehicleJson = vehicleConfigRoot + "/vehicle_config_" +
                                    PlatformToVehicleConfigSuffix(options.platform) + ".json";

    if (!std::filesystem::is_directory(platformDir)) {
        report->error = "platform directory not found: " + platformDir;
        return false;
    }

    Transform lidarToImu;
    {
        std::string err;
        if (!LoadTransformYaml(lidarImuYaml, &lidarToImu, &err)) {
            report->error = err;
            return false;
        }
    }

    Transform imuToBev;
    {
        std::string err;
        if (!LoadImuToBev(vehicleJson, &imuToBev, &err)) {
            report->error = err;
            return false;
        }
    }

    // bev <- imu <- lidar <- camera
    Transform bevFromLidar = Compose(imuToBev, lidarToImu);

    // Schemas (registered once, shared across all camera channels).
    mcap::Schema cameraCalibSchema(
        kCameraCalibSchemaName, "protobuf",
        std::string_view(reinterpret_cast<const char*>(foxglove_fds::kCameraCalibrationFds),
                         foxglove_fds::kCameraCalibrationFdsSize));
    writer.addSchema(cameraCalibSchema);

    mcap::Schema frameTransformSchema(
        kFrameTransformSchemaName, "protobuf",
        std::string_view(reinterpret_cast<const char*>(foxglove_fds::kFrameTransformFds),
                         foxglove_fds::kFrameTransformFdsSize));
    writer.addSchema(frameTransformSchema);

    auto camFiles = ScanCameraFiles(platformDir);

    // Build set of present topic camera names if filter is provided.
    std::unordered_set<std::string> presentNames;
    for (const auto& topic : options.presentCameraTopics) {
        const std::string name = ExtractTopicCamName(topic);
        if (!name.empty()) {
            presentNames.insert(name);
        }
    }
    const bool hasFilter = !presentNames.empty();

    // Build reverse map: yamlCamName -> topicCamName(s) (multiple if both
    // fisheye and non-fisheye versions exist in the record; emit for each).
    std::unordered_map<std::string, std::vector<std::string>> yamlToTopicCams;
    if (hasFilter) {
        for (const auto& name : presentNames) {
            const std::string yamlName =
                TopicToYamlCamName("/sensor/camera/" + name + "/image/video");
            if (!yamlName.empty()) {
                yamlToTopicCams[yamlName].push_back(name);
            }
        }
    }

    // For each camera with files, load calibration and emit messages.
    for (const auto& [yamlCamName, files] : camFiles) {
        if (files.intrinsicsPath.empty() || files.extrinsicsPath.empty()) {
            report->warnings.push_back("incomplete files for camera: " + yamlCamName);
            continue;
        }

        std::vector<std::string> topicCamNames;
        if (hasFilter) {
            auto it = yamlToTopicCams.find(yamlCamName);
            if (it == yamlToTopicCams.end()) {
                continue;  // not present in record
            }
            topicCamNames = it->second;
        } else {
            // No filter: derive from yaml name (idx + position). We cannot
            // know whether the topic uses _fisheye_ form from the YAML alone,
            // so we emit only the simple form.
            const auto firstUs = yamlCamName.find('_');
            if (firstUs == std::string::npos) {
                continue;
            }
            const std::string idx = yamlCamName.substr(0, firstUs);
            const std::string position = yamlCamName.substr(firstUs + 1);
            topicCamNames.push_back(position + "_" + idx);
        }

        CameraCalib calib;
        {
            std::string err;
            if (!LoadIntrinsicsYaml(files.intrinsicsPath, &calib, &err)) {
                report->warnings.push_back(err);
                continue;
            }
        }

        Transform cameraToLidar;
        {
            std::string err;
            if (!LoadTransformYaml(files.extrinsicsPath, &cameraToLidar, &err)) {
                report->warnings.push_back(err);
                continue;
            }
        }

        // bev <- camera = bevFromLidar * lidarFromCamera (cameraToLidar maps
        // camera frame coordinates to lidar coords, which is what we need to
        // chain right-to-left).
        Transform bevFromCamera = Compose(bevFromLidar, cameraToLidar);

        for (const auto& topicCamName : topicCamNames) {
            const std::string videoTopic = "/sensor/camera/" + topicCamName + "/image/video";
            const std::string camInfoTopic = videoTopic + "_camera_info";
            const std::string transformTopic = videoTopic + "_transform";
            const std::string frameId = MakeCameraFrameId(topicCamName);

            mcap::Channel calibChannel(camInfoTopic, "protobuf", cameraCalibSchema.id);
            writer.addChannel(calibChannel);
            mcap::Channel transformChannel(transformTopic, "protobuf",
                                           frameTransformSchema.id);
            writer.addChannel(transformChannel);

            const std::string calibBytes =
                EncodeCameraCalibration(calib, options.timestampNs, frameId);
            mcap::Message calibMsg;
            calibMsg.channelId = calibChannel.id;
            calibMsg.sequence = 0;
            calibMsg.logTime = options.timestampNs;
            calibMsg.publishTime = options.timestampNs;
            calibMsg.dataSize = calibBytes.size();
            calibMsg.data = reinterpret_cast<const std::byte*>(calibBytes.data());
            const auto status1 = writer.write(calibMsg);
            if (!status1.ok()) {
                report->warnings.push_back("write calib failed for " + topicCamName +
                                            ": " + status1.message);
                continue;
            }
            ++report->injectedCalibrationChannels;

            const std::string transformBytes = EncodeFrameTransform(
                bevFromCamera, options.timestampNs, kBevFrameId, frameId);
            mcap::Message transformMsg;
            transformMsg.channelId = transformChannel.id;
            transformMsg.sequence = 0;
            transformMsg.logTime = options.timestampNs;
            transformMsg.publishTime = options.timestampNs;
            transformMsg.dataSize = transformBytes.size();
            transformMsg.data = reinterpret_cast<const std::byte*>(transformBytes.data());
            const auto status2 = writer.write(transformMsg);
            if (!status2.ok()) {
                report->warnings.push_back("write transform failed for " + topicCamName +
                                            ": " + status2.message);
                continue;
            }
            ++report->injectedTransformChannels;
        }
    }

    return true;
}

}  // namespace record2mcap
