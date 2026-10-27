cmake_minimum_required(VERSION 3.16)
project(TerraFusedMeasurementExperiment LANGUAGES C CXX)

# Test-only throughput/space experiment. Never add these exports to the SDK
# package or replace a verified runtime Wasm with this executable.
get_filename_component(TERRA_SDK_SOURCE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
add_subdirectory("${TERRA_SDK_SOURCE_ROOT}/adapters/wasm" sdk-wasm)
target_sources(terra_sdk_wasm PRIVATE
    compact_regions.cpp experiment.cpp)
get_target_property(experiment_link_options terra_sdk_wasm LINK_OPTIONS)
set(experiment_expanded_options)
foreach(option IN LISTS experiment_link_options)
    if(option MATCHES "^-sEXPORTED_FUNCTIONS=")
        string(APPEND option ",_bench_region_bytes,_bench_compact,_bench_copy_output,_bench_count,_bench_project,_bench_stage")
    endif()
    list(APPEND experiment_expanded_options "${option}")
endforeach()
set_target_properties(terra_sdk_wasm PROPERTIES
    LINK_OPTIONS "${experiment_expanded_options}"
    OUTPUT_NAME fused_measurement_experiment
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
