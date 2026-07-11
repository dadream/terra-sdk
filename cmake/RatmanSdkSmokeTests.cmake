option(TERRA_SDK_ENABLE_SDK_SMOKE_TESTS
    "Build and run SDK-level smoke tests for platform-neutral base modules." ON)

if(TERRA_SDK_ENABLE_SDK_SMOKE_TESTS)
    set(_terra_sdk_sdk_smoke_targets)

    if(NOT TARGET vic_base_math)
        message(WARNING "vic_base_math dependency not available; skipping SDK smoke tests")
    elseif(NOT TARGET vic_base_xml)
        message(WARNING "vic_base_xml dependency not available; skipping SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_math_xml_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_math_xml_smoke.cpp")
        target_link_libraries(terra_sdk_base_math_xml_smoke
            PRIVATE vic_base_math vic_base_xml terra_sdk_project_options)
        target_include_directories(terra_sdk_base_math_xml_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_math_xml_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_math_xml_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_math_xml_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_math_xml_smoke")
    endif()

    if(NOT TARGET vic_base_img)
        message(WARNING "vic_base_img dependency not available; skipping base image SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_img_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_img_smoke.cpp")
        target_link_libraries(terra_sdk_base_img_smoke
            PRIVATE vic_base_img terra_sdk_project_options)
        target_include_directories(terra_sdk_base_img_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_img_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_img_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_img_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_img_smoke")
    endif()

    if(NOT TARGET vic_base_curlstream)
        message(WARNING "vic_base_curlstream dependency not available; skipping base curlstream SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_curlstream_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_curlstream_smoke.cpp")
        target_link_libraries(terra_sdk_base_curlstream_smoke
            PRIVATE vic_base_curlstream terra_sdk_project_options)
        target_include_directories(terra_sdk_base_curlstream_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_curlstream_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_curlstream_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_curlstream_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_curlstream_smoke")
    endif()

    if(NOT TARGET vic_base_qxml)
        message(WARNING "vic_base_qxml dependency not available; skipping base qxml SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_qxml_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_qxml_smoke.cpp")
        target_link_libraries(terra_sdk_base_qxml_smoke
            PRIVATE vic_base_qxml terra_sdk_project_options)
        target_include_directories(terra_sdk_base_qxml_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_qxml_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_qxml_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_qxml_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_qxml_smoke")
    endif()

    if(NOT TARGET vic_base_fetcher)
        message(WARNING "vic_base_fetcher dependency not available; skipping base fetcher SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_fetcher_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_fetcher_smoke.cpp")
        target_link_libraries(terra_sdk_base_fetcher_smoke
            PRIVATE vic_base_fetcher terra_sdk_project_options)
        target_include_directories(terra_sdk_base_fetcher_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_fetcher_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_fetcher_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_fetcher_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_fetcher_smoke")
    endif()

    if(NOT TARGET vic_base_persistent)
        message(WARNING "vic_base_persistent dependency not available; skipping base persistent SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_persistent_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_persistent_smoke.cpp")
        target_link_libraries(terra_sdk_base_persistent_smoke
            PRIVATE vic_base_persistent terra_sdk_project_options)
        target_include_directories(terra_sdk_base_persistent_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_persistent_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_persistent_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_persistent_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_persistent_smoke")
    endif()

    if(NOT TARGET vic_base_mpi)
        message(WARNING "vic_base_mpi dependency not available; skipping base MPI SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_mpi_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_mpi_smoke.cpp")
        target_link_libraries(terra_sdk_base_mpi_smoke
            PRIVATE vic_base_mpi terra_sdk_project_options)
        target_include_directories(terra_sdk_base_mpi_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_mpi_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_mpi_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_mpi_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_mpi_smoke")
    endif()

    if(NOT TARGET vic_base_gl)
        message(WARNING "vic_base_gl dependency not available; skipping base GL SDK smoke tests")
    else()
        set(_terra_sdk_base_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/base")
        add_executable(terra_sdk_base_gl_smoke
            "${_terra_sdk_base_smoke_dir}/sdk_base_gl_smoke.cpp")
        target_link_libraries(terra_sdk_base_gl_smoke
            PRIVATE vic_base_gl terra_sdk_project_options)
        target_include_directories(terra_sdk_base_gl_smoke
            PRIVATE "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_base_gl_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_base_gl_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_base_gl_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_base_gl_smoke")
    endif()

    if(NOT TARGET vic_core_geo_base)
        message(WARNING "vic_core_geo_base dependency not available; skipping Geo SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_geo_tilemap_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_geo_tilemap_smoke.cpp")
        target_link_libraries(terra_sdk_geo_tilemap_smoke
            PRIVATE vic_core_geo_base terra_sdk_project_options)
        target_include_directories(terra_sdk_geo_tilemap_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_geo_tilemap_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_geo_tilemap_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_geo_tilemap_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_geo_tilemap_smoke")

        add_executable(terra_sdk_geo_victms_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_geo_victms_smoke.cpp")
        target_link_libraries(terra_sdk_geo_victms_smoke
            PRIVATE vic_core_geo_base terra_sdk_project_options)
        target_include_directories(terra_sdk_geo_victms_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_geo_victms_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_geo_victms_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_geo_victms_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_geo_victms_smoke")
    endif()

    if(NOT TARGET vic_core_geo_srs)
        message(WARNING "vic_core_geo_srs dependency not available; skipping Geo SRS SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_geo_srs_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_geo_srs_smoke.cpp")
        target_link_libraries(terra_sdk_geo_srs_smoke
            PRIVATE vic_core_geo_srs terra_sdk_project_options)
        target_include_directories(terra_sdk_geo_srs_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_geo_srs_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_geo_srs_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_geo_srs_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_geo_srs_smoke")
    endif()

    if(NOT TARGET vic_core_geo_builder)
        message(WARNING "vic_core_geo_builder dependency not available; skipping Geo builder SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_geo_builder_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_geo_builder_smoke.cpp")
        target_link_libraries(terra_sdk_geo_builder_smoke
            PRIVATE vic_core_geo_builder vic_core_geo_base terra_sdk_project_options)
        target_include_directories(terra_sdk_geo_builder_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_geo_builder_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_geo_builder_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_geo_builder_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_geo_builder_smoke")
    endif()

    if(NOT TARGET vic_core_vfs)
        message(WARNING "vic_core_vfs dependency not available; skipping VFS SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_vfs_repository_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_vfs_repository_smoke.cpp")
        target_link_libraries(terra_sdk_vfs_repository_smoke
            PRIVATE vic_core_vfs terra_sdk_project_options)
        target_include_directories(terra_sdk_vfs_repository_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_vfs_repository_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_vfs_repository_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_vfs_repository_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_vfs_repository_smoke")
    endif()

    if(NOT TARGET vic_core_cbdam_geo)
        message(WARNING "vic_core_cbdam_geo dependency not available; skipping CBDAM Geo SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_cbdam_geo_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_cbdam_geo_smoke.cpp")
        target_link_libraries(terra_sdk_cbdam_geo_smoke
            PRIVATE vic_core_cbdam_geo terra_sdk_project_options)
        target_include_directories(terra_sdk_cbdam_geo_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_cbdam_geo_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_cbdam_geo_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_cbdam_geo_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_cbdam_geo_smoke")
    endif()

    if(NOT TARGET vic_core_cbdam_base)
        message(WARNING "vic_core_cbdam_base dependency not available; skipping CBDAM SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_cbdam_repository_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_cbdam_repository_smoke.cpp")
        target_link_libraries(terra_sdk_cbdam_repository_smoke
            PRIVATE vic_core_cbdam_base terra_sdk_project_options)
        target_include_directories(terra_sdk_cbdam_repository_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_cbdam_repository_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_cbdam_repository_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        set(_terra_sdk_miniprogram_golden_dir
            "${CMAKE_CURRENT_SOURCE_DIR}/testdata/miniprogram/golden")
        add_executable(terra_sdk_cbdam_native_behavior_golden
            "${_terra_sdk_core_smoke_dir}/sdk_cbdam_native_behavior_golden.cpp")
        target_link_libraries(terra_sdk_cbdam_native_behavior_golden
            PRIVATE vic_core_cbdam_base terra_sdk_project_options)
        target_include_directories(terra_sdk_cbdam_native_behavior_golden
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_cbdam_native_behavior_golden
                COMMAND "$<TARGET_FILE:terra_sdk_cbdam_native_behavior_golden>"
                    "${_terra_sdk_miniprogram_golden_dir}/globe_terrain.xml"
                    "${_terra_sdk_miniprogram_golden_dir}/native_behavior_v1.txt"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_cbdam_repository_smoke
            terra_sdk_cbdam_native_behavior_golden)
        message(STATUS "Configured SDK smoke test terra_sdk_cbdam_repository_smoke")
        message(STATUS "Configured SDK golden test terra_sdk_cbdam_native_behavior_golden")
    endif()

    if(NOT TARGET vic_core_ratman)
        message(WARNING "vic_core_ratman dependency not available; skipping Ratman core SDK smoke tests")
    else()
        set(_terra_sdk_core_smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/tests/core")
        add_executable(terra_sdk_ratman_core_smoke
            "${_terra_sdk_core_smoke_dir}/sdk_ratman_core_smoke.cpp")
        target_link_libraries(terra_sdk_ratman_core_smoke
            PRIVATE vic_core_ratman terra_sdk_project_options)
        target_include_directories(terra_sdk_ratman_core_smoke
            PRIVATE
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src")

        if(BUILD_TESTING)
            add_test(NAME terra_sdk_ratman_core_smoke
                COMMAND "$<TARGET_FILE:terra_sdk_ratman_core_smoke>"
                WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
        endif()

        list(APPEND _terra_sdk_sdk_smoke_targets
            terra_sdk_ratman_core_smoke)
        message(STATUS "Configured SDK smoke test terra_sdk_ratman_core_smoke")
    endif()

    if(_terra_sdk_sdk_smoke_targets)
        add_custom_target(terra_sdk_sdk_smoke_tests
            DEPENDS ${_terra_sdk_sdk_smoke_targets})
    endif()
endif()
