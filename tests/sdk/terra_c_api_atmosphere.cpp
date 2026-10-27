#include <terra/c_api/terra.h>

#include <algorithm>
#include <cstdint>
#include <vector>

int main() {
  if (terra_sizeof_atmosphere_parameters_v1() !=
          sizeof(terra_atmosphere_parameters_v1) ||
      terra_sizeof_atmosphere_result_v1() !=
          sizeof(terra_atmosphere_result_v1)) {
    return 1;
  }

  terra_atmosphere_parameters_v1 parameters{};
  parameters.struct_size = sizeof(parameters);
  parameters.sun_azimuth_degrees = 135.0F;
  parameters.sun_zenith_degrees = 35.0F;
  parameters.turbidity = 2.0F;
  parameters.exposure = 1.0F;
  parameters.texture_width = 32U;
  parameters.texture_height = 8U;

  terra_atmosphere_result_v1 result{};
  result.struct_size = sizeof(result);
  if (terra_compute_atmosphere(&parameters, &result, nullptr, 0U) !=
          TERRA_STATUS_BUFFER_TOO_SMALL ||
      result.required_rgba_bytes != 32U * 8U * 4U ||
      result.texture_width != 32U || result.texture_height != 8U ||
      result.sun_visible != 1U) {
    return 2;
  }

  std::vector<std::uint8_t> rgba(result.required_rgba_bytes);
  result.struct_size = sizeof(result);
  if (terra_compute_atmosphere(
          &parameters, &result, rgba.data(),
          static_cast<std::uint32_t>(rgba.size())) != TERRA_STATUS_OK ||
      !std::any_of(rgba.begin(), rgba.end(),
                   [](std::uint8_t value) { return value != 0U; }) ||
      result.sea_level_fog_density <= 0.0F) {
    return 3;
  }

  parameters.turbidity = 0.0F;
  result.struct_size = sizeof(result);
  if (terra_compute_atmosphere(
          &parameters, &result, rgba.data(),
          static_cast<std::uint32_t>(rgba.size())) !=
      TERRA_STATUS_INVALID_ARGUMENT) {
    return 4;
  }
  return 0;
}
