#ifndef AD_TOPOLOGY_RECORD2MCAP_CALIBRATION_INJECTOR_H_
#define AD_TOPOLOGY_RECORD2MCAP_CALIBRATION_INJECTOR_H_

#include <array>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "mcap/mcap.hpp"

namespace record2mcap {

// Plain-old-data carrier for one calibrated camera.
struct CameraCalib {
    std::string topicCamName;       // e.g. "rear_right_6"
    int width = 0;
    int height = 0;
    std::string distortionModel;    // e.g. "plumb_bob"
    double fx = 0, fy = 0, cx = 0, cy = 0;
    std::vector<double> D;          // 5 or 8 distortion coeffs
    // Final composed transform: bev (parent) -> camera (child).
    // Quaternion convention: (w, x, y, z).
    std::array<double, 4> rotation_wxyz{1.0, 0.0, 0.0, 0.0};
    std::array<double, 3> translation_xyz{0.0, 0.0, 0.0};
};

struct CalibrationInjectionOptions {
    // Required: platform name. Empty disables injection.
    std::string platform;

    // Path overrides. If empty, sensible defaults under /home/caros/workspace
    // are used (see calibration_injector.cc for the default values).
    std::string defaultParamRoot;     // root for DefaultParam (e.g. .../perception/DefaultParam)
    std::string vehicleConfigRoot;    // root for vehicle_config_<lc>.json
    std::string lidarImuYamlPath;     // path to velodyne16_back_novatel_extrinsics.yaml

    // Optional: list of camera video topics observed in the record. Used to
    // skip cameras whose topic is not present in the record. If empty, all
    // cameras with calibration files are emitted.
    std::vector<std::string> presentCameraTopics;

    // Time stamp (ns) to use for injected messages. Should match record start.
    uint64_t timestampNs = 0;
};

struct CalibrationInjectionReport {
    bool ran = false;
    int injectedCalibrationChannels = 0;
    int injectedTransformChannels = 0;
    std::vector<std::string> warnings;
    std::string error;
};

// Loads calibration files for the given platform, composes bev->camera
// transforms, encodes foxglove.CameraCalibration and foxglove.FrameTransform
// messages, and writes them to the open mcap writer as new channels.
//
// Returns true on overall success. Individual missing camera files become
// warnings (not failures), so a record with only some cameras still produces
// useful output.
bool InjectCalibration(mcap::McapWriter& writer,
                       const CalibrationInjectionOptions& options,
                       CalibrationInjectionReport* report);

// --- exposed for testing ---
// "/sensor/camera/front_middle_fisheye_0/image/video" -> "0_front_middle"
std::string TopicToYamlCamName(const std::string& videoTopic);

// "X3PRO_25_L" -> "x3pro_25_l"
std::string PlatformToVehicleConfigSuffix(const std::string& platform);

}  // namespace record2mcap

#endif  // AD_TOPOLOGY_RECORD2MCAP_CALIBRATION_INJECTOR_H_
