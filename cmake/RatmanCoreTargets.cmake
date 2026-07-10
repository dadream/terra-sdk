option(TERRA_SDK_ENABLE_RATMAN_CORE_VFS
    "Build the additive CMake target for ratman/src vic_vfs." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_BASE
    "Build the additive CMake target for ratman/src vic_geo_base." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_SRS
    "Build the additive CMake target for ratman/src vic_geo_srs." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_BUILDER
    "Build the additive CMake target for ratman/src vic_geo_builder." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_CBDAM_GEO
    "Build the additive CMake target for ratman/src vic_cbdam_geo." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_CBDAM_BASE
    "Build the additive CMake target for ratman/src vic_cbdam_base." ON)
option(TERRA_SDK_ENABLE_RATMAN_CORE_RATMAN
    "Build the additive CMake target for ratman/src vic_ratman." ON)

set(_terra_sdk_ratman_public_include_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src")

if(TERRA_SDK_ENABLE_RATMAN_CORE_VFS)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/vfs/vfs.pro")
        message(WARNING "vic_vfs qmake project not found; skipping vic_core_vfs")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_vfs")
    elseif(NOT TARGET terra_sdk_curl)
        message(WARNING "CURL dependency not available; skipping vic_core_vfs")
    elseif(NOT TARGET terra_sdk_zlib)
        message(WARNING "ZLIB dependency not available; skipping vic_core_vfs")
    elseif(NOT TARGET terra_sdk_db4)
        message(WARNING "Berkeley DB dependency not available; skipping vic_core_vfs")
    elseif(NOT TARGET terra_sdk_qt_core)
        message(WARNING "Qt5 Core dependency not available; skipping vic_core_vfs")
    else()
        set(_vic_vfs_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/vfs")
        set(_vic_vfs_sources
            "${_vic_vfs_dir}/db_repository.cpp"
            "${_vic_vfs_dir}/repository_using_db.cpp"
            "${_vic_vfs_dir}/virtual_file_system_local.cpp"
            "${_vic_vfs_dir}/virtual_file_system_network.cpp")
        set(_vic_vfs_headers
            "${_vic_vfs_dir}/virtual_file_system.hpp"
            "${_vic_vfs_dir}/virtual_file_system_local.hpp"
            "${_vic_vfs_dir}/virtual_file_system_network.hpp"
            "${_vic_vfs_dir}/repository.hpp")

        terra_sdk_add_static_library(vic_core_vfs
            OUTPUT_NAME vic_vfs
            HEADER_SUBDIR vic/vfs
            SOURCES ${_vic_vfs_sources}
            HEADERS ${_vic_vfs_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_curl terra_sdk_zlib terra_sdk_db4 terra_sdk_qt_core
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_vfs_dir}")

        add_library(vic::core_vfs ALIAS vic_core_vfs)
        message(STATUS "Configured additive CMake target vic_core_vfs -> libvic_vfs.a")
    endif()
endif()

function(terra_sdk_configure_vic_core_cbdam_base)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/cbdam/base/base.pro")
        message(WARNING "vic_cbdam_base qmake project not found; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_curl)
        message(WARNING "CURL dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_zlib)
        message(WARNING "ZLIB dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_gdal)
        message(WARNING "GDAL dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_opengl)
        message(WARNING "OpenGL dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_glew)
        message(WARNING "GLEW dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_qt_core)
        message(WARNING "Qt5 Core dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET terra_sdk_qt_opengl)
        message(WARNING "Qt5 OpenGL dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_base_img)
        message(WARNING "vic_base_img dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_base_xml)
        message(WARNING "vic_base_xml dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_base_curlstream)
        message(WARNING "vic_base_curlstream dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_base_persistent)
        message(WARNING "vic_base_persistent dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_core_vfs)
        message(WARNING "vic_core_vfs dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_core_geo_base)
        message(WARNING "vic_core_geo_base dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_core_geo_srs)
        message(WARNING "vic_core_geo_srs dependency not available; skipping vic_core_cbdam_base")
    elseif(NOT TARGET vic_core_cbdam_geo)
        message(WARNING "vic_core_cbdam_geo dependency not available; skipping vic_core_cbdam_base")
    else()
        set(_vic_cbdam_base_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/cbdam/base")
        set(_vic_cbdam_base_sources
            "${_vic_cbdam_base_dir}/img_operations.cpp"
            "${_vic_cbdam_base_dir}/building_hierarchy.cpp"
            "${_vic_cbdam_base_dir}/grid_diamond_graph_incore.cpp"
            "${_vic_cbdam_base_dir}/building_renderer.cpp"
            "${_vic_cbdam_base_dir}/grid_point.cpp"
            "${_vic_cbdam_base_dir}/camera.cpp"
            "${_vic_cbdam_base_dir}/grid_texture_quadtree.cpp"
            "${_vic_cbdam_base_dir}/camera_controller_base.cpp"
            "${_vic_cbdam_base_dir}/opengl_cached_data_renderer.cpp"
            "${_vic_cbdam_base_dir}/camera_controller_flight.cpp"
            "${_vic_cbdam_base_dir}/progress_bar.cpp"
            "${_vic_cbdam_base_dir}/camera_controller_vtrackball.cpp"
            "${_vic_cbdam_base_dir}/raw_image.cpp"
            "${_vic_cbdam_base_dir}/cbdam_diamond_fetcher.cpp"
            "${_vic_cbdam_base_dir}/repository_parameters.cpp"
            "${_vic_cbdam_base_dir}/compressed_rgba32_image.cpp"
            "${_vic_cbdam_base_dir}/terrain_model.cpp"
            "${_vic_cbdam_base_dir}/delta_height_codec.cpp"
            "${_vic_cbdam_base_dir}/terrain_model_renderer.cpp"
            "${_vic_cbdam_base_dir}/diamond_graph_builder.cpp"
            "${_vic_cbdam_base_dir}/terrain_scene_compiler.cpp"
            "${_vic_cbdam_base_dir}/diamond_operator.cpp"
            "${_vic_cbdam_base_dir}/dummy_geoimage_quad_fetcher.cpp"
            "${_vic_cbdam_base_dir}/texture_layer.cpp"
            "${_vic_cbdam_base_dir}/geodata_fetcher.cpp"
            "${_vic_cbdam_base_dir}/texture_manager.cpp"
            "${_vic_cbdam_base_dir}/geoimage_quad_fetcher.cpp"
            "${_vic_cbdam_base_dir}/texture_refiner.cpp"
            "${_vic_cbdam_base_dir}/geometry_layer.cpp"
            "${_vic_cbdam_base_dir}/victms_geoimage_quad_fetcher.cpp"
            "${_vic_cbdam_base_dir}/wms_geoimage_quad_fetcher.cpp"
            "${_vic_cbdam_base_dir}/loaded_geoimage_quad_fetcher.cpp"
            "${_vic_cbdam_base_dir}/background_thread_unix.cpp")
        set(_vic_cbdam_base_headers
            "${_vic_cbdam_base_dir}/imgfilter.hpp"
            "${_vic_cbdam_base_dir}/imgfilter_bell.hpp"
            "${_vic_cbdam_base_dir}/img_operations.hpp"
            "${_vic_cbdam_base_dir}/builder.hpp"
            "${_vic_cbdam_base_dir}/geometry_layer.hpp"
            "${_vic_cbdam_base_dir}/building_hierarchy.hpp"
            "${_vic_cbdam_base_dir}/grid_diamond.hpp"
            "${_vic_cbdam_base_dir}/building_renderer.hpp"
            "${_vic_cbdam_base_dir}/grid_diamond_graph.hpp"
            "${_vic_cbdam_base_dir}/byte_array_accessor.hpp"
            "${_vic_cbdam_base_dir}/grid_diamond_graph_incore.hpp"
            "${_vic_cbdam_base_dir}/camera.hpp"
            "${_vic_cbdam_base_dir}/grid_diamond_graph_off_core.hpp"
            "${_vic_cbdam_base_dir}/camera_controller_base.hpp"
            "${_vic_cbdam_base_dir}/grid_diamond_state.hpp"
            "${_vic_cbdam_base_dir}/camera_controller_flight.hpp"
            "${_vic_cbdam_base_dir}/grid_point.hpp"
            "${_vic_cbdam_base_dir}/camera_controller_vtrackball.hpp"
            "${_vic_cbdam_base_dir}/grid_texture_quadtree.hpp"
            "${_vic_cbdam_base_dir}/cbdam_diamond_fetcher.hpp"
            "${_vic_cbdam_base_dir}/null_compressor.hpp"
            "${_vic_cbdam_base_dir}/opengl_cached_data_renderer.hpp"
            "${_vic_cbdam_base_dir}/color_rgb.hpp"
            "${_vic_cbdam_base_dir}/priority_diamond.hpp"
            "${_vic_cbdam_base_dir}/compressed_rgba32_image.hpp"
            "${_vic_cbdam_base_dir}/progress_bar.hpp"
            "${_vic_cbdam_base_dir}/config.hpp"
            "${_vic_cbdam_base_dir}/raw_image.hpp"
            "${_vic_cbdam_base_dir}/coordinate_transform.hpp"
            "${_vic_cbdam_base_dir}/ray.hpp"
            "${_vic_cbdam_base_dir}/delta_codec.hpp"
            "${_vic_cbdam_base_dir}/reference_counted_cache.hpp"
            "${_vic_cbdam_base_dir}/delta_height_codec.hpp"
            "${_vic_cbdam_base_dir}/repository_parameters.hpp"
            "${_vic_cbdam_base_dir}/diamond_graph_builder.hpp"
            "${_vic_cbdam_base_dir}/terrain_model.hpp"
            "${_vic_cbdam_base_dir}/diamond_operator.hpp"
            "${_vic_cbdam_base_dir}/terrain_model_renderer.hpp"
            "${_vic_cbdam_base_dir}/diamond_patch_accessor.hpp"
            "${_vic_cbdam_base_dir}/terrain_scene_compiler.hpp"
            "${_vic_cbdam_base_dir}/diamond_repository.hpp"
            "${_vic_cbdam_base_dir}/diamond_repository_procedural.hpp"
            "${_vic_cbdam_base_dir}/texture_layer.hpp"
            "${_vic_cbdam_base_dir}/diamond_repository_storage.hpp"
            "${_vic_cbdam_base_dir}/texture_manager.hpp"
            "${_vic_cbdam_base_dir}/diamond_vertices.hpp"
            "${_vic_cbdam_base_dir}/texture_refiner.hpp"
            "${_vic_cbdam_base_dir}/dummy_geoimage_quad_fetcher.hpp"
            "${_vic_cbdam_base_dir}/background_thread.hpp"
            "${_vic_cbdam_base_dir}/geodata_fetcher.hpp"
            "${_vic_cbdam_base_dir}/triangulate.hpp"
            "${_vic_cbdam_base_dir}/geoimage_quad_fetcher.hpp"
            "${_vic_cbdam_base_dir}/victms_geoimage_quad_fetcher.hpp"
            "${_vic_cbdam_base_dir}/wms_geoimage_quad_fetcher.hpp"
            "${_vic_cbdam_base_dir}/loaded_geoimage_quad_fetcher.hpp")
        set(_vic_cbdam_base_public_deps
            terra_sdk_sl
            terra_sdk_curl
            terra_sdk_zlib
            terra_sdk_gdal
            terra_sdk_opengl
            terra_sdk_glew
            terra_sdk_qt_core
            terra_sdk_qt_opengl
            vic_base_img
            vic_base_xml
            vic_base_curlstream
            vic_base_persistent
            vic_core_vfs
            vic_core_geo_base
            vic_core_geo_srs
            vic_core_cbdam_geo)
        if(TARGET terra_sdk_shp)
            list(APPEND _vic_cbdam_base_public_deps terra_sdk_shp)
        endif()

        terra_sdk_add_static_library(vic_core_cbdam_base
            OUTPUT_NAME vic_cbdam_base
            HEADER_SUBDIR vic/cbdam/base
            SOURCES ${_vic_cbdam_base_sources}
            HEADERS ${_vic_cbdam_base_headers}
            PUBLIC_DEPS ${_vic_cbdam_base_public_deps}
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_cbdam_base_dir}")

        add_library(vic::core_cbdam_base ALIAS vic_core_cbdam_base)
        message(STATUS "Configured additive CMake target vic_core_cbdam_base -> libvic_cbdam_base.a")
    endif()
endfunction()

if(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_BUILDER)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/builder/builder.pro")
        message(WARNING "vic_geo_builder qmake project not found; skipping vic_core_geo_builder")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_geo_builder")
    elseif(NOT TARGET terra_sdk_gdal)
        message(WARNING "GDAL dependency not available; skipping vic_core_geo_builder")
    elseif(NOT TARGET vic_base_mpi)
        message(WARNING "vic_base_mpi dependency not available; skipping vic_core_geo_builder")
    else()
        set(_vic_geo_builder_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/builder")
        set(_vic_geo_builder_sources
            "${_vic_geo_builder_dir}/geo_utility.cpp"
            "${_vic_geo_builder_dir}/quad_accessor.cpp"
            "${_vic_geo_builder_dir}/quad_processor.cpp"
            "${_vic_geo_builder_dir}/geo_transform.cpp"
            "${_vic_geo_builder_dir}/color_remap_transform.cpp"
            "${_vic_geo_builder_dir}/quad_warper.cpp"
            "${_vic_geo_builder_dir}/quad_builder.cpp"
            "${_vic_geo_builder_dir}/mpi_quad_builder.cpp")
        set(_vic_geo_builder_headers
            "${_vic_geo_builder_dir}/geo_utility.hpp"
            "${_vic_geo_builder_dir}/quad_accessor.hpp"
            "${_vic_geo_builder_dir}/quad_processor.hpp"
            "${_vic_geo_builder_dir}/geo_transform.hpp"
            "${_vic_geo_builder_dir}/color_remap_transform.hpp"
            "${_vic_geo_builder_dir}/quad_warper.hpp"
            "${_vic_geo_builder_dir}/quad_builder.hpp"
            "${_vic_geo_builder_dir}/mpi_quad_builder.hpp")

        terra_sdk_add_static_library(vic_core_geo_builder
            OUTPUT_NAME vic_geo_builder
            HEADER_SUBDIR vic/geo/builder
            SOURCES ${_vic_geo_builder_sources}
            HEADERS ${_vic_geo_builder_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_gdal vic_base_mpi
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_geo_builder_dir}")

        add_library(vic::core_geo_builder ALIAS vic_core_geo_builder)
        message(STATUS "Configured additive CMake target vic_core_geo_builder -> libvic_geo_builder.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_CORE_CBDAM_GEO)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/cbdam/geo/geo.pro")
        message(WARNING "vic_cbdam_geo qmake project not found; skipping vic_core_cbdam_geo")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_cbdam_geo")
    elseif(NOT TARGET terra_sdk_gdal)
        message(WARNING "GDAL dependency not available; skipping vic_core_cbdam_geo")
    else()
        set(_vic_cbdam_geo_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/cbdam/geo")
        set(_vic_cbdam_geo_sources
            "${_vic_cbdam_geo_dir}/map_raster_sampler.cpp"
            "${_vic_cbdam_geo_dir}/map_mosaic_sampler.cpp")
        set(_vic_cbdam_geo_headers
            "${_vic_cbdam_geo_dir}/map_sampler.hpp"
            "${_vic_cbdam_geo_dir}/map_raster_sampler.hpp"
            "${_vic_cbdam_geo_dir}/map_mosaic_sampler.hpp"
            "${_vic_cbdam_geo_dir}/map_external_sampler.hpp")

        terra_sdk_add_static_library(vic_core_cbdam_geo
            OUTPUT_NAME vic_cbdam_geo
            HEADER_SUBDIR vic/cbdam/geo
            SOURCES ${_vic_cbdam_geo_sources}
            HEADERS ${_vic_cbdam_geo_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_gdal
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_cbdam_geo_dir}")

        add_library(vic::core_cbdam_geo ALIAS vic_core_cbdam_geo)
        message(STATUS "Configured additive CMake target vic_core_cbdam_geo -> libvic_cbdam_geo.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_BASE)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/base/base.pro")
        message(WARNING "vic_geo_base qmake project not found; skipping vic_core_geo_base")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_geo_base")
    elseif(NOT TARGET vic_base_xml)
        message(WARNING "vic_base_xml dependency not available; skipping vic_core_geo_base")
    else()
        set(_vic_geo_base_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/base")
        set(_vic_geo_base_sources
            "${_vic_geo_base_dir}/tms_resource.cpp"
            "${_vic_geo_base_dir}/tms_root_resource.cpp"
            "${_vic_geo_base_dir}/tms_service_resource.cpp"
            "${_vic_geo_base_dir}/tms_tilemap_resource.cpp"
            "${_vic_geo_base_dir}/tilemap_config.cpp")
        set(_vic_geo_base_headers
            "${_vic_geo_base_dir}/victms_conventions.hpp"
            "${_vic_geo_base_dir}/tms_resource.hpp"
            "${_vic_geo_base_dir}/tms_root_resource.hpp"
            "${_vic_geo_base_dir}/tms_service_resource.hpp"
            "${_vic_geo_base_dir}/tms_tilemap_resource.hpp"
            "${_vic_geo_base_dir}/tilemap_config.hpp")

        terra_sdk_add_static_library(vic_core_geo_base
            OUTPUT_NAME vic_geo_base
            HEADER_SUBDIR vic/geo/base
            SOURCES ${_vic_geo_base_sources}
            HEADERS ${_vic_geo_base_headers}
            PUBLIC_DEPS terra_sdk_sl vic_base_xml
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS
                "${_vic_geo_base_dir}"
                "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/xml")

        add_library(vic::core_geo_base ALIAS vic_core_geo_base)
        message(STATUS "Configured additive CMake target vic_core_geo_base -> libvic_geo_base.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_CORE_GEO_SRS)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/srs/srs.pro")
        message(WARNING "vic_geo_srs qmake project not found; skipping vic_core_geo_srs")
    elseif(NOT TARGET terra_sdk_sl)
        message(WARNING "SL dependency not available; skipping vic_core_geo_srs")
    elseif(NOT TARGET terra_sdk_gdal)
        message(WARNING "GDAL dependency not available; skipping vic_core_geo_srs")
    else()
        set(_vic_geo_srs_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/srs")
        set(_vic_geo_srs_sources
            "${_vic_geo_srs_dir}/spatial_reference.cpp")
        set(_vic_geo_srs_headers
            "${_vic_geo_srs_dir}/spatial_reference.hpp")

        terra_sdk_add_static_library(vic_core_geo_srs
            OUTPUT_NAME vic_geo_srs
            HEADER_SUBDIR vic/geo/srs
            SOURCES ${_vic_geo_srs_sources}
            HEADERS ${_vic_geo_srs_headers}
            PUBLIC_DEPS terra_sdk_sl terra_sdk_gdal
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_geo_srs_dir}")

        add_library(vic::core_geo_srs ALIAS vic_core_geo_srs)
        message(STATUS "Configured additive CMake target vic_core_geo_srs -> libvic_geo_srs.a")
    endif()
endif()

if(TERRA_SDK_ENABLE_RATMAN_CORE_CBDAM_BASE)
    terra_sdk_configure_vic_core_cbdam_base()
endif()

if(TERRA_SDK_ENABLE_RATMAN_CORE_RATMAN)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/ratman/ratman.pro")
        message(WARNING "vic_ratman qmake project not found; skipping vic_core_ratman")
    elseif(NOT TARGET vic_core_cbdam_base)
        message(WARNING "vic_core_cbdam_base dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET vic_core_geo_base)
        message(WARNING "vic_core_geo_base dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET vic_core_geo_srs)
        message(WARNING "vic_core_geo_srs dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET vic_base_curlstream)
        message(WARNING "vic_base_curlstream dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET vic_base_gl)
        message(WARNING "vic_base_gl dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET vic_base_xml)
        message(WARNING "vic_base_xml dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET terra_sdk_qt_network)
        message(WARNING "Qt5 Network dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET terra_sdk_qt_xml)
        message(WARNING "Qt5 Xml dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET terra_sdk_qt_widgets)
        message(WARNING "Qt5 Widgets dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET terra_sdk_qt_opengl)
        message(WARNING "Qt5 OpenGL dependency not available; skipping vic_core_ratman")
    elseif(NOT TARGET terra_sdk_qt_printsupport)
        message(WARNING "Qt5 PrintSupport dependency not available; skipping vic_core_ratman")
    else()
        set(_vic_ratman_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/ratman")
        set(_vic_ratman_sources
            "${_vic_ratman_dir}/tcp_client.cpp"
            "${_vic_ratman_dir}/tcp_server.cpp"
            "${_vic_ratman_dir}/configuration.cpp"
            "${_vic_ratman_dir}/s3d_parser.cpp"
            "${_vic_ratman_dir}/string_utility.cpp"
            "${_vic_ratman_dir}/network.cpp"
            "${_vic_ratman_dir}/oriented_position.cpp"
            "${_vic_ratman_dir}/bookmarks_service.cpp"
            "${_vic_ratman_dir}/local_geonames_service.cpp"
            "${_vic_ratman_dir}/wfs_geonames_service.cpp"
            "${_vic_ratman_dir}/active_renderable.cpp"
            "${_vic_ratman_dir}/terrain_renderable.cpp"
            "${_vic_ratman_dir}/decorated_terrain_view.cpp"
            "${_vic_ratman_dir}/camera_controller.cpp"
            "${_vic_ratman_dir}/camera_animation.cpp"
            "${_vic_ratman_dir}/compass.cpp"
            "${_vic_ratman_dir}/control_buttons.cpp"
            "${_vic_ratman_dir}/snapshots.cpp"
            "${_vic_ratman_dir}/logo.cpp"
            "${_vic_ratman_dir}/atmosphere.cpp"
            "${_vic_ratman_dir}/fixed_label.cpp"
            "${_vic_ratman_dir}/qgl_scene_view.cpp"
            "${_vic_ratman_dir}/http_request.cpp"
            "${_vic_ratman_dir}/meteo_data.cpp"
            "${_vic_ratman_dir}/terrain_tile_meteo.cpp"
            "${_vic_ratman_dir}/browser.cpp"
            "${_vic_ratman_dir}/terrain_billboard_placemarks.cpp"
            "${_vic_ratman_dir}/terrain_placenames.cpp"
            "${_vic_ratman_dir}/terrain_item3d.cpp"
            "${_vic_ratman_dir}/bookmarks.cpp"
            "${_vic_ratman_dir}/copyright.cpp")
        set(_vic_ratman_headers
            "${_vic_ratman_dir}/tcp_client.hpp"
            "${_vic_ratman_dir}/tcp_server.hpp"
            "${_vic_ratman_dir}/configuration.hpp"
            "${_vic_ratman_dir}/string_utility.hpp"
            "${_vic_ratman_dir}/s3d_parser.hpp"
            "${_vic_ratman_dir}/oriented_position.hpp"
            "${_vic_ratman_dir}/network.hpp"
            "${_vic_ratman_dir}/geonames_service.hpp"
            "${_vic_ratman_dir}/bookmarks_service.hpp"
            "${_vic_ratman_dir}/local_geonames_service.hpp"
            "${_vic_ratman_dir}/wfs_geonames_service.hpp"
            "${_vic_ratman_dir}/active_renderable.hpp"
            "${_vic_ratman_dir}/terrain_renderable.hpp"
            "${_vic_ratman_dir}/decorated_terrain_view.hpp"
            "${_vic_ratman_dir}/placemark_icon.xpm"
            "${_vic_ratman_dir}/camera_controller.hpp"
            "${_vic_ratman_dir}/camera_animation.hpp"
            "${_vic_ratman_dir}/compass.xpm"
            "${_vic_ratman_dir}/compass.hpp"
            "${_vic_ratman_dir}/control_buttons.xpm"
            "${_vic_ratman_dir}/control_buttons.hpp"
            "${_vic_ratman_dir}/film_tile.xpm"
            "${_vic_ratman_dir}/snapshots.hpp"
            "${_vic_ratman_dir}/tape_tile.xpm"
            "${_vic_ratman_dir}/logo.xpm"
            "${_vic_ratman_dir}/logo.hpp"
            "${_vic_ratman_dir}/sundisk.hpp"
            "${_vic_ratman_dir}/atmosphere.hpp"
            "${_vic_ratman_dir}/fixed_label.hpp"
            "${_vic_ratman_dir}/qgl_scene_view.hpp"
            "${_vic_ratman_dir}/http_request.hpp"
            "${_vic_ratman_dir}/meteo_data.hpp"
            "${_vic_ratman_dir}/terrain_tile_meteo.hpp"
            "${_vic_ratman_dir}/browser.hpp"
            "${_vic_ratman_dir}/terrain_billboard_placemarks.hpp"
            "${_vic_ratman_dir}/terrain_placenames.hpp"
            "${_vic_ratman_dir}/terrain_item3d.hpp"
            "${_vic_ratman_dir}/bookmarks.hpp"
            "${_vic_ratman_dir}/copyright.hpp"
            "${_vic_ratman_dir}/Icons/bkg.xpm"
            "${_vic_ratman_dir}/Icons/bkn_s.xpm"
            "${_vic_ratman_dir}/Icons/close_hand.xpm"
            "${_vic_ratman_dir}/Icons/clr_s.xpm"
            "${_vic_ratman_dir}/Icons/few_s.xpm"
            "${_vic_ratman_dir}/Icons/gr_s.xpm"
            "${_vic_ratman_dir}/Icons/nodata.xpm"
            "${_vic_ratman_dir}/Icons/open_hand.xpm"
            "${_vic_ratman_dir}/Icons/ovc_s.xpm"
            "${_vic_ratman_dir}/Icons/ra_s.xpm"
            "${_vic_ratman_dir}/Icons/sct_s.xpm"
            "${_vic_ratman_dir}/Icons/sn_s.xpm"
            "${_vic_ratman_dir}/Icons/rot_3d.xpm")

        terra_sdk_add_static_library(vic_core_ratman
            OUTPUT_NAME vic_ratman
            HEADER_SUBDIR vic/ratman
            SOURCES ${_vic_ratman_sources}
            HEADERS ${_vic_ratman_headers}
            PUBLIC_DEPS
                vic_core_cbdam_base
                vic_core_geo_base
                vic_core_geo_srs
                vic_base_curlstream
                vic_base_gl
                vic_base_xml
                terra_sdk_qt_network
                terra_sdk_qt_xml
                terra_sdk_qt_widgets
                terra_sdk_qt_opengl
                terra_sdk_qt_printsupport
            PUBLIC_INCLUDE_DIRS "${_terra_sdk_ratman_public_include_dir}"
            PRIVATE_INCLUDE_DIRS "${_vic_ratman_dir}")
        if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
            # Source options follow transitive project flags, so this remains
            # effective after the legacy release-wide -ffast-math option.
            set_property(SOURCE "${_vic_ratman_dir}/atmosphere.cpp"
                APPEND PROPERTY COMPILE_OPTIONS -fno-finite-math-only)
        endif()
        set_target_properties(vic_core_ratman PROPERTIES AUTOMOC ON)

        add_library(vic::core_ratman ALIAS vic_core_ratman)
        message(STATUS "Configured additive CMake target vic_core_ratman -> libvic_ratman.a")
    endif()
endif()
