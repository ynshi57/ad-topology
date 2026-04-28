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
    # facilities_inl.hpp lives under nexis_kernel/src; the harness needs it to
    # call DataFacilityInl.push(name) so that the executor's NXFacility.idata()
    # lookups resolve to the same IDs we insert. xxhash_wrapper.h (pulled in
    # by facilities_inl.hpp) lives next to it and depends on the bundled
    # xxhash header tree.
    /home/caros/workspace/nexis_kernel/src
    /home/caros/workspace/nexis_kernel/import/xxhash/include
    /home/caros/workspace/cyber/cyber/spdlog/include
    # Proto generated headers (localization_dead_reckoning.pb.h etc.)
    ${CYBERRT_ROOT}/include/proto
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
    vehicle_pose_manager
    common_message
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
target_compile_definitions(executor_harness PRIVATE
    ENABLE_HASH_KEY
    # facilities_inl.hpp pulls in xxhash via xxhash_wrapper.h. xxhash is
    # header-only when XXH_INLINE_ALL is defined; matches the import config
    # used by nexis_kernel itself.
    XXH_INLINE_ALL=1
)

# ---------------------------------------------------------------------------
# record2mcap: offline Apollo Cyber Record -> MCAP converter CLI.
# Lives under backend/record2mcap/ and can also be built stand-alone from
# that directory. Adding it as a subdirectory here lets `make` at this level
# produce both executables in one step.
# ---------------------------------------------------------------------------
add_subdirectory(record2mcap EXCLUDE_FROM_ALL)
add_custom_target(record2mcap_all ALL DEPENDS record2mcap)
