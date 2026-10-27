option(TERRA_SDK_ENABLE_TERRAIN_SERVICE
    "Build the versioned terrain delivery service." ON)

if(TERRA_SDK_ENABLE_TERRAIN_SERVICE)
    if(NOT TARGET terra_core)
        message(FATAL_ERROR "terra_core is required by the terrain service")
    elseif(NOT TARGET vic_core_vfs)
        message(FATAL_ERROR "vic_core_vfs is required by the terrain service")
    elseif(NOT TARGET vic_base_xml)
        message(FATAL_ERROR "vic_base_xml is required by the terrain service")
    endif()

    set(_terra_terrain_service_include_dir
        "${CMAKE_CURRENT_SOURCE_DIR}/include")

    add_library(terra_terrain_service_core STATIC
        src/terrain_service.cpp
        include/terra/service/terrain_service.hpp)
    target_link_libraries(terra_terrain_service_core
        PUBLIC
            terra_sdk_project_options
            terra_core
        PRIVATE
            vic_core_vfs
            vic_base_xml)
    target_include_directories(terra_terrain_service_core
        PUBLIC
            "$<BUILD_INTERFACE:${_terra_terrain_service_include_dir}>")
    add_library(Terra::terrain_service_core ALIAS terra_terrain_service_core)

    terra_sdk_add_executable(terra_terrain_service
        SOURCES src/main.cpp
        PUBLIC_DEPS terra_terrain_service_core)
    set_target_properties(terra_terrain_service PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

    if(BUILD_TESTING)
        add_executable(terra_terrain_service_contract
            tests/terrain_service_contract.cpp)
        target_link_libraries(terra_terrain_service_contract
            PRIVATE
                terra_sdk_project_options
                terra_terrain_service_core
                vic_core_vfs)
        add_test(
            NAME terra_terrain_service_contract
            COMMAND terra_terrain_service_contract
                "${TERRA_SDK_SOURCE_ROOT}/testdata/datasets/ps_1k/reference/terrain"
                "${TERRA_SDK_SOURCE_ROOT}/testdata/datasets/ps_1k/source/ps_texture_1k.png")
    endif()

    message(STATUS
        "Configured terrain delivery service target terra_terrain_service")
endif()