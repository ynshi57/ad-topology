cmake_minimum_required(VERSION 3.14)
project(executor_harness CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CYBERRT_ROOT "/home/caros/cyberrt" CACHE PATH "CyberRT install root")
set(GEARS_ROOT "/home/caros/workspace/gears/x86_64" CACHE PATH "Gears sysroot")

include_directories(
    ${CYBERRT_ROOT}/include
    ${GEARS_ROOT}/include
    /home/caros/workspace/nexis_kernel/include
    /home/caros/workspace/cyber/cyber/spdlog/include
)

link_directories(
    ${CYBERRT_ROOT}/lib
    ${GEARS_ROOT}/lib
)

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)
include_directories(${JSONCPP_INCLUDE_DIRS})

add_executable(executor_harness
    src/main.cpp
    src/executor_harness.cpp
    src/cyber_harness.cpp
)

target_link_libraries(executor_harness
    dl
    nexis_kernel
    cyber
    protobuf
    glog
    gflags
    brpc
    spdlog
    fastrtps
    fastcdr
    ${JSONCPP_LIBRARIES}
    pthread
    rt
    atomic
    uuid
)

set_target_properties(executor_harness PROPERTIES
    INSTALL_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
    BUILD_RPATH "${CYBERRT_ROOT}/lib;${GEARS_ROOT}/lib"
)

target_compile_options(executor_harness PRIVATE -O0 -g -Wall)
target_compile_definitions(executor_harness PRIVATE ENABLE_HASH_KEY)
