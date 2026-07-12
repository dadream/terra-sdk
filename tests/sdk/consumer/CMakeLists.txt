cmake_minimum_required(VERSION 3.16)
project(TerraSdkConsumer LANGUAGES CXX)

find_package(TerraSdk CONFIG REQUIRED)

add_executable(terra_sdk_consumer main.cpp)
target_link_libraries(terra_sdk_consumer PRIVATE Terra::core)
target_compile_features(terra_sdk_consumer PRIVATE cxx_std_14)
