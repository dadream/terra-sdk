if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()
if(NOT DEFINED LINK_MANIFEST)
    message(FATAL_ERROR "LINK_MANIFEST is required")
endif()

file(GLOB_RECURSE _terra_sdk_sources LIST_DIRECTORIES FALSE
    "${SOURCE_ROOT}/sdk/include/*"
    "${SOURCE_ROOT}/sdk/src/*")

set(_terra_sdk_forbidden_includes
    "#include<vic/"
    "#include\"vic/"
    "#include<sl/"
    "#include\"sl/"
    "#include<Qt"
    "#include\"Qt"
    "#include<Q"
    "#include\"Q"
    "#include<GL"
    "#include\"GL"
    "#include<OpenGL"
    "#include\"OpenGL"
    "#include<curl"
    "#include\"curl"
    "#include<gdal"
    "#include\"gdal"
    "#include<mpi"
    "#include\"mpi"
    "#include<db"
    "#include\"db"
    "#include<httpd"
    "#include\"httpd")

foreach(_terra_sdk_source IN LISTS _terra_sdk_sources)
    file(READ "${_terra_sdk_source}" _terra_sdk_content)
    string(REGEX REPLACE "[ \t]" "" _terra_sdk_content
           "${_terra_sdk_content}")
    foreach(_terra_sdk_forbidden IN LISTS _terra_sdk_forbidden_includes)
        string(FIND "${_terra_sdk_content}" "${_terra_sdk_forbidden}"
               _terra_sdk_match)
        if(NOT _terra_sdk_match EQUAL -1)
            message(FATAL_ERROR
                "Forbidden SDK include '${_terra_sdk_forbidden}' in ${_terra_sdk_source}")
        endif()
    endforeach()
endforeach()

if(NOT EXISTS "${LINK_MANIFEST}")
    message(FATAL_ERROR "Missing SDK link manifest: ${LINK_MANIFEST}")
endif()
file(READ "${LINK_MANIFEST}" _terra_sdk_links)
string(TOLOWER "${_terra_sdk_links}" _terra_sdk_links_lower)
set(_terra_sdk_forbidden_links
    "vic_"
    "terra::sl"
    "=sl"
    "qt"
    "opengl"
    "glew"
    "curl"
    "gdal"
    "mpi"
    "db_cxx"
    "httpd")
foreach(_terra_sdk_forbidden IN LISTS _terra_sdk_forbidden_links)
    string(FIND "${_terra_sdk_links_lower}" "${_terra_sdk_forbidden}"
           _terra_sdk_match)
    if(NOT _terra_sdk_match EQUAL -1)
        message(FATAL_ERROR
            "Forbidden Terra SDK link dependency '${_terra_sdk_forbidden}': ${_terra_sdk_links}")
    endif()
endforeach()

message(STATUS "Terra SDK dependency closure passed")
