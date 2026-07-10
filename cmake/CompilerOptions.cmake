set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

add_library(terra_sdk_project_options INTERFACE)
target_compile_features(terra_sdk_project_options INTERFACE cxx_std_14)
target_compile_definitions(terra_sdk_project_options INTERFACE
    _FILE_OFFSET_BITS=64
    _LARGEFILE_SOURCE
    _LARGEFILE64_SOURCE)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(terra_sdk_project_options INTERFACE
        $<$<COMPILE_LANGUAGE:C>:-Wall>
        $<$<COMPILE_LANGUAGE:C>:-Wextra>
        $<$<COMPILE_LANGUAGE:CXX>:-Wall>
        $<$<COMPILE_LANGUAGE:CXX>:-Wextra>
        $<$<CONFIG:Release>:-O3>
        $<$<CONFIG:Release>:-ffast-math>)
endif()

target_compile_definitions(terra_sdk_project_options INTERFACE
    $<$<CONFIG:Debug>:_GLIBCXX_DEBUG>
    $<$<CONFIG:Release>:NDEBUG>)

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    target_compile_definitions(terra_sdk_project_options INTERFACE __LIB64__)
else()
    target_compile_definitions(terra_sdk_project_options INTERFACE __LIB32__)
endif()
