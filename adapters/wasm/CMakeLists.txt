cmake_minimum_required(VERSION 3.16)

project(TerraSdkWasm VERSION 0.1.0 LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "TerraSdkWasm requires the Emscripten toolchain")
endif()

set(TERRA_SDK_SOURCE_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../.."
    CACHE PATH "Terra SDK source root")

add_executable(terra_sdk_wasm
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/imagery/model.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/imagery/adapter.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/coordinate_transform.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/atmosphere.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/grid.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/metadata.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/wmts.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/core/payload_budget.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/codec/cbdam_height.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/codec/cbdam_hierarchy.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/camera.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/imagery.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/region_compaction.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/triangle_projection.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_source.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_projection.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_model.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_measurement.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/frame_packet.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/lod.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/mesh.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_replacement.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/surface_mesh.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/height_query.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/height_demand.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/height_session.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/height_storage.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/frame/record_storage.cpp"
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/c_api/terra.cpp")
target_sources(terra_sdk_wasm PRIVATE
    "${TERRA_SDK_SOURCE_ROOT}/sdk/src/c_api/surface_measurement_store.cpp")

target_compile_features(terra_sdk_wasm PRIVATE cxx_std_14)
target_include_directories(terra_sdk_wasm PRIVATE
    "${TERRA_SDK_SOURCE_ROOT}/sdk/include")
target_compile_definitions(terra_sdk_wasm PRIVATE
    TERRA_SDK_NO_EXCEPTIONS=1)
target_compile_options(terra_sdk_wasm PRIVATE
    -Wall
    -Wextra
    -O3
    -flto
    -fno-exceptions)

# Prioritize runtime throughput in the portable Wasm distribution. Package size
# is advisory; keep strict floating-point semantics and portable instructions.
# Behavioral, native parity and navigation gates run the distributed binary.
target_link_options(terra_sdk_wasm PRIVATE
    -O3
    -flto
    "--no-entry"
    "-sSTANDALONE_WASM=1"
    "-sFILESYSTEM=0"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sABORTING_MALLOC=0"
    "-sINITIAL_MEMORY=16777216"
    "-sMAXIMUM_MEMORY=268435456"
    "-sERROR_ON_UNDEFINED_SYMBOLS=1"
    "--js-library=${CMAKE_CURRENT_LIST_DIR}/clock.js"
    "-sEXPORTED_FUNCTIONS=_terra_abi_version,_terra_sizeof_terrain_manifest_v3,_terra_sizeof_viewport_v1,_terra_sizeof_camera_v3,_terra_sizeof_camera_snapshot_v1,_terra_sizeof_patch_key_v1,_terra_sizeof_texture_node_v3,_terra_sizeof_request_v1,_terra_sizeof_patch_decision_v1,_terra_sizeof_draw_range_v1,_terra_sizeof_frame_v1,_terra_sizeof_stats_v1,_terra_sizeof_atmosphere_parameters_v1,_terra_sizeof_atmosphere_result_v1,_terra_compute_atmosphere,_terra_create,_terra_destroy,_terra_configure_terrain_capacity,_terra_set_record_work_limit,_terra_record_payload_bytes,_terra_trim_record_cache,_terra_load_terrain_manifest,_terra_set_viewport,_terra_set_camera,_terra_set_globe_target,_terra_set_planar_target,_terra_set_planar_level,_terra_submit_record,_terra_fail_record,_terra_no_data_record,_terra_set_terrain_mesh_budget,_terra_retry_record,_terra_update,_terra_get_camera_snapshot,_terra_get_requests,_terra_get_frame,_terra_get_frame_patches,_terra_get_index_buffer,_terra_get_stats,_terra_get_last_error,_terra_sizeof_update_budget_v2,_terra_sizeof_update_state_v2,_terra_sizeof_mesh_resource_v3,_terra_sizeof_frame_receipt_v2,_terra_sizeof_mesh_plan_v1,_terra_mesh_replacement_work_bytes,_terra_begin_mesh_replacement,_terra_step_mesh_replacement,_terra_get_mesh_replacement,_terra_end_mesh_replacement,_terra_select_mesh_groups,_terra_reuse_mesh_replacement,_terra_sizeof_replacement_member_v1,_terra_prepare_mesh_frame,_terra_get_prepared_mesh_resources,_terra_get_prepared_mesh_uv,_terra_get_prepared_mesh_positions,_terra_step_mesh_frame,_terra_commit_mesh_frame,_terra_discard_mesh_plan,_terra_mesh_payload_bytes,_terra_trim_mesh_cache,_terra_update_step,_terra_advance_terrain,_terra_set_height_work_limit,_terra_height_work_bytes,_terra_height_payload_bytes,_terra_trim_height_cache,_terra_discard_terrain_work,_terra_get_update_state,_terra_get_terrain_error,_terra_sizeof_terrain_sample_v1,_terra_sample_terrain,_terra_sizeof_height_query_state_v1,_terra_sizeof_height_region_v1,_terra_get_height_query_region,_terra_begin_height_query,_terra_step_height_query,_terra_get_height_query_requests,_terra_submit_height_query_record,_terra_height_query_unavailable,_terra_end_height_query,_terra_get_no_data_count,_terra_get_mesh_resources,_terra_get_mesh_position_view,_terra_get_mesh_texture_view,_terra_acquire_mesh_resource,_terra_release_mesh_resource,_terra_present_frame,_terra_retain_meshes,_terra_sizeof_imagery_options_v4,_terra_sizeof_imagery_surface_v3,_terra_sizeof_imagery_region_v4,_terra_sizeof_imagery_hull_point_v3,_terra_sizeof_imagery_draw_v3,_terra_sizeof_imagery_quality_v4,_terra_imagery_payload_bytes,_terra_imagery_input_work_bytes,_terra_imagery_input_payload_bytes,_terra_imagery_output_payload_bytes,_terra_imagery_output_work_bytes,_terra_imagery_reference_payload_bytes,_terra_imagery_reference_work_bytes,_terra_reclaim_imagery_references,_terra_stage_imagery_input,_terra_append_imagery_surface,_terra_append_retained_imagery_surface,_terra_append_imagery_regions,_terra_append_imagery_hull,_terra_commit_imagery_input,_terra_cancel_imagery_input,_terra_open_imagery,_terra_close_imagery,_terra_plan_imagery,_terra_begin_imagery,_terra_step_imagery,_terra_get_imagery_draws,_terra_get_imagery_quality,_terra_reset_imagery,_terra_accept_imagery,_terra_sizeof_surface_work_v1,_terra_sizeof_surface_projection_v1,_terra_sizeof_surface_summary_v1,_terra_surface_model_work_bytes,_terra_surface_measurement_work_bytes,_terra_open_surface_model,_terra_step_surface_model,_terra_close_surface_model,_terra_open_surface_measurement,_terra_step_surface_measurement,_terra_get_surface_measurement_summary,_terra_get_surface_measurement_regions,_terra_get_surface_measurement_hull,_terra_append_measured_imagery_surface,_terra_close_surface_measurement,_terra_alloc,_terra_free")

set_target_properties(terra_sdk_wasm PROPERTIES
    CXX_EXTENSIONS OFF
    OUTPUT_NAME terra_sdk
    SUFFIX ".wasm")
