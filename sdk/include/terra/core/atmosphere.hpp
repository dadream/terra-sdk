#ifndef TERRA_CORE_ATMOSPHERE_HPP
#define TERRA_CORE_ATMOSPHERE_HPP

#include <array>
#include <cstdint>
#include <vector>

namespace terra {
namespace core {

struct atmosphere_parameters {
  float sun_azimuth_degrees = 135.0F;
  float sun_zenith_degrees = 35.0F;
  float turbidity = 2.0F;
  float exposure = 1.0F;
  std::uint32_t texture_width = 256U;
  std::uint32_t texture_height = 32U;
};

struct atmosphere_result {
  std::uint32_t texture_width = 0U;
  std::uint32_t texture_height = 0U;
  bool sun_visible = false;
  std::array<float, 3> sun_direction{{0.0F, 0.0F, 1.0F}};
  std::array<float, 3> ambient_color{{0.0F, 0.0F, 0.0F}};
  std::array<float, 3> diffuse_color{{0.0F, 0.0F, 0.0F}};
  std::array<float, 3> fog_color{{0.0F, 0.0F, 0.0F}};
  float sea_level_fog_density = 0.0F;
  std::vector<std::uint8_t> rgba;
};

atmosphere_result compute_atmosphere(
    const atmosphere_parameters& parameters);

}  // namespace core
}  // namespace terra

#endif
