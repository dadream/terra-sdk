cmake_minimum_required(VERSION 3.16)

project(TerraSdkWasm VERSION 0.1.0 LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "TerraSdkWasm requires the Emscripten toolchain")
endif()

set(TERRA_SDK_SOURCE_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../.."
    CACHE PATH "Terra SDK source root")

add_executable(terra_sdk_wasm
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/coordinate_transform.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/grid.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/metadata.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/wmts.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/codec/cbdam_height.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/codec/cbdam_hierarchy.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/camera.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/frame_packet.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/lod.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/mesh.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_mesh.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/c_api/terra.cpp")

target_compile_features(terra_sdk_wasm PRIVATE cxx_std_14)
target_include_directories(terra_sdk_wasm PRIVATE
    "${TERRA_SDK_SOURCE_ROOT}/sdk/include")
target_compile_definitions(terra_sdk_wasm PRIVATE
    TERRA_SDK_NO_EXCEPTIONS=1)
target_compile_options(terra_sdk_wasm PRIVATE
    -Wall
    -Wextra
    -fno-exceptions)

target_link_options(terra_sdk_wasm PRIVATE
    "--no-entry"
    "-sSTANDALONE_WASM=1"
    "-sFILESYSTEM=0"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_MEMORY=16777216"
    "-sMAXIMUM_MEMORY=67108864"
    "-sERROR_ON_UNDEFINED_SYMBOLS=1"
    "-sEXPORTED_FUNCTIONS=_terra_abi_version,_terra_sizeof_manifest_v1,_terra_sizeof_viewport_v1,_terra_sizeof_camera_v1,_terra_sizeof_patch_key_v1,_terra_sizeof_texture_key_v1,_terra_sizeof_request_v1,_terra_sizeof_patch_decision_v1,_terra_sizeof_draw_range_v1,_terra_sizeof_frame_v1,_terra_sizeof_stats_v1,_terra_create,_terra_destroy,_terra_load_manifest,_terra_set_viewport,_terra_set_camera,_terra_set_globe_target,_terra_set_planar_target,_terra_set_planar_level,_terra_submit_record,_terra_submit_patch,_terra_fail_record,_terra_fail_patch,_terra_retry_record,_terra_update,_terra_get_requests,_terra_get_frame,_terra_get_frame_patches,_terra_get_draw_ranges,_terra_get_position_buffer,_terra_get_texture_uv_buffer,_terra_get_index_buffer,_terra_get_stats,_terra_get_last_error,_terra_alloc,_terra_free")

set_target_properties(terra_sdk_wasm PROPERTIES
    CXX_EXTENSIONS OFF
    OUTPUT_NAME terra_sdk
    SUFFIX ".wasm")
