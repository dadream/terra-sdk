cmake_minimum_required(VERSION 3.16)
project(TerraSdkCppExample LANGUAGES CXX)

find_package(TerraSdk 0.1 CONFIG REQUIRED)

add_executable(terra_sdk_cpp_example main.cpp)
target_link_libraries(terra_sdk_cpp_example PRIVATE Terra::core Terra::frame)
target_compile_features(terra_sdk_cpp_example PRIVATE cxx_std_14)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_cpp_example PRIVATE -Wall -Wextra)
endif()
