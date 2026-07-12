cmake_minimum_required(VERSION 3.16)

project(TerraSdk VERSION 0.1.0 LANGUAGES C CXX)

include(CTest)

set(TERRA_SDK_SOURCE_ROOT
    "${CMAKE_CURRENT_SOURCE_DIR}"
    CACHE PATH "Terra SDK monorepo source root")
set(TERRA_SDK_SPACELIB_SOURCE_DIR
    "${TERRA_SDK_SOURCE_ROOT}/spacelib"
    CACHE PATH "spacelib source directory")
set(TERRA_SDK_RATMAN_SOURCE_DIR
    "${TERRA_SDK_SOURCE_ROOT}/ratman"
    CACHE PATH "ratman source directory")

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

include(CompilerOptions)
include(InstallLayout)

option(TERRA_SDK_ENABLE_SL_TESTS
    "Build the legacy spacelib testsuite and benchmarks." OFF)
set(SL_TEST "${TERRA_SDK_ENABLE_SL_TESTS}" CACHE BOOL
    "Build spacelib testsuite and benchmark apps." FORCE)
set(SL_DOC OFF CACHE BOOL "Build spacelib HTML documentation." FORCE)

add_subdirectory("${TERRA_SDK_SPACELIB_SOURCE_DIR}" spacelib)
if(NOT TARGET sl)
    message(FATAL_ERROR "The in-tree spacelib project did not define target sl")
endif()
target_compile_features(sl PUBLIC cxx_std_14)
target_include_directories(sl PUBLIC
    "$<BUILD_INTERFACE:${TERRA_SDK_SPACELIB_SOURCE_DIR}/src>"
    "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
add_library(Terra::sl ALIAS sl)

include(Dependencies)
include(TargetHelpers)
add_subdirectory(sdk)
include(RatmanBaseTargets)
include(RatmanCoreTargets)
include(RatmanAppTargets)
include(RatmanServiceTargets)
include(RatmanSdkSmokeTests)

terra_sdk_record_artifact(sl
    "${CMAKE_STATIC_LIBRARY_PREFIX}sl${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_write_artifact_registry("${CMAKE_CURRENT_BINARY_DIR}/terra_sdk_cmake_artifacts.tsv")

message(STATUS "Terra SDK source root: ${TERRA_SDK_SOURCE_ROOT}")
message(STATUS "spacelib source dir: ${TERRA_SDK_SPACELIB_SOURCE_DIR}")
message(STATUS "ratman source dir: ${TERRA_SDK_RATMAN_SOURCE_DIR}")
message(STATUS "install prefix: ${CMAKE_INSTALL_PREFIX}")

message(STATUS "spacelib is configured as in-tree target Terra::sl")

set(_terra_sdk_cmake_smoke_dependencies)
foreach(_terra_sdk_smoke_target
        terra_core
        terra_frame
        terra_sdk_core_tests
        terra_sdk_frame_tests
        sl
        vic_base_math
        vic_base_xml
        vic_base_img
        vic_base_curlstream
        vic_base_fetcher
        vic_base_qxml
        vic_base_mpi
        vic_base_gl
        vic_base_persistent
        vic_core_vfs
        vic_core_geo_base
        vic_core_geo_srs
        vic_core_geo_builder
        vic_core_cbdam_geo
        vic_core_cbdam_base
        vic_core_ratman
        vic_app_geo_raster_quadtree_builder
        vic_app_cbdam_mpi_builder
        vic_app_cbdam_viewer
        vic_app_ratman_nav3d
        vic_service_mod_victms
        terra_sdk_sdk_smoke_tests)
    if(TARGET ${_terra_sdk_smoke_target})
        list(APPEND _terra_sdk_cmake_smoke_dependencies ${_terra_sdk_smoke_target})
    endif()
endforeach()

add_custom_target(terra_sdk_cmake_smoke ALL
    COMMAND "${CMAKE_COMMAND}" -E echo "Terra SDK monorepo build configured"
    DEPENDS ${_terra_sdk_cmake_smoke_dependencies}
    VERBATIM)
