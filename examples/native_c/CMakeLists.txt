cmake_minimum_required(VERSION 3.16)
project(TerraSdkCExample LANGUAGES C CXX)

find_package(TerraSdk 0.1 CONFIG REQUIRED)

add_executable(terra_sdk_c_example main.c)
target_link_libraries(terra_sdk_c_example PRIVATE Terra::c_api)
target_compile_features(terra_sdk_c_example PRIVATE c_std_99)
set_target_properties(terra_sdk_c_example PROPERTIES LINKER_LANGUAGE CXX)

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_c_example PRIVATE -Wall -Wextra)
endif()
