set(_terra_sdk_core_golden
    "${CMAKE_SOURCE_DIR}/testdata/miniprogram/golden/native_behavior_v1.txt")

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
    CONTENT "core.private=$<TARGET_PROPERTY:terra_core,LINK_LIBRARIES>\ncore.interface=$<TARGET_PROPERTY:terra_core,INTERFACE_LINK_LIBRARIES>\nframe.private=$<TARGET_PROPERTY:terra_frame,LINK_LIBRARIES>\nframe.interface=$<TARGET_PROPERTY:terra_frame,INTERFACE_LINK_LIBRARIES>\n")

add_test(NAME terra_sdk_core_transform_golden
    COMMAND "$<TARGET_FILE:terra_sdk_core_transform_golden>"
        "${_terra_sdk_core_golden}")
add_test(NAME terra_sdk_core_dependency_closure
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${CMAKE_SOURCE_DIR}"
        "-DLINK_MANIFEST=${_terra_sdk_core_link_manifest}"
        -P "${CMAKE_SOURCE_DIR}/sdk/cmake/CheckTerraSdkDependencies.cmake")

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
        terra_sdk_core_topology_golden
        terra_sdk_core_transform_golden
        terra_sdk_core_wmts_selection)
add_custom_target(terra_sdk_frame_tests
    DEPENDS terra_sdk_frame_camera_golden)
