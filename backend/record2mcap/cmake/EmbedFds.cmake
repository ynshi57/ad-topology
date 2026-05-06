# Embed FileDescriptorSet binaries as a C++ header containing static byte arrays.
# Inputs:
#   CAMERA_FDS    - path to CameraCalibration FileDescriptorSet binary
#   TRANSFORM_FDS - path to FrameTransform FileDescriptorSet binary
#   OUT_HEADER    - path to write the generated header

function(read_binary_as_hex path out_var)
    file(READ ${path} content HEX)
    string(LENGTH "${content}" hex_len)
    math(EXPR num_bytes "${hex_len} / 2")
    set(formatted "")
    set(idx 0)
    while(idx LESS hex_len)
        string(SUBSTRING "${content}" ${idx} 2 byte)
        if(formatted)
            set(formatted "${formatted}, 0x${byte}")
        else()
            set(formatted "0x${byte}")
        endif()
        math(EXPR idx "${idx} + 2")
    endwhile()
    set(${out_var} "${formatted}" PARENT_SCOPE)
    set(${out_var}_LEN ${num_bytes} PARENT_SCOPE)
endfunction()

read_binary_as_hex(${CAMERA_FDS} CAM_BYTES)
read_binary_as_hex(${TRANSFORM_FDS} TF_BYTES)

set(HEADER_CONTENT "// Auto-generated. DO NOT EDIT.
// Embedded foxglove FileDescriptorSet binaries.
#pragma once
#include <cstddef>
#include <cstdint>

namespace record2mcap {
namespace foxglove_fds {

inline constexpr unsigned char kCameraCalibrationFds[] = {
    ${CAM_BYTES}
};
inline constexpr size_t kCameraCalibrationFdsSize = ${CAM_BYTES_LEN};

inline constexpr unsigned char kFrameTransformFds[] = {
    ${TF_BYTES}
};
inline constexpr size_t kFrameTransformFdsSize = ${TF_BYTES_LEN};

}  // namespace foxglove_fds
}  // namespace record2mcap
")

file(WRITE ${OUT_HEADER} "${HEADER_CONTENT}")
