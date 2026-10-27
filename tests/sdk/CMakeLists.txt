set(_terra_sdk_core_golden
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/native_behavior_v1.txt")
set(_terra_sdk_patch_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_patch_record.bin")
set(_terra_sdk_patch_golden
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/patch_decode_v1.txt")
set(_terra_sdk_root0_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_root_0_record.bin")
set(_terra_sdk_root0_detail_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_root_0_detail_record.bin")
set(_terra_sdk_root3_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_root_3_record.bin")
set(_terra_sdk_root3_detail_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_root_3_detail_record.bin")
set(_terra_sdk_child_detail_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/globe_patch_record.bin")
set(_terra_sdk_planar_root_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/planar_root_record.bin")
set(_terra_sdk_planar_root_detail_record
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/planar_root_detail_record.bin")

add_executable(terra_sdk_core_transform_golden
    terra_core_coordinate_transform_golden.cpp)
target_link_libraries(terra_sdk_core_transform_golden PRIVATE Terra::core)
target_compile_features(terra_sdk_core_transform_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_core_transform_golden PRIVATE -Wall -Wextra)
endif()

set(_terra_sdk_core_link_manifest
    "${CMAKE_CURRENT_BINARY_DIR}/terra_core_links.txt")
file(GENERATE OUTPUT "${_terra_sdk_core_link_manifest}"
    CONTENT "core.private=$<TARGET_PROPERTY:terra_core,LINK_LIBRARIES>\ncore.interface=$<TARGET_PROPERTY:terra_core,INTERFACE_LINK_LIBRARIES>\ncodec.private=$<TARGET_PROPERTY:terra_codec,LINK_LIBRARIES>\ncodec.interface=$<TARGET_PROPERTY:terra_codec,INTERFACE_LINK_LIBRARIES>\nframe.private=$<TARGET_PROPERTY:terra_frame,LINK_LIBRARIES>\nframe.interface=$<TARGET_PROPERTY:terra_frame,INTERFACE_LINK_LIBRARIES>\nc_api.private=$<TARGET_PROPERTY:terra_c_api,LINK_LIBRARIES>\nc_api.interface=$<TARGET_PROPERTY:terra_c_api,INTERFACE_LINK_LIBRARIES>\n")

add_test(NAME terra_sdk_core_transform_golden
    COMMAND "$<TARGET_FILE:terra_sdk_core_transform_golden>"
        "${_terra_sdk_core_golden}")
add_test(NAME terra_sdk_core_dependency_closure
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${CMAKE_SOURCE_DIR}"
        "-DLINK_MANIFEST=${_terra_sdk_core_link_manifest}"
        -P "${CMAKE_SOURCE_DIR}/sdk/cmake/CheckTerraSdkDependencies.cmake")

add_executable(terra_sdk_core_atmosphere terra_core_atmosphere.cpp)
target_link_libraries(terra_sdk_core_atmosphere PRIVATE Terra::core)
target_compile_features(terra_sdk_core_atmosphere PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_core_atmosphere PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_core_atmosphere
    COMMAND "$<TARGET_FILE:terra_sdk_core_atmosphere>")

add_executable(terra_sdk_core_metadata_golden
    terra_core_metadata_golden.cpp)
target_link_libraries(terra_sdk_core_metadata_golden PRIVATE Terra::core)
target_compile_features(terra_sdk_core_metadata_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_core_metadata_golden PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_core_metadata_golden
    COMMAND "$<TARGET_FILE:terra_sdk_core_metadata_golden>"
        "${_terra_sdk_core_golden}")

add_executable(terra_sdk_core_topology_golden
    terra_core_topology_golden.cpp)
target_link_libraries(terra_sdk_core_topology_golden PRIVATE Terra::core)
target_compile_features(terra_sdk_core_topology_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_core_topology_golden PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_core_topology_golden
    COMMAND "$<TARGET_FILE:terra_sdk_core_topology_golden>"
        "${_terra_sdk_core_golden}")

add_executable(terra_sdk_core_wmts_selection
    terra_core_wmts_selection.cpp)
target_link_libraries(terra_sdk_core_wmts_selection PRIVATE Terra::core)
target_compile_features(terra_sdk_core_wmts_selection PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_core_wmts_selection PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_core_wmts_selection
    COMMAND "$<TARGET_FILE:terra_sdk_core_wmts_selection>")

add_executable(terra_sdk_codec_patch_golden
    terra_codec_patch_golden.cpp)
target_link_libraries(terra_sdk_codec_patch_golden PRIVATE Terra::codec)
target_compile_features(terra_sdk_codec_patch_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_codec_patch_golden PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_codec_patch_golden
    COMMAND "$<TARGET_FILE:terra_sdk_codec_patch_golden>"
        "${_terra_sdk_patch_record}" "${_terra_sdk_patch_golden}")

add_executable(terra_sdk_codec_hierarchy
    terra_codec_hierarchy.cpp)
target_link_libraries(terra_sdk_codec_hierarchy PRIVATE Terra::codec)
target_compile_features(terra_sdk_codec_hierarchy PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_codec_hierarchy PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_codec_hierarchy
    COMMAND "$<TARGET_FILE:terra_sdk_codec_hierarchy>")

add_executable(terra_sdk_frame_camera_golden
    terra_frame_camera_golden.cpp)
target_link_libraries(terra_sdk_frame_camera_golden PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_camera_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_camera_golden PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_camera_golden
    COMMAND "$<TARGET_FILE:terra_sdk_frame_camera_golden>"
        "${_terra_sdk_core_golden}")

add_executable(terra_sdk_frame_packet
    terra_frame_packet.cpp)
target_link_libraries(terra_sdk_frame_packet PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_packet PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_packet PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_packet
    COMMAND "$<TARGET_FILE:terra_sdk_frame_packet>")

add_executable(terra_sdk_frame_mesh
    terra_frame_mesh.cpp)
target_link_libraries(terra_sdk_frame_mesh PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_mesh PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_mesh PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_mesh
    COMMAND "$<TARGET_FILE:terra_sdk_frame_mesh>")

add_executable(terra_sdk_frame_surface_mesh
    terra_frame_surface_mesh.cpp)
target_link_libraries(terra_sdk_frame_surface_mesh PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_surface_mesh PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_surface_mesh PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_surface_mesh
    COMMAND "$<TARGET_FILE:terra_sdk_frame_surface_mesh>")

add_executable(terra_sdk_frame_height_demand terra_frame_height_demand.cpp)
target_link_libraries(terra_sdk_frame_height_demand PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_height_demand PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_height_demand PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_height_demand COMMAND "$<TARGET_FILE:terra_sdk_frame_height_demand>")

add_executable(terra_sdk_frame_planar
    terra_frame_planar.cpp)
target_link_libraries(terra_sdk_frame_planar PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_planar PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_planar PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_planar
    COMMAND "$<TARGET_FILE:terra_sdk_frame_planar>")

add_executable(terra_sdk_frame_lod_golden
    terra_frame_lod_golden.cpp)
target_link_libraries(terra_sdk_frame_lod_golden PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_lod_golden PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_lod_golden PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_lod_golden
    COMMAND "$<TARGET_FILE:terra_sdk_frame_lod_golden>"
        "${_terra_sdk_core_golden}")

add_executable(terra_sdk_frame_lod_controller
    terra_frame_lod_controller.cpp)
target_link_libraries(terra_sdk_frame_lod_controller PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_lod_controller PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(
        terra_sdk_frame_lod_controller PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_lod_controller
    COMMAND "$<TARGET_FILE:terra_sdk_frame_lod_controller>")

add_executable(terra_sdk_frame_lod_budget terra_frame_lod_budget.cpp)
target_link_libraries(terra_sdk_frame_lod_budget PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_lod_budget PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_lod_budget PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_lod_budget
    COMMAND "$<TARGET_FILE:terra_sdk_frame_lod_budget>")

add_executable(terra_sdk_c_api_contract
    terra_c_api_contract.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_c_api_contract PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_contract PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_contract PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_contract
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_contract>"
        "${_terra_sdk_root0_record}" "${_terra_sdk_root0_detail_record}"
        "${_terra_sdk_root3_record}" "${_terra_sdk_root3_detail_record}"
        "${_terra_sdk_child_detail_record}")

add_executable(terra_sdk_c_api_atmosphere terra_c_api_atmosphere.cpp)
target_link_libraries(terra_sdk_c_api_atmosphere PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_atmosphere PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_atmosphere PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_atmosphere
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_atmosphere>")

add_executable(terra_sdk_c_api_header terra_c_api_header.c)
target_link_libraries(terra_sdk_c_api_header PRIVATE Terra::c_api)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_header PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_header
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_header>")

add_executable(terra_sdk_c_api_parity
    terra_c_api_parity.cpp)
target_link_libraries(terra_sdk_c_api_parity PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_parity PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_parity PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_parity
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_parity>"
        "${_terra_sdk_root0_record}" "${_terra_sdk_root0_detail_record}"
        "${_terra_sdk_root3_record}" "${_terra_sdk_root3_detail_record}"
        "${_terra_sdk_child_detail_record}")

add_executable(terra_sdk_c_api_planar
    terra_c_api_planar.cpp)
target_link_libraries(terra_sdk_c_api_planar PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_planar PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_planar PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_planar
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_planar>"
        "${_terra_sdk_planar_root_record}"
        "${_terra_sdk_planar_root_detail_record}")

add_executable(terra_sdk_c_api_sparse_globe
    terra_c_api_sparse_globe.cpp)
target_link_libraries(terra_sdk_c_api_sparse_globe PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_sparse_globe PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_sparse_globe PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_sparse_globe
    COMMAND "$<TARGET_FILE:terra_sdk_c_api_sparse_globe>"
        "${_terra_sdk_root0_record}"
        "${_terra_sdk_root0_detail_record}")

set(_terra_sdk_dependency_fixture_dir
    "${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
add_test(NAME terra_sdk_core_dependency_guard_include
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${_terra_sdk_dependency_fixture_dir}/forbidden_include"
        "-DLINK_MANIFEST=${_terra_sdk_dependency_fixture_dir}/clean_links.txt"
        -P "${CMAKE_SOURCE_DIR}/sdk/cmake/CheckTerraSdkDependencies.cmake")
set_tests_properties(terra_sdk_core_dependency_guard_include PROPERTIES
    WILL_FAIL TRUE)

add_test(NAME terra_sdk_core_dependency_guard_link
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${_terra_sdk_dependency_fixture_dir}/clean"
        "-DLINK_MANIFEST=${_terra_sdk_dependency_fixture_dir}/forbidden_links.txt"
        -P "${CMAKE_SOURCE_DIR}/sdk/cmake/CheckTerraSdkDependencies.cmake")
set_tests_properties(terra_sdk_core_dependency_guard_link PROPERTIES
    WILL_FAIL TRUE)

add_custom_target(terra_sdk_core_tests
    DEPENDS
        terra_sdk_core_atmosphere
        terra_sdk_core_metadata_golden
        terra_sdk_core_topology_golden
        terra_sdk_core_transform_golden
        terra_sdk_core_wmts_selection)
add_custom_target(terra_sdk_codec_tests
    DEPENDS
        terra_sdk_codec_hierarchy
        terra_sdk_codec_patch_golden)
add_executable(terra_sdk_frame_imagery terra_frame_imagery.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_imagery PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_imagery PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_imagery PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_imagery COMMAND "$<TARGET_FILE:terra_sdk_frame_imagery>")

add_executable(terra_sdk_frame_region_compaction terra_frame_region_compaction.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_region_compaction PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_region_compaction PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_region_compaction PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_region_compaction COMMAND "$<TARGET_FILE:terra_sdk_frame_region_compaction>"
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/region_compaction_v1.bin")

add_custom_target(terra_sdk_frame_tests
    DEPENDS
        terra_sdk_frame_camera_golden
        terra_sdk_frame_imagery
        terra_sdk_frame_region_compaction
        terra_sdk_imagery_model
        terra_sdk_frame_lod_golden
        terra_sdk_frame_lod_controller
        terra_sdk_frame_lod_budget
        terra_sdk_frame_mesh
        terra_sdk_frame_surface_mesh
        terra_sdk_frame_height_demand
        terra_sdk_frame_planar
        terra_sdk_frame_packet)
add_custom_target(terra_sdk_c_api_tests
    DEPENDS
        terra_sdk_c_api_atmosphere
        terra_sdk_c_api_contract
        terra_sdk_c_api_header
        terra_sdk_c_api_parity
        terra_sdk_c_api_planar
        terra_sdk_c_api_sparse_globe)

add_executable(terra_sdk_imagery_model terra_imagery_model.cpp)
target_link_libraries(terra_sdk_imagery_model PRIVATE Terra::frame)
target_compile_features(terra_sdk_imagery_model PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_imagery_model PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_imagery_model COMMAND "$<TARGET_FILE:terra_sdk_imagery_model>")

add_executable(terra_sdk_frame_surface_replacement terra_frame_surface_replacement.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_surface_replacement PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_surface_replacement PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_surface_replacement PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_surface_replacement COMMAND "$<TARGET_FILE:terra_sdk_frame_surface_replacement>")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_surface_replacement)

add_executable(terra_sdk_frame_height_storage terra_frame_height_storage.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_height_storage PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_height_storage PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_height_storage PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_height_storage COMMAND "$<TARGET_FILE:terra_sdk_frame_height_storage>")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_height_storage)

add_executable(terra_sdk_frame_record_storage terra_frame_record_storage.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_record_storage PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_record_storage PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_record_storage PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_record_storage COMMAND "$<TARGET_FILE:terra_sdk_frame_record_storage>"
    "${_terra_sdk_root0_record}" "${_terra_sdk_root0_detail_record}")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_record_storage)

# Explicit offline/reference tool; not installed in the SDK or launched by CTest.
add_executable(terra_sdk_terrain_reference ../benchmarks/terrain_reference.cpp)
target_link_libraries(terra_sdk_terrain_reference PRIVATE Terra::frame)
target_compile_features(terra_sdk_terrain_reference PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_terrain_reference PRIVATE -Wall -Wextra)
endif()

add_executable(terra_sdk_frame_lod_elevation terra_frame_lod_elevation.cpp)
target_link_libraries(terra_sdk_frame_lod_elevation PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_lod_elevation PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_lod_elevation PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_lod_elevation COMMAND "$<TARGET_FILE:terra_sdk_frame_lod_elevation>")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_lod_elevation)
add_dependencies(terra_sdk_frame_tests terra_sdk_terrain_reference)

add_executable(terra_sdk_frame_surface_projection terra_frame_surface_projection.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_surface_projection PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_surface_projection PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_surface_projection PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_surface_projection COMMAND "$<TARGET_FILE:terra_sdk_frame_surface_projection>"
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/surface_projection_v1.bin")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_surface_projection)

add_executable(terra_sdk_frame_surface_model terra_frame_surface_model.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_surface_model PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_surface_model PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_surface_model PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_surface_model COMMAND "$<TARGET_FILE:terra_sdk_frame_surface_model>")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_surface_model)

add_executable(terra_sdk_frame_imagery_input terra_frame_imagery_input.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_frame_imagery_input PRIVATE Terra::frame)
target_compile_features(terra_sdk_frame_imagery_input PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_frame_imagery_input PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_frame_imagery_input COMMAND "$<TARGET_FILE:terra_sdk_frame_imagery_input>")
add_dependencies(terra_sdk_frame_tests terra_sdk_frame_imagery_input)

add_executable(terra_sdk_c_api_surface_measurement terra_c_api_surface_measurement.cpp observed_allocations.cpp)
target_link_libraries(terra_sdk_c_api_surface_measurement PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_api_surface_measurement PRIVATE cxx_std_14)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_api_surface_measurement PRIVATE -Wall -Wextra)
endif()
add_test(NAME terra_sdk_c_api_surface_measurement COMMAND "$<TARGET_FILE:terra_sdk_c_api_surface_measurement>"
    "${_terra_sdk_planar_root_record}" "${_terra_sdk_planar_root_detail_record}")
add_dependencies(terra_sdk_c_api_tests terra_sdk_c_api_surface_measurement)
