option(TERRA_SDK_ENABLE_RATMAN_SERVICE_MOD_VICTMS
    "Build the additive CMake target for the Apache mod_victms module." ON)

if(TERRA_SDK_ENABLE_RATMAN_SERVICE_MOD_VICTMS)
    if(NOT EXISTS "${TERRA_SDK_RATMAN_SOURCE_DIR}/apache_mod_victms/mod_victms.cpp")
        message(WARNING "mod_victms source not found; skipping vic_service_mod_victms")
    elseif(NOT TARGET vic_base_xml)
        message(WARNING "vic_base_xml dependency not available; skipping vic_service_mod_victms")
    elseif(NOT TARGET vic_core_geo_base)
        message(WARNING "vic_core_geo_base dependency not available; skipping vic_service_mod_victms")
    elseif(NOT TARGET terra_sdk_apxs)
        message(WARNING "APXS/Apache dependency not available; skipping vic_service_mod_victms")
    else()
        set(_vic_mod_victms_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/apache_mod_victms")
        set(_vic_xml_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/base/src/vic/xml")
        set(_vic_geo_base_dir "${TERRA_SDK_RATMAN_SOURCE_DIR}/ratman/src/vic/geo/base")

        terra_sdk_add_module(vic_service_mod_victms
            OUTPUT_NAME mod_victms
            NO_PREFIX
            SOURCES "${_vic_mod_victms_dir}/mod_victms.cpp"
            PUBLIC_DEPS
                vic_base_xml
                vic_core_geo_base
                terra_sdk_apxs
            PRIVATE_INCLUDE_DIRS
                "${_vic_mod_victms_dir}"
                "${_vic_xml_dir}"
                "${_vic_geo_base_dir}")
        target_compile_options(vic_service_mod_victms PRIVATE "-include" "unistd.h")

        add_library(vic::service_mod_victms ALIAS vic_service_mod_victms)
        message(STATUS "Configured additive CMake target vic_service_mod_victms -> mod_victms.so")
    endif()
endif()
