cmake_minimum_required(VERSION 3.14)
project(record2mcap CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(CYBERRT_ROOT "/home/caros/cyberrt" CACHE PATH "CyberRT install root")
set(GEARS_ROOT "/home/caros/workspace/gears/x86_64" CACHE PATH "Gears sysroot")

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
    ${CYBERRT_ROOT}/include
    ${GEARS_ROOT}/include
    /home/caros/workspace/cyber/cyber/spdlog/include
)

link_directories(
    ${CYBERRT_ROOT}/lib
    ${GEARS_ROOT}/lib
)

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)
include_directories(${JSONCPP_INCLUDE_DIRS})

# ---------------------------------------------------------------------------
# Foxglove proto schemas: compile to C++ classes (for message serialization)
# and to FileDescriptorSet binaries (for embedding in mcap channels)
# ---------------------------------------------------------------------------
set(PROTOC_BIN "${GEARS_ROOT}/bin/protoc")
set(FOXGLOVE_PROTO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/foxglove_schemas")
set(FOXGLOVE_PROTO_FILES
    ${FOXGLOVE_PROTO_DIR}/Time.proto
    ${FOXGLOVE_PROTO_DIR}/Vector3.proto
    ${FOXGLOVE_PROTO_DIR}/Quaternion.proto
    ${FOXGLOVE_PROTO_DIR}/CameraCalibration.proto
    ${FOXGLOVE_PROTO_DIR}/FrameTransform.proto
)
set(FOXGLOVE_PROTO_GEN_DIR "${CMAKE_CURRENT_BINARY_DIR}/foxglove_proto_gen")
file(MAKE_DIRECTORY ${FOXGLOVE_PROTO_GEN_DIR})

set(FOXGLOVE_PROTO_GEN_SRCS
    ${FOXGLOVE_PROTO_GEN_DIR}/Time.pb.cc
    ${FOXGLOVE_PROTO_GEN_DIR}/Vector3.pb.cc
    ${FOXGLOVE_PROTO_GEN_DIR}/Quaternion.pb.cc
    ${FOXGLOVE_PROTO_GEN_DIR}/CameraCalibration.pb.cc
    ${FOXGLOVE_PROTO_GEN_DIR}/FrameTransform.pb.cc
)
set(FOXGLOVE_PROTO_GEN_HDRS
    ${FOXGLOVE_PROTO_GEN_DIR}/Time.pb.h
    ${FOXGLOVE_PROTO_GEN_DIR}/Vector3.pb.h
    ${FOXGLOVE_PROTO_GEN_DIR}/Quaternion.pb.h
    ${FOXGLOVE_PROTO_GEN_DIR}/CameraCalibration.pb.h
    ${FOXGLOVE_PROTO_GEN_DIR}/FrameTransform.pb.h
)
add_custom_command(
    OUTPUT ${FOXGLOVE_PROTO_GEN_SRCS} ${FOXGLOVE_PROTO_GEN_HDRS}
    COMMAND ${PROTOC_BIN}
        --proto_path=${FOXGLOVE_PROTO_DIR}
        --cpp_out=${FOXGLOVE_PROTO_GEN_DIR}
        ${FOXGLOVE_PROTO_FILES}
    DEPENDS ${FOXGLOVE_PROTO_FILES}
    COMMENT "Generating foxglove proto C++ sources"
    VERBATIM
)

# FileDescriptorSet binaries (one per top-level message, with imports inlined)
set(FOXGLOVE_FDS_DIR "${CMAKE_CURRENT_BINARY_DIR}/foxglove_fds")
file(MAKE_DIRECTORY ${FOXGLOVE_FDS_DIR})
set(FOXGLOVE_FDS_FILES
    ${FOXGLOVE_FDS_DIR}/CameraCalibration.fds
    ${FOXGLOVE_FDS_DIR}/FrameTransform.fds
)
add_custom_command(
    OUTPUT ${FOXGLOVE_FDS_DIR}/CameraCalibration.fds
    COMMAND ${PROTOC_BIN}
        --proto_path=${FOXGLOVE_PROTO_DIR}
        --include_imports
        --descriptor_set_out=${FOXGLOVE_FDS_DIR}/CameraCalibration.fds
        ${FOXGLOVE_PROTO_DIR}/CameraCalibration.proto
    DEPENDS ${FOXGLOVE_PROTO_FILES}
    COMMENT "Generating CameraCalibration FileDescriptorSet"
    VERBATIM
)
add_custom_command(
    OUTPUT ${FOXGLOVE_FDS_DIR}/FrameTransform.fds
    COMMAND ${PROTOC_BIN}
        --proto_path=${FOXGLOVE_PROTO_DIR}
        --include_imports
        --descriptor_set_out=${FOXGLOVE_FDS_DIR}/FrameTransform.fds
        ${FOXGLOVE_PROTO_DIR}/FrameTransform.proto
    DEPENDS ${FOXGLOVE_PROTO_FILES}
    COMMENT "Generating FrameTransform FileDescriptorSet"
    VERBATIM
)

# Convert FDS binaries to C header with byte arrays
set(FOXGLOVE_FDS_HEADER "${CMAKE_CURRENT_BINARY_DIR}/foxglove_proto_gen/foxglove_fds_data.h")
add_custom_command(
    OUTPUT ${FOXGLOVE_FDS_HEADER}
    COMMAND ${CMAKE_COMMAND}
        -DCAMERA_FDS=${FOXGLOVE_FDS_DIR}/CameraCalibration.fds
        -DTRANSFORM_FDS=${FOXGLOVE_FDS_DIR}/FrameTransform.fds
        -DOUT_HEADER=${FOXGLOVE_FDS_HEADER}
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedFds.cmake
    DEPENDS ${FOXGLOVE_FDS_FILES} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedFds.cmake
    COMMENT "Embedding FileDescriptorSet binaries as C++ header"
    VERBATIM
)

add_custom_target(foxglove_proto_codegen ALL
    DEPENDS
        ${FOXGLOVE_PROTO_GEN_SRCS}
        ${FOXGLOVE_PROTO_GEN_HDRS}
        ${FOXGLOVE_FDS_HEADER}
)

include_directories(${FOXGLOVE_PROTO_GEN_DIR})

add_executable(record2mcap
    src/main.cc
    src/record_to_mcap.cc
    src/mcap_impl.cc
    src/calibration_injector.cc
    ${FOXGLOVE_PROTO_GEN_SRCS}
)
add_dependencies(record2mcap foxglove_proto_codegen)

target_link_libraries(record2mcap
    cyber
    protobuf
    glog
    gflags
    spdlog
    pthread
    rt
    atomic
    uuid
    zstd
    lz4
    yaml-cpp
    ${JSONCPP_LIBRARIES}
)

set_target_properties(record2mcap PROPERTIES
    INSTALL_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
    BUILD_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
)
# Use DT_RPATH (not DT_RUNPATH) so transitive library lookups (e.g. libcyber
# needing libglog) resolve against GEARS_ROOT/lib without requiring callers to
# set LD_LIBRARY_PATH.
target_link_options(record2mcap PRIVATE "-Wl,--disable-new-dtags")

target_compile_options(record2mcap PRIVATE -O2 -g -Wall -Wno-unused-parameter)

# ---------------------------------------------------------------------------
# Optional end-to-end verification test (gtest).
# Build with: -DRECORD2MCAP_BUILD_TESTS=ON
# ---------------------------------------------------------------------------
option(RECORD2MCAP_BUILD_TESTS "Build record2mcap unit tests" OFF)
if(RECORD2MCAP_BUILD_TESTS)
    add_executable(record2mcap_test
        tests/record2mcap_test.cc
        src/record_to_mcap.cc
        src/mcap_impl.cc
        src/calibration_injector.cc
        ${FOXGLOVE_PROTO_GEN_SRCS}
    )
    add_dependencies(record2mcap_test foxglove_proto_codegen)
    target_include_directories(record2mcap_test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${FOXGLOVE_PROTO_GEN_DIR}
    )
    target_link_libraries(record2mcap_test
        cyber
        protobuf
        glog
        gflags
        spdlog
        pthread
        rt
        atomic
        uuid
        zstd
        lz4
        yaml-cpp
        ${JSONCPP_LIBRARIES}
        gtest
        gtest_main
    )
    set_target_properties(record2mcap_test PROPERTIES
        INSTALL_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
        BUILD_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
    )
    target_link_options(record2mcap_test PRIVATE "-Wl,--disable-new-dtags")
    target_compile_options(record2mcap_test PRIVATE -O0 -g -Wall)
    enable_testing()
    add_test(NAME record2mcap_roundtrip COMMAND record2mcap_test)
endif()
