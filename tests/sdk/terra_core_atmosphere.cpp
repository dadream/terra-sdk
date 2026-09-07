#include <terra/core/atmosphere.hpp>

#include <algorithm>
#include <cmath>

int main() {
  terra::core::atmosphere_parameters parameters;
  parameters.texture_width = 64U;
  parameters.texture_height = 16U;
  const terra::core::atmosphere_result result =
      terra::core::compute_atmosphere(parameters);

  if (result.texture_width != 64U || result.texture_height != 16U ||
      result.rgba.size() != 64U * 16U * 4U || !result.sun_visible ||
      result.sea_level_fog_density <= 0.0F) {
    return 1;
  }
  const float sun_length = std::sqrt(
      result.sun_direction[0] * result.sun_direction[0] +
      result.sun_direction[1] * result.sun_direction[1] +
      result.sun_direction[2] * result.sun_direction[2]);
  const auto minimum =
      *std::min_element(result.rgba.begin(), result.rgba.end());
  const auto maximum =
      *std::max_element(result.rgba.begin(), result.rgba.end());
  if (std::abs(sun_length - 1.0F) >= 1.0e-4F || minimum >= maximum) {
    return 2;
  }

  parameters.sun_zenith_degrees = 100.0F;
  const terra::core::atmosphere_result night =
      terra::core::compute_atmosphere(parameters);
  if (night.sun_visible || night.rgba.size() != result.rgba.size()) {
    return 3;
  }
  return 0;
}
