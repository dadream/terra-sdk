#include <terra/c_api/terra.h>
#include <stddef.h>

int main(void) {
  terra_terrain_manifest_v3 manifest = {0};
  manifest.struct_size = (uint32_t)sizeof(manifest);
  return terra_abi_version() == TERRA_C_API_VERSION &&
                 terra_sizeof_terrain_manifest_v3() == sizeof(manifest) &&
                 terra_sizeof_imagery_region_v4() == 176U &&
                 offsetof(terra_imagery_region_v4, flags) == 168U &&
                 offsetof(terra_imagery_region_v4, domain) == 172U &&
                 terra_sizeof_surface_work_v1() == 68U &&
                 offsetof(terra_surface_work_v1, quote_id) == 64U &&
                 terra_sizeof_surface_projection_v1() == 176U &&
                 offsetof(terra_surface_projection_v1, previous_measurement_id) == 24U &&
                 offsetof(terra_surface_projection_v1, matrix) == 32U &&
                 terra_sizeof_surface_summary_v1() == 64U
             ? 0
             : 1;
}
