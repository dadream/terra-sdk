# Test-only drivers. Desktop selection remains in the preserved CBDAM library;
# no application source, window or GL context is used by this executable.
if(TARGET vic_core_cbdam_base AND TARGET Terra::frame)
    add_executable(terra_benchmark_terrain terrain.cpp imagery.cpp)
    target_link_libraries(terra_benchmark_terrain PRIVATE
        Terra::frame vic_core_cbdam_base terra_sdk_project_options)
    target_include_directories(terra_benchmark_terrain PRIVATE
        "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
        "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")
    # Do not apply the legacy client's fast-math option to input validation.
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        set_source_files_properties(terrain.cpp imagery.cpp PROPERTIES COMPILE_OPTIONS -fno-fast-math)
    endif()
endif()
