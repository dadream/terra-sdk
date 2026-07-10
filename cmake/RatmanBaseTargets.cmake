option(TERRA_SDK_ENABLE_RATMAN_BASE_MATH
    "Build the first additive CMake target for ratman/base vic_math." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_XML
    "Build the additive CMake target for ratman/base vic_xml." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_IMG
    "Build the additive CMake target for ratman/base vic_img." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_CURLSTREAM
    "Build the additive CMake target for ratman/base vic_curlstream." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_FETCHER
    "Build the additive CMake target for ratman/base vic_fetcher." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_QXML
    "Build the additive CMake target for ratman/base vic_qxml." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_MPI
    "Build the additive CMake target for ratman/base vic_mpi." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_GL
    "Build the additive CMake target for ratman/base vic_gl." ON)
option(TERRA_SDK_ENABLE_RATMAN_BASE_PERSISTENT
    "Build the additive CMake target for ratman/base vic_persistent." ON)

if(TERRA_SDK_ENABLE_RATMAN_BASE_MATH)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/math/math.pro")
        message(WARNING "vic_math qmake project not found; skipping vic_base_math")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_base_math")
    else()
        set(_vic_math_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/math")
        set(_vic_math_sources
            "${_vic_math_dir}/SS_amoeba.c"
            "${_vic_math_dir}/SS_memory.c"
            "${_vic_math_dir}/SS_refset.c"
            "${_vic_math_dir}/SS_tools.c")
        set(_vic_math_headers
            "${_vic_math_dir}/SS.h"
            "${_vic_math_dir}/scalar_functor.hpp"
            "${_vic_math_dir}/scalar_functor_solver.hpp"
            "${_vic_math_dir}/nelder_mead_minimizer.hpp"
            "${_vic_math_dir}/differential_evolution_minimizer.hpp"
            "${_vic_math_dir}/scatter_search_minimizer.hpp")

        terra_sdk_add_static_library(vic_base_math
            OUTPUT_NAME vic_math
            HEADER_SUBDIR vic/math
            SOURCES ${_vic_math_sources}
            HEADERS ${_vic_math_headers}
            PUBLIC_DEPS terra_sdk_sl
            PRIVATE_INCLUDE_DIRS "${_vic_math_dir}")

        add_library(vic::base_math ALIAS vic_base_math)
        message(STATUS "Configured additive CMake target vic_base_math -> libvic_math.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_FETCHER)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/fetcher/fetcher.pro")
        message(WARNING "vic_fetcher qmake project not found; skipping vic_base_fetcher")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_base_fetcher")
    elseif(NOT TARGET terra_sdk_curl)
        message(WARNING "CURL dependency not available; skipping vic_base_fetcher")
    elseif(NOT TARGET terra_sdk_qt_core)
        message(WARNING "Qt5 Core dependency not available; skipping vic_base_fetcher")
    else()
        set(_vic_fetcher_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/fetcher")
        set(_vic_fetcher_sources
            "${_vic_fetcher_dir}/fetcher.cpp"
            "${_vic_fetcher_dir}/text_fetcher.cpp")
        set(_vic_fetcher_headers
            "${_vic_fetcher_dir}/thread.hpp"
            "${_vic_fetcher_dir}/fetcher.hpp"
            "${_vic_fetcher_dir}/text_fetcher.hpp")

        terra_sdk_add_static_library(vic_base_fetcher
            OUTPUT_NAME vic_fetcher
            HEADER_SUBDIR vic/fetcher
            SOURCES ${_vic_fetcher_sources}
            HEADERS ${_vic_fetcher_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_curl terra_sdk_qt_core
            PRIVATE_INCLUDE_DIRS "${_vic_fetcher_dir}")

        add_library(vic::base_fetcher ALIAS vic_base_fetcher)
        message(STATUS "Configured additive CMake target vic_base_fetcher -> libvic_fetcher.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_QXML)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/qxml/qxml.pro")
        message(WARNING "vic_qxml qmake project not found; skipping vic_base_qxml")
    elseif(NOT TARGET terra_sdk_qt_core)
        message(WARNING "Qt5 Core dependency not available; skipping vic_base_qxml")
    elseif(NOT TARGET terra_sdk_qt_xml)
        message(WARNING "Qt5 Xml dependency not available; skipping vic_base_qxml")
    else()
        set(_vic_qxml_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/qxml")
        set(_vic_qxml_sources
            "${_vic_qxml_dir}/database.cpp")
        set(_vic_qxml_headers
            "${_vic_qxml_dir}/database.hpp")

        terra_sdk_add_static_library(vic_base_qxml
            OUTPUT_NAME vic_qxml
            HEADER_SUBDIR vic/qxml
            SOURCES ${_vic_qxml_sources}
            HEADERS ${_vic_qxml_headers}
            PUBLIC_DEPS terra_sdk_qt_core terra_sdk_qt_xml
            PRIVATE_INCLUDE_DIRS "${_vic_qxml_dir}")

        add_library(vic::base_qxml ALIAS vic_base_qxml)
        message(STATUS "Configured additive CMake target vic_base_qxml -> libvic_qxml.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_MPI)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/mpi/mpi.pro")
        message(WARNING "vic_mpi qmake project not found; skipping vic_base_mpi")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_base_mpi")
    elseif(NOT TARGET terra_sdk_mpi)
        message(WARNING "MPI dependency not available; skipping vic_base_mpi")
    else()
        set(_vic_mpi_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/mpi")
        set(_vic_mpi_sources
            "${_vic_mpi_dir}/dummy.cpp")
        set(_vic_mpi_headers
            "${_vic_mpi_dir}/mpi.hpp")

        terra_sdk_add_static_library(vic_base_mpi
            OUTPUT_NAME vic_mpi
            HEADER_SUBDIR vic/mpi
            SOURCES ${_vic_mpi_sources}
            HEADERS ${_vic_mpi_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_mpi
            PRIVATE_INCLUDE_DIRS "${_vic_mpi_dir}")

        add_library(vic::base_mpi ALIAS vic_base_mpi)
        message(STATUS "Configured additive CMake target vic_base_mpi -> libvic_mpi.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_GL)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/gl/gl.pro")
        message(WARNING "vic_gl qmake project not found; skipping vic_base_gl")
    elseif(NOT TARGET terra_sdk_opengl)
        message(WARNING "OpenGL dependency not available; skipping vic_base_gl")
    else()
        set(_vic_gl_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/gl")
        set(_vic_gl_sources
            "${_vic_gl_dir}/font.cpp")
        set(_vic_gl_headers
            "${_vic_gl_dir}/gl.hpp"
            "${_vic_gl_dir}/font.hpp"
            "${_vic_gl_dir}/arial16-csrc.c")

        terra_sdk_add_static_library(vic_base_gl
            OUTPUT_NAME vic_gl
            HEADER_SUBDIR vic/gl
            SOURCES ${_vic_gl_sources}
            HEADERS ${_vic_gl_headers}
            PUBLIC_DEPS terra_sdk_opengl
            PRIVATE_INCLUDE_DIRS "${_vic_gl_dir}")

        add_library(vic::base_gl ALIAS vic_base_gl)
        message(STATUS "Configured additive CMake target vic_base_gl -> libvic_gl.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_PERSISTENT)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/persistent/persistent.pro")
        message(WARNING "vic_persistent qmake project not found; skipping vic_base_persistent")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_base_persistent")
    elseif(NOT TARGET terra_sdk_db4)
        message(WARNING "Berkeley DB dependency not available; skipping vic_base_persistent")
    else()
        set(_vic_persistent_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/persistent")
        set(_vic_persistent_anchor_dir "${CMAKE_CURRENT_BINARY_DIR}/generated")
        set(_vic_persistent_anchor "${_vic_persistent_anchor_dir}/vic_base_persistent_anchor.cpp")
        file(MAKE_DIRECTORY "${_vic_persistent_anchor_dir}")
        file(WRITE "${_vic_persistent_anchor}" "#include <vic/persistent/map.hpp>\nvoid vic_base_persistent_anchor() {}\n")
        set(_vic_persistent_headers
            "${_vic_persistent_dir}/map.hpp")

        terra_sdk_add_static_library(vic_base_persistent
            OUTPUT_NAME vic_persistent
            HEADER_SUBDIR vic/persistent
            SOURCES "${_vic_persistent_anchor}"
            HEADERS ${_vic_persistent_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_db4
            PRIVATE_INCLUDE_DIRS "${_vic_persistent_dir}")

        add_library(vic::base_persistent ALIAS vic_base_persistent)
        message(STATUS "Configured additive CMake target vic_base_persistent -> libvic_persistent.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_XML)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/xml/xml.pro")
        message(WARNING "vic_xml qmake project not found; skipping vic_base_xml")
    else()
        set(_vic_xml_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/xml")
        set(_vic_xml_sources
            "${_vic_xml_dir}/tinyxml.cpp"
            "${_vic_xml_dir}/document.cpp"
            "${_vic_xml_dir}/tinyxmlerror.cpp"
            "${_vic_xml_dir}/tinyxmlparser.cpp")
        set(_vic_xml_headers
            "${_vic_xml_dir}/document.hpp")

        terra_sdk_add_static_library(vic_base_xml
            OUTPUT_NAME vic_xml
            HEADER_SUBDIR vic/xml
            SOURCES ${_vic_xml_sources}
            HEADERS ${_vic_xml_headers}
            PRIVATE_INCLUDE_DIRS "${_vic_xml_dir}")
        target_compile_definitions(vic_base_xml PRIVATE
            TINYXML_NAMESPACE=my_tinyxml
            TIXML_USE_STL)

        add_library(vic::base_xml ALIAS vic_base_xml)
        message(STATUS "Configured additive CMake target vic_base_xml -> libvic_xml.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_IMG)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/img/img.pro")
        message(WARNING "vic_img qmake project not found; skipping vic_base_img")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_base_img")
    else()
        set(_vic_img_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/img")
        set(_vic_img_sources
            "${_vic_img_dir}/gl_quadtree_image_processor.cpp")
        set(_vic_img_headers
            "${_vic_img_dir}/gl_image.hpp"
            "${_vic_img_dir}/gl_quadtree_image_processor.hpp")

        terra_sdk_add_static_library(vic_base_img
            OUTPUT_NAME vic_img
            HEADER_SUBDIR vic/img
            SOURCES ${_vic_img_sources}
            HEADERS ${_vic_img_headers}
            PUBLIC_DEPS terra_sdk_sl
            PRIVATE_INCLUDE_DIRS "${_vic_img_dir}")

        add_library(vic::base_img ALIAS vic_base_img)
        message(STATUS "Configured additive CMake target vic_base_img -> libvic_img.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_BASE_CURLSTREAM)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/curlstream/curlstream.pro")
        message(WARNING "vic_curlstream qmake project not found; skipping vic_base_curlstream")
    elseif(NOT TARGET terra_sdk_curl)
        message(WARNING "CURL dependency not available; skipping vic_base_curlstream")
    elseif(NOT TARGET terra_sdk_zlib)
        message(WARNING "ZLIB dependency not available; skipping vic_base_curlstream")
    else()
        set(_vic_curlstream_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/curlstream")
        set(_vic_curlstream_sources
            "${_vic_curlstream_dir}/url.cpp"
            "${_vic_curlstream_dir}/curlstream.cpp")
        set(_vic_curlstream_headers
            "${_vic_curlstream_dir}/url.hpp"
            "${_vic_curlstream_dir}/curlstream.hpp")

        terra_sdk_add_static_library(vic_base_curlstream
            OUTPUT_NAME vic_curlstream
            HEADER_SUBDIR vic/curlstream
            SOURCES ${_vic_curlstream_sources}
            HEADERS ${_vic_curlstream_headers}
            PUBLIC_DEPS terra_sdk_curl terra_sdk_zlib
            PRIVATE_INCLUDE_DIRS "${_vic_curlstream_dir}")

        add_library(vic::base_curlstream ALIAS vic_base_curlstream)
        message(STATUS "Configured additive CMake target vic_base_curlstream -> libvic_curlstream.a")
    endif()
endif()
