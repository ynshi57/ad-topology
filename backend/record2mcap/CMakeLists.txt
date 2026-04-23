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

add_executable(record2mcap
    src/main.cc
    src/record_to_mcap.cc
    src/mcap_impl.cc
)

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
    )
    target_include_directories(record2mcap_test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
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
