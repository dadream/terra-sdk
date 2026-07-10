function(terra_sdk_record_artifact kind artifact mode)
    set_property(GLOBAL APPEND PROPERTY TERRA_SDK_CMAKE_ARTIFACT_REGISTRY
        "${kind}\t${artifact}\t${mode}")
endfunction()

function(terra_sdk_write_artifact_registry output_file)
    get_property(_terra_sdk_artifacts GLOBAL PROPERTY TERRA_SDK_CMAKE_ARTIFACT_REGISTRY)

    file(WRITE "${output_file}" "# kind\tartifact\tmode\n")
    if(_terra_sdk_artifacts)
        list(SORT _terra_sdk_artifacts)
        foreach(_terra_sdk_artifact IN LISTS _terra_sdk_artifacts)
            file(APPEND "${output_file}" "${_terra_sdk_artifact}\n")
        endforeach()
    endif()

    message(STATUS "Wrote additive CMake artifact registry: ${output_file}")
endfunction()

function(terra_sdk_add_static_library target_name)
    set(options)
    set(one_value_args OUTPUT_NAME HEADER_SUBDIR)
    set(multi_value_args SOURCES HEADERS PUBLIC_DEPS PRIVATE_DEPS PUBLIC_INCLUDE_DIRS PRIVATE_INCLUDE_DIRS)
    cmake_parse_arguments(ARG
        "${options}"
        "${one_value_args}"
        "${multi_value_args}"
        ${ARGN})

    if(NOT ARG_SOURCES)
        message(FATAL_ERROR "terra_sdk_add_static_library(${target_name}) requires SOURCES")
    endif()

    if(ARG_HEADERS)
        set_source_files_properties(${ARG_HEADERS} PROPERTIES HEADER_FILE_ONLY TRUE)
    endif()

    add_library(${target_name} STATIC ${ARG_SOURCES} ${ARG_HEADERS})
    target_link_libraries(${target_name}
        PUBLIC terra_sdk_project_options ${ARG_PUBLIC_DEPS}
        PRIVATE ${ARG_PRIVATE_DEPS})
    target_include_directories(${target_name}
        PUBLIC
            "$<BUILD_INTERFACE:${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src>"
            "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>"
            ${ARG_PUBLIC_INCLUDE_DIRS}
        PRIVATE
            ${ARG_PRIVATE_INCLUDE_DIRS})

    if(ARG_OUTPUT_NAME)
        set(_terra_sdk_output_name "${ARG_OUTPUT_NAME}")
        set_target_properties(${target_name} PROPERTIES OUTPUT_NAME "${_terra_sdk_output_name}")
    else()
        set(_terra_sdk_output_name "${target_name}")
    endif()

    terra_sdk_record_artifact(lib
        "${CMAKE_STATIC_LIBRARY_PREFIX}${_terra_sdk_output_name}${CMAKE_STATIC_LIBRARY_SUFFIX}"
        file)

    install(TARGETS ${target_name}
        ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")

    if(ARG_HEADERS AND ARG_HEADER_SUBDIR)
        install(FILES ${ARG_HEADERS}
            DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}/${ARG_HEADER_SUBDIR}")
    endif()
endfunction()

function(terra_sdk_add_executable target_name)
    set(options)
    set(one_value_args OUTPUT_NAME)
    set(multi_value_args SOURCES HEADERS PUBLIC_DEPS PRIVATE_DEPS PRIVATE_INCLUDE_DIRS)
    cmake_parse_arguments(ARG
        "${options}"
        "${one_value_args}"
        "${multi_value_args}"
        ${ARGN})

    if(NOT ARG_SOURCES)
        message(FATAL_ERROR "terra_sdk_add_executable(${target_name}) requires SOURCES")
    endif()

    if(ARG_HEADERS)
        set_source_files_properties(${ARG_HEADERS} PROPERTIES HEADER_FILE_ONLY TRUE)
    endif()

    add_executable(${target_name} ${ARG_SOURCES} ${ARG_HEADERS})
    target_link_libraries(${target_name}
        PUBLIC terra_sdk_project_options ${ARG_PUBLIC_DEPS}
        PRIVATE ${ARG_PRIVATE_DEPS})
    target_include_directories(${target_name}
        PRIVATE
            "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src"
            "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
            ${ARG_PRIVATE_INCLUDE_DIRS})

    if(ARG_OUTPUT_NAME)
        set(_terra_sdk_output_name "${ARG_OUTPUT_NAME}")
        set_target_properties(${target_name} PROPERTIES OUTPUT_NAME "${_terra_sdk_output_name}")
    else()
        set(_terra_sdk_output_name "${target_name}")
    endif()

    terra_sdk_record_artifact(bin
        "${_terra_sdk_output_name}${CMAKE_EXECUTABLE_SUFFIX}"
        executable)

    install(TARGETS ${target_name}
        RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
endfunction()

function(terra_sdk_add_module target_name)
    set(options NO_PREFIX)
    set(one_value_args OUTPUT_NAME MODULE_DESTINATION)
    set(multi_value_args SOURCES HEADERS PUBLIC_DEPS PRIVATE_DEPS PUBLIC_INCLUDE_DIRS PRIVATE_INCLUDE_DIRS)
    cmake_parse_arguments(ARG
        "${options}"
        "${one_value_args}"
        "${multi_value_args}"
        ${ARGN})

    if(NOT ARG_SOURCES)
        message(FATAL_ERROR "terra_sdk_add_module(${target_name}) requires SOURCES")
    endif()

    if(ARG_HEADERS)
        set_source_files_properties(${ARG_HEADERS} PROPERTIES HEADER_FILE_ONLY TRUE)
    endif()

    add_library(${target_name} MODULE ${ARG_SOURCES} ${ARG_HEADERS})
    target_link_libraries(${target_name}
        PUBLIC terra_sdk_project_options ${ARG_PUBLIC_DEPS}
        PRIVATE ${ARG_PRIVATE_DEPS})
    target_include_directories(${target_name}
        PUBLIC
            "$<BUILD_INTERFACE:${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src>"
            ${ARG_PUBLIC_INCLUDE_DIRS}
        PRIVATE
            "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src"
            ${ARG_PRIVATE_INCLUDE_DIRS})

    if(ARG_NO_PREFIX)
        set(_terra_sdk_module_prefix "")
        set_target_properties(${target_name} PROPERTIES PREFIX "")
    else()
        set(_terra_sdk_module_prefix "${CMAKE_SHARED_MODULE_PREFIX}")
    endif()

    if(ARG_OUTPUT_NAME)
        set(_terra_sdk_output_name "${ARG_OUTPUT_NAME}")
        set_target_properties(${target_name} PROPERTIES OUTPUT_NAME "${_terra_sdk_output_name}")
    else()
        set(_terra_sdk_output_name "${target_name}")
    endif()

    terra_sdk_record_artifact(module
        "${_terra_sdk_module_prefix}${_terra_sdk_output_name}${CMAKE_SHARED_MODULE_SUFFIX}"
        file)

    if(ARG_MODULE_DESTINATION)
        set(_terra_sdk_module_destination "${ARG_MODULE_DESTINATION}")
    else()
        set(_terra_sdk_module_destination "${CMAKE_INSTALL_LIBDIR}")
    endif()

    install(TARGETS ${target_name}
        LIBRARY DESTINATION "${_terra_sdk_module_destination}")
endfunction()
