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

add_executable(terra_sdk_c_api_contract
    terra_c_api_contract.cpp)
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
        terra_sdk_core_metadata_golden
        terra_sdk_core_topology_golden
        terra_sdk_core_transform_golden
        terra_sdk_core_wmts_selection)
add_custom_target(terra_sdk_codec_tests
    DEPENDS
        terra_sdk_codec_hierarchy
        terra_sdk_codec_patch_golden)
add_custom_target(terra_sdk_frame_tests
    DEPENDS
        terra_sdk_frame_camera_golden
        terra_sdk_frame_lod_golden
        terra_sdk_frame_lod_controller
        terra_sdk_frame_mesh
        terra_sdk_frame_surface_mesh
        terra_sdk_frame_planar
        terra_sdk_frame_packet)
add_custom_target(terra_sdk_c_api_tests
    DEPENDS
        terra_sdk_c_api_contract
        terra_sdk_c_api_header
        terra_sdk_c_api_parity
        terra_sdk_c_api_planar
        terra_sdk_c_api_sparse_globe)
