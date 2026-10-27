add_library(terra_core STATIC
    src/imagery/model.cpp
    src/imagery/adapter.cpp
    src/core/atmosphere.cpp
    src/core/coordinate_transform.cpp
    src/core/grid.cpp
    src/core/metadata.cpp
    src/core/wmts.cpp
    src/core/payload_budget.cpp
    include/terra/core/coordinate_transform.hpp
    include/terra/core/atmosphere.hpp
    include/terra/core/grid.hpp
    include/terra/core/metadata.hpp
    include/terra/core/types.hpp
    include/terra/core/payload_budget.hpp
    include/terra/core/wmts.hpp)
add_library(Terra::core ALIAS terra_core)

set_target_properties(terra_core PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    EXPORT_NAME core
    OUTPUT_NAME terra_core)

target_compile_features(terra_core PUBLIC cxx_std_14)
target_include_directories(terra_core
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
        "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_core PRIVATE -Wall -Wextra)
endif()

add_library(terra_codec STATIC
    src/codec/cbdam_height.cpp
    src/codec/cbdam_hierarchy.cpp
    include/terra/codec/cbdam_height.hpp
    include/terra/codec/cbdam_hierarchy.hpp)
add_library(Terra::codec ALIAS terra_codec)

set_target_properties(terra_codec PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    EXPORT_NAME codec
    OUTPUT_NAME terra_codec)

target_compile_features(terra_codec PUBLIC cxx_std_14)
target_include_directories(terra_codec
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
        "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_codec PRIVATE -Wall -Wextra)
endif()

add_library(terra_frame STATIC
    src/frame/camera.cpp
    src/frame/imagery.cpp
    src/frame/region_compaction.cpp
    src/frame/triangle_projection.cpp
    src/frame/surface_source.cpp
    src/frame/surface_projection.cpp
    src/frame/surface_model.cpp
    src/frame/surface_measurement.cpp
    src/frame/surface_sampling.hpp
    src/frame/surface_blocks.hpp
    src/frame/surface_block_projection.hpp
    src/frame/surface_measurement_cursor.hpp
    src/frame/frame_packet.cpp
    src/frame/lod.cpp
    src/frame/mesh.cpp
    src/frame/surface_replacement.cpp
    src/frame/surface_mesh.cpp
    src/frame/height_query.cpp
    src/frame/height_demand.cpp
    src/frame/height_session.cpp
    src/frame/height_storage.cpp
    src/frame/record_storage.cpp
    include/terra/frame/camera.hpp
    include/terra/frame/imagery.hpp
    include/terra/frame/imagery_input.hpp
    include/terra/frame/region_compaction.hpp
    include/terra/frame/triangle_projection.hpp
    include/terra/frame/surface_source.hpp
    include/terra/frame/surface_projection.hpp
    include/terra/frame/surface_model.hpp
    include/terra/frame/surface_measurement.hpp
    include/terra/frame/frame_packet.hpp
    include/terra/frame/lod.hpp
    include/terra/frame/mesh.hpp
    include/terra/frame/surface_replacement.hpp
    include/terra/frame/surface_mesh.hpp
    include/terra/frame/height_query.hpp
    include/terra/frame/height_demand.hpp
    include/terra/frame/height_session.hpp
    include/terra/frame/height_storage.hpp
    include/terra/frame/record_storage.hpp)
add_library(Terra::frame ALIAS terra_frame)

set_target_properties(terra_frame PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    EXPORT_NAME frame
    OUTPUT_NAME terra_frame)

target_compile_features(terra_frame PUBLIC cxx_std_14)
target_include_directories(terra_frame
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
        "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
target_link_libraries(terra_frame PUBLIC Terra::core Terra::codec)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_frame PRIVATE -Wall -Wextra)
endif()

add_library(terra_c_api STATIC
    src/c_api/terra.cpp
    src/c_api/surface_measurement_store.cpp
    src/c_api/surface_measurement_store.hpp
    src/c_api/mesh_source.hpp
    include/terra/c_api/terra.h)
add_library(Terra::c_api ALIAS terra_c_api)

set_target_properties(terra_c_api PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    EXPORT_NAME c_api
    OUTPUT_NAME terra_c_api)

target_compile_features(terra_c_api PUBLIC cxx_std_14)
target_include_directories(terra_c_api
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
        "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
target_link_libraries(terra_c_api
    PUBLIC Terra::core Terra::codec Terra::frame)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_c_api PRIVATE -Wall -Wextra)
endif()

install(TARGETS terra_core terra_codec terra_frame terra_c_api
    EXPORT TerraSdkTargets
    ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
    COMPONENT TerraSdk)
install(DIRECTORY include/
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}"
    COMPONENT TerraSdk)

include(CMakePackageConfigHelpers)
configure_package_config_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/TerraSdkConfig.cmake.in"
    "${CMAKE_CURRENT_BINARY_DIR}/TerraSdkConfig.cmake"
    INSTALL_DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/TerraSdk")
write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/TerraSdkConfigVersion.cmake"
    VERSION "${PROJECT_VERSION}"
    COMPATIBILITY SameMajorVersion)

install(EXPORT TerraSdkTargets
    FILE TerraSdkTargets.cmake
    NAMESPACE Terra::
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/TerraSdk"
    COMPONENT TerraSdk)
install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/TerraSdkConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/TerraSdkConfigVersion.cmake"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/TerraSdk"
    COMPONENT TerraSdk)

install(FILES
    "${CMAKE_SOURCE_DIR}/README.md"
    "${CMAKE_SOURCE_DIR}/NOTICE"
    "${CMAKE_SOURCE_DIR}/docs/SDK_RELEASE.md"
    "${CMAKE_SOURCE_DIR}/docs/SDK_CANONICAL_IMAGERY_INPUT.md"
    "${CMAKE_SOURCE_DIR}/docs/SDK_HOST_MEASUREMENTS.md"
    "${CMAKE_SOURCE_DIR}/docs/SDK_NATIVE_MEASUREMENT_API.md"
    "${CMAKE_SOURCE_DIR}/docs/miniprogram/WASM_SDK_V1.md"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/doc/TerraSdk"
    COMPONENT TerraSdk)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/examples/"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/doc/TerraSdk/examples"
    COMPONENT TerraSdk
    FILES_MATCHING
        PATTERN "README.md"
        PATTERN "CMakeLists.txt"
        PATTERN "*.cpp"
        PATTERN "*.c")
install(FILES "${CMAKE_SOURCE_DIR}/LICENSE"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/TerraSdk"
    COMPONENT TerraSdk)
install(FILES "${CMAKE_SOURCE_DIR}/spacelib/COPYING"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/TerraSdk/spacelib"
    COMPONENT TerraSdk)
install(FILES "${CMAKE_SOURCE_DIR}/ratman/LICENSE"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/TerraSdk/ratman"
    COMPONENT TerraSdk)

terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_core${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_codec${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_frame${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_c_api${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)

if(BUILD_TESTING)
    add_subdirectory("${CMAKE_SOURCE_DIR}/tests/sdk"
                     "${CMAKE_CURRENT_BINARY_DIR}/tests")
endif()
