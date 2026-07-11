option(TERRA_SDK_ENABLE_RATMAN_APP_GEO_RASTER_QUADTREE_BUILDER
    "Build the CMake target for vic_geo_raster_quadtree_builder." ON)
option(TERRA_SDK_ENABLE_RATMAN_APP_CBDAM_MPI_BUILDER
    "Build the CMake target for vic_cbdam_mpi_builder." ON)
option(TERRA_SDK_ENABLE_RATMAN_APP_CBDAM_VIEWER
    "Build the CMake target for vic_cbdam_viewer." ON)
option(TERRA_SDK_ENABLE_RATMAN_APP_NAV3D
    "Build the CMake target for vic_ratman_nav3d." ON)

if(TERRA_SDK_ENABLE_RATMAN_APP_GEO_RASTER_QUADTREE_BUILDER)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/geo/geo_raster_quadtree_builder/geo_raster_quadtree_builder.cpp")
        message(WARNING "vic_geo_raster_quadtree_builder source file not found; skipping vic_app_geo_raster_quadtree_builder")
    elseif(NOT TARGET vic_core_geo_base)
        message(WARNING "vic_core_geo_base dependency not available; skipping vic_app_geo_raster_quadtree_builder")
    elseif(NOT TARGET vic_core_geo_builder)
        message(WARNING "vic_core_geo_builder dependency not available; skipping vic_app_geo_raster_quadtree_builder")
    else()
        set(_vic_geo_raster_builder_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/geo/geo_raster_quadtree_builder")

        terra_sdk_add_executable(vic_app_geo_raster_quadtree_builder
            OUTPUT_NAME vic_geo_raster_quadtree_builder
            SOURCES "${_vic_geo_raster_builder_dir}/geo_raster_quadtree_builder.cpp"
            PUBLIC_DEPS vic_core_geo_base vic_core_geo_builder
            PRIVATE_INCLUDE_DIRS "${_vic_geo_raster_builder_dir}")

        add_executable(vic::app_geo_raster_quadtree_builder ALIAS vic_app_geo_raster_quadtree_builder)
        message(STATUS "Configured CMake target vic_app_geo_raster_quadtree_builder -> vic_geo_raster_quadtree_builder")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_APP_CBDAM_VIEWER)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/cbdam/viewer/cbdam_viewer.cpp")
        message(WARNING "vic_cbdam_viewer source file not found; skipping vic_app_cbdam_viewer")
    elseif(NOT TARGET vic_core_cbdam_base)
        message(WARNING "vic_core_cbdam_base dependency not available; skipping vic_app_cbdam_viewer")
    elseif(NOT TARGET vic_base_img)
        message(WARNING "vic_base_img dependency not available; skipping vic_app_cbdam_viewer")
    elseif(NOT TARGET terra_sdk_qt_widgets)
        message(WARNING "Qt5 Widgets dependency not available; skipping vic_app_cbdam_viewer")
    elseif(NOT TARGET terra_sdk_qt_opengl)
        message(WARNING "Qt5 OpenGL dependency not available; skipping vic_app_cbdam_viewer")
    elseif(NOT TARGET terra_sdk_glu)
        message(WARNING "GLU dependency not available; skipping vic_app_cbdam_viewer")
    else()
        set(_vic_cbdam_viewer_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/cbdam/viewer")
        set(_vic_cbdam_viewer_generated_dir "${CMAKE_CURRENT_BINARY_DIR}/generated/vic_cbdam_viewer")
        set(_vic_cbdam_viewer_ui_header "${_vic_cbdam_viewer_generated_dir}/ui_cbdam_window.hpp")

        add_custom_command(
            OUTPUT "${_vic_cbdam_viewer_ui_header}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_cbdam_viewer_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_cbdam_viewer_ui_header}" "${_vic_cbdam_viewer_dir}/cbdam_window.ui"
            DEPENDS "${_vic_cbdam_viewer_dir}/cbdam_window.ui"
            VERBATIM)

        terra_sdk_add_executable(vic_app_cbdam_viewer
            OUTPUT_NAME vic_cbdam_viewer
            SOURCES
                "${_vic_cbdam_viewer_dir}/qgl_window_base.cpp"
                "${_vic_cbdam_viewer_dir}/cbdam_window.cpp"
                "${_vic_cbdam_viewer_dir}/qgl_window_cbdam.cpp"
                "${_vic_cbdam_viewer_dir}/cbdam_viewer.cpp"
                "${_vic_cbdam_viewer_dir}/glutil.c"
            HEADERS
                "${_vic_cbdam_viewer_dir}/qgl_window_base.hpp"
                "${_vic_cbdam_viewer_dir}/qgl_window_cbdam.hpp"
                "${_vic_cbdam_viewer_dir}/cbdam_window.hpp"
                "${_vic_cbdam_viewer_dir}/glutil.h"
                "${_vic_cbdam_viewer_ui_header}"
            PUBLIC_DEPS
                vic_core_cbdam_base
                vic_base_img
                terra_sdk_qt_widgets
                terra_sdk_qt_opengl
                terra_sdk_glu
            PRIVATE_INCLUDE_DIRS
                "${_vic_cbdam_viewer_dir}"
                "${_vic_cbdam_viewer_generated_dir}")
        set_target_properties(vic_app_cbdam_viewer PROPERTIES AUTOMOC ON)

        add_executable(vic::app_cbdam_viewer ALIAS vic_app_cbdam_viewer)
        message(STATUS "Configured CMake target vic_app_cbdam_viewer -> vic_cbdam_viewer")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_APP_CBDAM_MPI_BUILDER)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/cbdam/mpi_builder/cbdam_mpi_builder.cpp")
        message(WARNING "vic_cbdam_mpi_builder source file not found; skipping vic_app_cbdam_mpi_builder")
    elseif(NOT TARGET vic_core_cbdam_base)
        message(WARNING "vic_core_cbdam_base dependency not available; skipping vic_app_cbdam_mpi_builder")
    elseif(NOT TARGET vic_core_cbdam_geo)
        message(WARNING "vic_core_cbdam_geo dependency not available; skipping vic_app_cbdam_mpi_builder")
    elseif(NOT TARGET vic_base_mpi)
        message(WARNING "vic_base_mpi dependency not available; skipping vic_app_cbdam_mpi_builder")
    elseif(NOT TARGET terra_sdk_shp)
        message(WARNING "SHP dependency not available; skipping vic_app_cbdam_mpi_builder")
    else()
        set(_vic_cbdam_mpi_builder_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/cbdam/mpi_builder")

        terra_sdk_add_executable(vic_app_cbdam_mpi_builder
            OUTPUT_NAME vic_cbdam_mpi_builder
            SOURCES "${_vic_cbdam_mpi_builder_dir}/cbdam_mpi_builder.cpp"
            PUBLIC_DEPS
                vic_core_cbdam_base
                vic_core_cbdam_geo
                vic_base_mpi
                terra_sdk_shp
            PRIVATE_INCLUDE_DIRS "${_vic_cbdam_mpi_builder_dir}")

        add_executable(vic::app_cbdam_mpi_builder ALIAS vic_app_cbdam_mpi_builder)
        message(STATUS "Configured CMake target vic_app_cbdam_mpi_builder -> vic_cbdam_mpi_builder")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_APP_NAV3D)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/nav3d/main.cpp")
        message(WARNING "vic_ratman_nav3d source file not found; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET vic_core_ratman)
        message(WARNING "vic_core_ratman dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET vic_core_cbdam_base)
        message(WARNING "vic_core_cbdam_base dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET vic_base_curlstream)
        message(WARNING "vic_base_curlstream dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_qt_network)
        message(WARNING "Qt5 Network dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_qt_xml)
        message(WARNING "Qt5 Xml dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_qt_widgets)
        message(WARNING "Qt5 Widgets dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_qt_opengl)
        message(WARNING "Qt5 OpenGL dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_qt_printsupport)
        message(WARNING "Qt5 PrintSupport dependency not available; skipping vic_app_ratman_nav3d")
    elseif(NOT TARGET terra_sdk_glu)
        message(WARNING "GLU dependency not available; skipping vic_app_ratman_nav3d")
    else()
        set(_vic_nav3d_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/apps/nav3d")
        set(_vic_nav3d_generated_dir "${CMAKE_CURRENT_BINARY_DIR}/generated/vic_ratman_nav3d")
        set(_vic_nav3d_ui_headers
            "${_vic_nav3d_generated_dir}/ui_meteo_dialog.hpp"
            "${_vic_nav3d_generated_dir}/ui_mainwindow.hpp"
            "${_vic_nav3d_generated_dir}/ui_parametersdialog.hpp"
            "${_vic_nav3d_generated_dir}/ui_search_result.hpp"
            "${_vic_nav3d_generated_dir}/ui_bookmarks.hpp"
            "${_vic_nav3d_generated_dir}/ui_about.hpp")

        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_meteo_dialog.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_meteo_dialog.hpp" "${_vic_nav3d_dir}/meteo_dialog.ui"
            DEPENDS "${_vic_nav3d_dir}/meteo_dialog.ui"
            VERBATIM)
        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_mainwindow.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_mainwindow.hpp" "${_vic_nav3d_dir}/mainwindow.ui"
            DEPENDS "${_vic_nav3d_dir}/mainwindow.ui"
            VERBATIM)
        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_parametersdialog.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_parametersdialog.hpp" "${_vic_nav3d_dir}/parametersdialog.ui"
            DEPENDS "${_vic_nav3d_dir}/parametersdialog.ui"
            VERBATIM)
        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_search_result.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_search_result.hpp" "${_vic_nav3d_dir}/search_result.ui"
            DEPENDS "${_vic_nav3d_dir}/search_result.ui"
            VERBATIM)
        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_bookmarks.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_bookmarks.hpp" "${_vic_nav3d_dir}/bookmarks.ui"
            DEPENDS "${_vic_nav3d_dir}/bookmarks.ui"
            VERBATIM)
        add_custom_command(
            OUTPUT "${_vic_nav3d_generated_dir}/ui_about.hpp"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_vic_nav3d_generated_dir}"
            COMMAND Qt5::uic -o "${_vic_nav3d_generated_dir}/ui_about.hpp" "${_vic_nav3d_dir}/about.ui"
            DEPENDS "${_vic_nav3d_dir}/about.ui"
            VERBATIM)

        qt5_add_resources(_vic_nav3d_resources
            "${_vic_nav3d_dir}/graphics/resources.qrc")

        terra_sdk_add_executable(vic_app_ratman_nav3d
            OUTPUT_NAME vic_ratman_nav3d
            SOURCES
                "${_vic_nav3d_dir}/config.cpp"
                "${_vic_nav3d_dir}/base_layers_button_group.cpp"
                "${_vic_nav3d_dir}/overlay_layers_button_group.cpp"
                "${_vic_nav3d_dir}/layer_check_box.cpp"
                "${_vic_nav3d_dir}/qgl_nav3d_scene_view.cpp"
                "${_vic_nav3d_dir}/appwindow.cpp"
                "${_vic_nav3d_dir}/xml_config_parser.cpp"
                "${_vic_nav3d_dir}/main.cpp"
                "${_vic_nav3d_dir}/meteo_dialog.cpp"
                "${_vic_nav3d_dir}/about_dialog.cpp"
                "${_vic_nav3d_dir}/parameters_dialog.cpp"
                "${_vic_nav3d_dir}/search_result_dialog.cpp"
                "${_vic_nav3d_dir}/search_result_item.cpp"
                "${_vic_nav3d_dir}/bookmarks_dialog.cpp"
                "${_vic_nav3d_dir}/bookmark_item.cpp"
                ${_vic_nav3d_resources}
            HEADERS
                "${_vic_nav3d_dir}/version.hpp"
                "${_vic_nav3d_dir}/config.hpp"
                "${_vic_nav3d_dir}/base_layers_button_group.hpp"
                "${_vic_nav3d_dir}/overlay_layers_button_group.hpp"
                "${_vic_nav3d_dir}/layer_check_box.hpp"
                "${_vic_nav3d_dir}/qgl_nav3d_scene_view.hpp"
                "${_vic_nav3d_dir}/appwindow.hpp"
                "${_vic_nav3d_dir}/xml_config_parser.hpp"
                "${_vic_nav3d_dir}/meteo_dialog.hpp"
                "${_vic_nav3d_dir}/about_dialog.hpp"
                "${_vic_nav3d_dir}/parameters_dialog.hpp"
                "${_vic_nav3d_dir}/search_result_dialog.hpp"
                "${_vic_nav3d_dir}/search_result_item.hpp"
                "${_vic_nav3d_dir}/bookmarks_dialog.hpp"
                "${_vic_nav3d_dir}/bookmark_item.hpp"
                ${_vic_nav3d_ui_headers}
            PUBLIC_DEPS
                vic_core_ratman
                vic_core_cbdam_base
                vic_base_curlstream
                terra_sdk_qt_network
                terra_sdk_qt_xml
                terra_sdk_qt_widgets
                terra_sdk_qt_opengl
                terra_sdk_qt_printsupport
                terra_sdk_glu
            PRIVATE_INCLUDE_DIRS
                "${_vic_nav3d_dir}"
                "${_vic_nav3d_generated_dir}")
        set_target_properties(vic_app_ratman_nav3d PROPERTIES AUTOMOC ON)

        add_executable(vic::app_ratman_nav3d ALIAS vic_app_ratman_nav3d)
        message(STATUS "Configured CMake target vic_app_ratman_nav3d -> vic_ratman_nav3d")
    endif()
endif()
