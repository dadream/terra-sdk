add_library(terra_core STATIC
    src/core/coordinate_transform.cpp
    src/core/grid.cpp
    src/core/wmts.cpp
    include/terra/core/coordinate_transform.hpp
    include/terra/core/grid.hpp
    include/terra/core/types.hpp
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
    include/terra/codec/cbdam_height.hpp)
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
    include/terra/frame/camera.hpp)
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
target_link_libraries(terra_frame PUBLIC Terra::core)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_frame PRIVATE -Wall -Wextra)
endif()

install(TARGETS terra_core terra_codec terra_frame
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

terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_core${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_codec${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)
terra_sdk_record_artifact(lib
    "${CMAKE_STATIC_LIBRARY_PREFIX}terra_frame${CMAKE_STATIC_LIBRARY_SUFFIX}"
    file)

if(BUILD_TESTING)
    add_subdirectory("${CMAKE_SOURCE_DIR}/tests/sdk"
                     "${CMAKE_CURRENT_BINARY_DIR}/tests")
endif()
