file(REMOVE_RECURSE
  "CMakeFiles/foxglove_proto_codegen"
  "foxglove_fds/CameraCalibration.fds"
  "foxglove_fds/FrameTransform.fds"
  "foxglove_proto_gen/CameraCalibration.pb.cc"
  "foxglove_proto_gen/CameraCalibration.pb.h"
  "foxglove_proto_gen/FrameTransform.pb.cc"
  "foxglove_proto_gen/FrameTransform.pb.h"
  "foxglove_proto_gen/Quaternion.pb.cc"
  "foxglove_proto_gen/Quaternion.pb.h"
  "foxglove_proto_gen/Time.pb.cc"
  "foxglove_proto_gen/Time.pb.h"
  "foxglove_proto_gen/Vector3.pb.cc"
  "foxglove_proto_gen/Vector3.pb.h"
  "foxglove_proto_gen/foxglove_fds_data.h"
)

# Per-language clean rules from dependency scanning.
foreach(lang )
  include(CMakeFiles/foxglove_proto_codegen.dir/cmake_clean_${lang}.cmake OPTIONAL)
endforeach()
