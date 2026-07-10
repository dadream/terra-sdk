include(CMakePrintHelpers)

find_package(Threads QUIET)
find_package(ZLIB QUIET)
find_package(CURL QUIET)
find_package(OpenGL QUIET)
find_package(MPI COMPONENTS C CXX QUIET)
find_package(GLEW QUIET)
find_package(GDAL QUIET)
find_package(Qt5 COMPONENTS Core Widgets OpenGL Xml Network PrintSupport QUIET)

find_program(TERRA_SDK_APXS_EXECUTABLE NAMES apxs apxs2)
if(TERRA_SDK_APXS_EXECUTABLE)
    execute_process(
        COMMAND "${TERRA_SDK_APXS_EXECUTABLE}" -q INCLUDEDIR
        OUTPUT_VARIABLE TERRA_SDK_APXS_INCLUDEDIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
    execute_process(
        COMMAND "${TERRA_SDK_APXS_EXECUTABLE}" -q LIBEXECDIR
        OUTPUT_VARIABLE TERRA_SDK_APXS_LIBEXECDIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
    execute_process(
        COMMAND "${TERRA_SDK_APXS_EXECUTABLE}" -q APR_INCLUDEDIR
        OUTPUT_VARIABLE TERRA_SDK_APXS_APR_INCLUDEDIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
    execute_process(
        COMMAND "${TERRA_SDK_APXS_EXECUTABLE}" -q APU_INCLUDEDIR
        OUTPUT_VARIABLE TERRA_SDK_APXS_APU_INCLUDEDIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
endif()
find_path(TERRA_SDK_APACHE_INCLUDE_DIR NAMES httpd.h
    HINTS
        "${TERRA_SDK_APXS_INCLUDEDIR}"
    PATH_SUFFIXES
        apache2
        httpd)
find_path(TERRA_SDK_BERKELEY_DB_INCLUDE_DIR NAMES db.h)
find_library(TERRA_SDK_BERKELEY_DB_LIBRARY NAMES db db-5.3 db-5.1 db-4.8)
find_library(TERRA_SDK_BERKELEY_DB_CXX_LIBRARY NAMES db_cxx db_cxx-5.3 db_cxx-5.1 db_cxx-4.8)
find_path(TERRA_SDK_SHP_INCLUDE_DIR NAMES shapefil.h libshp/shapefil.h)
find_library(TERRA_SDK_SHP_LIBRARY NAMES shp)
if(NOT TARGET sl)
    find_path(TERRA_SDK_SL_INCLUDE_DIR NAMES sl/any.hpp
        HINTS
            "${TERRA_SDK_SPACELIB_SOURCE_DIR}/src"
            "${CMAKE_INSTALL_PREFIX}/include"
            "$ENV{SL_DIR}/include"
            "$ENV{PREFIX}/include"
            /usr/include)
    find_library(TERRA_SDK_SL_LIBRARY NAMES sl libsl.a
        HINTS
            "${CMAKE_INSTALL_PREFIX}/lib64"
            "${CMAKE_INSTALL_PREFIX}/lib"
            "$ENV{SL_LIB_DIR}"
            "$ENV{SL_DIR}/lib64"
            "$ENV{SL_DIR}/lib"
            "$ENV{PREFIX}/lib64"
            "$ENV{PREFIX}/lib")
endif()

function(terra_sdk_print_dependency name found detail)
    if(${found})
        message(STATUS "${name}: found ${detail}")
    else()
        message(STATUS "${name}: not found")
    endif()
endfunction()

terra_sdk_print_dependency("Threads" Threads_FOUND "")
terra_sdk_print_dependency("ZLIB" ZLIB_FOUND "${ZLIB_VERSION}")
terra_sdk_print_dependency("CURL" CURL_FOUND "${CURL_VERSION_STRING}")
terra_sdk_print_dependency("OpenGL" OpenGL_FOUND "")
terra_sdk_print_dependency("MPI C" MPI_C_FOUND "")
terra_sdk_print_dependency("MPI CXX" MPI_CXX_FOUND "")
terra_sdk_print_dependency("GLEW" GLEW_FOUND "")
terra_sdk_print_dependency("GDAL" GDAL_FOUND "${GDAL_VERSION}")
terra_sdk_print_dependency("Qt5 Core" Qt5Core_FOUND "")
terra_sdk_print_dependency("Qt5 Widgets" Qt5Widgets_FOUND "")
terra_sdk_print_dependency("Qt5 OpenGL" Qt5OpenGL_FOUND "")
terra_sdk_print_dependency("Qt5 Xml" Qt5Xml_FOUND "")
terra_sdk_print_dependency("Qt5 Network" Qt5Network_FOUND "")
terra_sdk_print_dependency("Qt5 PrintSupport" Qt5PrintSupport_FOUND "")

if(TERRA_SDK_APXS_EXECUTABLE)
    message(STATUS "APXS: found ${TERRA_SDK_APXS_EXECUTABLE}")
    message(STATUS "APXS include dir: ${TERRA_SDK_APXS_INCLUDEDIR}")
    message(STATUS "APXS APR include dir: ${TERRA_SDK_APXS_APR_INCLUDEDIR}")
    message(STATUS "APXS APU include dir: ${TERRA_SDK_APXS_APU_INCLUDEDIR}")
    message(STATUS "APXS module dir: ${TERRA_SDK_APXS_LIBEXECDIR}")
else()
    message(STATUS "APXS: not found")
endif()

if(TERRA_SDK_APACHE_INCLUDE_DIR)
    message(STATUS "Apache headers: found ${TERRA_SDK_APACHE_INCLUDE_DIR}")
else()
    message(STATUS "Apache headers: not found")
endif()

if(TERRA_SDK_BERKELEY_DB_INCLUDE_DIR AND TERRA_SDK_BERKELEY_DB_LIBRARY)
    message(STATUS "Berkeley DB: found ${TERRA_SDK_BERKELEY_DB_INCLUDE_DIR};${TERRA_SDK_BERKELEY_DB_LIBRARY};${TERRA_SDK_BERKELEY_DB_CXX_LIBRARY}")
else()
    message(STATUS "Berkeley DB: not found")
endif()

if(TERRA_SDK_SHP_LIBRARY)
    message(STATUS "SHP: found ${TERRA_SDK_SHP_INCLUDE_DIR};${TERRA_SDK_SHP_LIBRARY}")
else()
    message(STATUS "SHP: not found")
endif()

if(TARGET sl)
    message(STATUS "SL: using in-tree target sl")
elseif(TERRA_SDK_SL_INCLUDE_DIR)
    message(STATUS "SL headers: found ${TERRA_SDK_SL_INCLUDE_DIR}")
else()
    message(STATUS "SL headers: not found")
endif()

if(TARGET sl)
    message(STATUS "SL library: using in-tree target sl")
elseif(TERRA_SDK_SL_LIBRARY)
    message(STATUS "SL library: found ${TERRA_SDK_SL_LIBRARY}")
else()
    message(STATUS "SL library: not found")
endif()

if(TARGET sl)
    add_library(terra_sdk_sl INTERFACE)
    target_link_libraries(terra_sdk_sl INTERFACE sl)
    target_include_directories(terra_sdk_sl INTERFACE
        "$<BUILD_INTERFACE:${TERRA_SDK_SPACELIB_SOURCE_DIR}/src>"
        "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
elseif(TERRA_SDK_SL_INCLUDE_DIR)
    add_library(terra_sdk_sl INTERFACE)
    target_include_directories(terra_sdk_sl INTERFACE "${TERRA_SDK_SL_INCLUDE_DIR}")
    if(TERRA_SDK_SL_LIBRARY)
        target_link_libraries(terra_sdk_sl INTERFACE "${TERRA_SDK_SL_LIBRARY}")
    endif()
endif()

if(TERRA_SDK_APXS_EXECUTABLE OR TERRA_SDK_APACHE_INCLUDE_DIR)
    add_library(terra_sdk_apxs INTERFACE)
    if(TERRA_SDK_APACHE_INCLUDE_DIR)
        target_include_directories(terra_sdk_apxs INTERFACE "${TERRA_SDK_APACHE_INCLUDE_DIR}")
    endif()
    if(TERRA_SDK_APXS_APR_INCLUDEDIR)
        target_include_directories(terra_sdk_apxs INTERFACE "${TERRA_SDK_APXS_APR_INCLUDEDIR}")
    endif()
    if(TERRA_SDK_APXS_APU_INCLUDEDIR)
        target_include_directories(terra_sdk_apxs INTERFACE "${TERRA_SDK_APXS_APU_INCLUDEDIR}")
    endif()
    if(TERRA_SDK_APXS_EXECUTABLE)
        target_compile_definitions(terra_sdk_apxs INTERFACE
            TERRA_SDK_APXS_EXECUTABLE="${TERRA_SDK_APXS_EXECUTABLE}")
    endif()
endif()

if(CURL_FOUND)
    add_library(terra_sdk_curl INTERFACE)
    if(CURL_LIBRARIES)
        target_link_libraries(terra_sdk_curl INTERFACE ${CURL_LIBRARIES})
    elseif(TARGET CURL::libcurl)
        target_link_libraries(terra_sdk_curl INTERFACE CURL::libcurl)
    endif()
    if(CURL_INCLUDE_DIRS AND NOT CURL_INCLUDE_DIRS STREQUAL "/usr/include")
        target_include_directories(terra_sdk_curl INTERFACE ${CURL_INCLUDE_DIRS})
    endif()
endif()

if(ZLIB_FOUND)
    add_library(terra_sdk_zlib INTERFACE)
    if(ZLIB_LIBRARIES)
        target_link_libraries(terra_sdk_zlib INTERFACE ${ZLIB_LIBRARIES})
    elseif(TARGET ZLIB::ZLIB)
        target_link_libraries(terra_sdk_zlib INTERFACE ZLIB::ZLIB)
    endif()
    if(ZLIB_INCLUDE_DIRS AND NOT ZLIB_INCLUDE_DIRS STREQUAL "/usr/include")
        target_include_directories(terra_sdk_zlib INTERFACE ${ZLIB_INCLUDE_DIRS})
    endif()
endif()

if(OpenGL_FOUND)
    add_library(terra_sdk_opengl INTERFACE)
    if(OPENGL_LIBRARIES)
        target_link_libraries(terra_sdk_opengl INTERFACE ${OPENGL_LIBRARIES})
    elseif(TARGET OpenGL::GL)
        target_link_libraries(terra_sdk_opengl INTERFACE OpenGL::GL)
    endif()
    if(OPENGL_INCLUDE_DIR AND NOT OPENGL_INCLUDE_DIR STREQUAL "/usr/include")
        target_include_directories(terra_sdk_opengl INTERFACE "${OPENGL_INCLUDE_DIR}")
    endif()
endif()

if(OpenGL_FOUND AND (TARGET OpenGL::GLU OR OPENGL_glu_LIBRARY))
    add_library(terra_sdk_glu INTERFACE)
    if(TARGET OpenGL::GLU)
        target_link_libraries(terra_sdk_glu INTERFACE OpenGL::GLU)
    elseif(OPENGL_glu_LIBRARY)
        target_link_libraries(terra_sdk_glu INTERFACE "${OPENGL_glu_LIBRARY}")
    endif()
endif()

if(GLEW_FOUND)
    add_library(terra_sdk_glew INTERFACE)
    if(TARGET GLEW::GLEW)
        target_link_libraries(terra_sdk_glew INTERFACE GLEW::GLEW)
    else()
        if(GLEW_INCLUDE_DIRS)
            target_include_directories(terra_sdk_glew INTERFACE ${GLEW_INCLUDE_DIRS})
        elseif(GLEW_INCLUDE_DIR)
            target_include_directories(terra_sdk_glew INTERFACE "${GLEW_INCLUDE_DIR}")
        endif()
        if(GLEW_LIBRARIES)
            target_link_libraries(terra_sdk_glew INTERFACE ${GLEW_LIBRARIES})
        elseif(GLEW_LIBRARY)
            target_link_libraries(terra_sdk_glew INTERFACE "${GLEW_LIBRARY}")
        endif()
    endif()
endif()

if(MPI_CXX_FOUND)
    add_library(terra_sdk_mpi INTERFACE)
    if(TARGET MPI::MPI_CXX)
        target_link_libraries(terra_sdk_mpi INTERFACE MPI::MPI_CXX)
    else()
        target_include_directories(terra_sdk_mpi INTERFACE ${MPI_CXX_INCLUDE_DIRS})
        target_compile_options(terra_sdk_mpi INTERFACE ${MPI_CXX_COMPILE_OPTIONS})
        target_compile_definitions(terra_sdk_mpi INTERFACE ${MPI_CXX_COMPILE_DEFINITIONS})
        target_link_libraries(terra_sdk_mpi INTERFACE ${MPI_CXX_LIBRARIES})
    endif()
endif()

if(Qt5Core_FOUND)
    add_library(terra_sdk_qt_core INTERFACE)
    target_link_libraries(terra_sdk_qt_core INTERFACE Qt5::Core)
endif()

if(Qt5Widgets_FOUND)
    add_library(terra_sdk_qt_widgets INTERFACE)
    target_link_libraries(terra_sdk_qt_widgets INTERFACE Qt5::Widgets)
endif()

if(Qt5OpenGL_FOUND)
    add_library(terra_sdk_qt_opengl INTERFACE)
    target_link_libraries(terra_sdk_qt_opengl INTERFACE Qt5::OpenGL)
endif()

if(Qt5Xml_FOUND)
    add_library(terra_sdk_qt_xml INTERFACE)
    target_link_libraries(terra_sdk_qt_xml INTERFACE Qt5::Xml)
endif()

if(Qt5Network_FOUND)
    add_library(terra_sdk_qt_network INTERFACE)
    target_link_libraries(terra_sdk_qt_network INTERFACE Qt5::Network)
endif()

if(Qt5PrintSupport_FOUND)
    add_library(terra_sdk_qt_printsupport INTERFACE)
    target_link_libraries(terra_sdk_qt_printsupport INTERFACE Qt5::PrintSupport)
endif()

if(TERRA_SDK_BERKELEY_DB_INCLUDE_DIR AND TERRA_SDK_BERKELEY_DB_LIBRARY)
    add_library(terra_sdk_db4 INTERFACE)
    target_include_directories(terra_sdk_db4 INTERFACE "${TERRA_SDK_BERKELEY_DB_INCLUDE_DIR}")
    target_link_libraries(terra_sdk_db4 INTERFACE "${TERRA_SDK_BERKELEY_DB_LIBRARY}")
    if(TERRA_SDK_BERKELEY_DB_CXX_LIBRARY)
        target_link_libraries(terra_sdk_db4 INTERFACE "${TERRA_SDK_BERKELEY_DB_CXX_LIBRARY}")
    endif()
endif()

if(GDAL_FOUND)
    add_library(terra_sdk_gdal INTERFACE)
    if(TARGET GDAL::GDAL)
        target_link_libraries(terra_sdk_gdal INTERFACE GDAL::GDAL)
    else()
        if(GDAL_INCLUDE_DIRS)
            target_include_directories(terra_sdk_gdal INTERFACE ${GDAL_INCLUDE_DIRS})
        elseif(GDAL_INCLUDE_DIR)
            target_include_directories(terra_sdk_gdal INTERFACE "${GDAL_INCLUDE_DIR}")
        endif()
        if(GDAL_LIBRARIES)
            target_link_libraries(terra_sdk_gdal INTERFACE ${GDAL_LIBRARIES})
        elseif(GDAL_LIBRARY)
            target_link_libraries(terra_sdk_gdal INTERFACE "${GDAL_LIBRARY}")
        endif()
    endif()
endif()

if(TERRA_SDK_SHP_LIBRARY)
    add_library(terra_sdk_shp INTERFACE)
    if(TERRA_SDK_SHP_INCLUDE_DIR AND NOT TERRA_SDK_SHP_INCLUDE_DIR STREQUAL "/usr/include")
        target_include_directories(terra_sdk_shp INTERFACE "${TERRA_SDK_SHP_INCLUDE_DIR}")
    endif()
    target_link_libraries(terra_sdk_shp INTERFACE "${TERRA_SDK_SHP_LIBRARY}")
endif()
