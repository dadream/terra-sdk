#include <terra/core/atmosphere.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace terra {
namespace core {
namespace {

constexpr float pi = 3.14159265358979323846F;
constexpr float half_pi = pi * 0.5F;

using color3 = std::array<float, 3>;

float clamp(float value, float minimum, float maximum) {
  return std::max(minimum, std::min(value, maximum));
}

float radians(float degrees) { return degrees * pi / 180.0F; }

struct perez_coefficients {
  float a;
  float b;
  float c;
  float d;
  float e;
};

perez_coefficients coefficients(const color3& a, const color3& b,
                                 const color3& c, const color3& d,
                                 const color3& e, float turbidity) {
  return {
      a[0] * turbidity + a[1],
      b[0] * turbidity + b[1],
      c[0] * turbidity + c[1],
      d[0] * turbidity + d[1],
      e[0] * turbidity + e[1],
  };
}

float perez(const perez_coefficients& value, float theta, float gamma) {
  const float cosine_theta = std::max(0.01F, std::cos(theta));
  const float cosine_gamma = std::cos(gamma);
  return (1.0F + value.a * std::exp(value.b / cosine_theta)) *
         (1.0F + value.c * std::exp(value.d * gamma) +
          value.e * cosine_gamma * cosine_gamma);
}

color3 zenith_yxy(float turbidity, float sun_zenith) {
  const float theta2 = sun_zenith * sun_zenith;
  const float theta3 = theta2 * sun_zenith;
  const float turbidity2 = turbidity * turbidity;
  const float chi =
      (4.0F / 9.0F - turbidity / 120.0F) * (pi - 2.0F * sun_zenith);
  const float luminance =
      (4.0453F * turbidity - 4.9710F) * std::tan(chi) -
      0.2155F * turbidity + 2.4192F;
  const float x =
      (0.00165F * theta3 - 0.00374F * theta2 +
       0.00208F * sun_zenith) * turbidity2 +
      (-0.02902F * theta3 + 0.06377F * theta2 -
       0.03202F * sun_zenith + 0.00394F) * turbidity +
      (0.11693F * theta3 - 0.21196F * theta2 +
       0.06052F * sun_zenith + 0.25885F);
  const float y =
      (0.00275F * theta3 - 0.00610F * theta2 +
       0.00317F * sun_zenith) * turbidity2 +
      (-0.04214F * theta3 + 0.08970F * theta2 -
       0.04153F * sun_zenith + 0.00516F) * turbidity +
      (0.15346F * theta3 - 0.26756F * theta2 +
       0.06669F * sun_zenith + 0.26688F);
  return {{std::max(0.001F, luminance), clamp(x, 0.001F, 0.999F),
           clamp(y, 0.001F, 0.999F)}};
}

color3 yxy_to_display_rgb(const color3& yxy, float exposure) {
  const float y = std::max(0.001F, yxy[2]);
  const float x_value = yxy[0] * yxy[1] / y;
  const float z_value = yxy[0] * (1.0F - yxy[1] - yxy[2]) / y;
  color3 rgb{{
      3.2406F * x_value - 1.5372F * yxy[0] - 0.4986F * z_value,
      -0.9689F * x_value + 1.8758F * yxy[0] + 0.0415F * z_value,
      0.0557F * x_value - 0.2040F * yxy[0] + 1.0570F * z_value,
  }};
  const float scale = exposure / 12.0F;
  for (float& channel : rgb) {
    channel = 1.0F - std::exp(-std::max(0.0F, channel) * scale);
    channel = std::pow(clamp(channel, 0.0F, 1.0F), 1.0F / 2.2F);
  }
  return rgb;
}

std::uint8_t to_byte(float value) {
  return static_cast<std::uint8_t>(
      std::lround(clamp(value, 0.0F, 1.0F) * 255.0F));
}

color3 texel(const std::vector<std::uint8_t>& rgba,
             std::uint32_t width, std::uint32_t x, std::uint32_t y) {
  const std::size_t offset =
      (static_cast<std::size_t>(y) * width + x) * 4U;
  return {{rgba[offset] / 255.0F, rgba[offset + 1U] / 255.0F,
           rgba[offset + 2U] / 255.0F}};
}

}  // namespace

atmosphere_result compute_atmosphere(
    const atmosphere_parameters& parameters) {
  atmosphere_result result;
  result.texture_width = parameters.texture_width;
  result.texture_height = parameters.texture_height;
  const float turbidity = clamp(parameters.turbidity, 1.0F, 20.0F);
  const float exposure = clamp(parameters.exposure, 0.05F, 8.0F);
  const float sun_azimuth = radians(parameters.sun_azimuth_degrees);
  const float sun_zenith =
      radians(clamp(parameters.sun_zenith_degrees, 0.0F, 120.0F));
  result.sun_visible = sun_zenith < half_pi;
  result.sun_direction = {{
      std::sin(sun_azimuth) * std::sin(sun_zenith),
      std::cos(sun_azimuth) * std::sin(sun_zenith),
      std::cos(sun_zenith),
  }};
  result.sea_level_fog_density = turbidity * 1.0e-5F;

  if (parameters.texture_width == 0U ||
      parameters.texture_height == 0U) {
    return result;
  }

  result.rgba.resize(static_cast<std::size_t>(parameters.texture_width) *
                     parameters.texture_height * 4U);

  const color3 a_y{{0.1787F, -1.4630F, 0.0F}};
  const color3 b_y{{-0.3554F, 0.4275F, 0.0F}};
  const color3 c_y{{-0.0227F, 5.3251F, 0.0F}};
  const color3 d_y{{0.1206F, -2.5771F, 0.0F}};
  const color3 e_y{{-0.0670F, 0.3703F, 0.0F}};
  const color3 a_x{{-0.0193F, -0.2592F, 0.0F}};
  const color3 b_x{{-0.0665F, 0.0008F, 0.0F}};
  const color3 c_x{{-0.0004F, 0.2125F, 0.0F}};
  const color3 d_x{{-0.0641F, -0.8989F, 0.0F}};
  const color3 e_x{{-0.0033F, 0.0452F, 0.0F}};
  const color3 a_y_chroma{{-0.0167F, -0.2608F, 0.0F}};
  const color3 b_y_chroma{{-0.0950F, 0.0092F, 0.0F}};
  const color3 c_y_chroma{{-0.0079F, 0.2102F, 0.0F}};
  const color3 d_y_chroma{{-0.0441F, -1.6537F, 0.0F}};
  const color3 e_y_chroma{{-0.0109F, 0.0529F, 0.0F}};
  const perez_coefficients p_y =
      coefficients(a_y, b_y, c_y, d_y, e_y, turbidity);
  const perez_coefficients p_x =
      coefficients(a_x, b_x, c_x, d_x, e_x, turbidity);
  const perez_coefficients p_y_chroma =
      coefficients(a_y_chroma, b_y_chroma, c_y_chroma, d_y_chroma,
                   e_y_chroma, turbidity);
  const color3 zenith = zenith_yxy(turbidity, sun_zenith);
  const color3 denominator{{
      std::max(0.001F, perez(p_y, 0.0F, sun_zenith)),
      std::max(0.001F, perez(p_x, 0.0F, sun_zenith)),
      std::max(0.001F, perez(p_y_chroma, 0.0F, sun_zenith)),
  }};

  for (std::uint32_t y = 0U; y < parameters.texture_height; ++y) {
    const float theta =
        (static_cast<float>(y) + 0.5F) /
        static_cast<float>(parameters.texture_height) * half_pi;
    for (std::uint32_t x = 0U; x < parameters.texture_width; ++x) {
      const float azimuth =
          (static_cast<float>(x) + 0.5F) /
          static_cast<float>(parameters.texture_width) * 2.0F * pi;
      const float cosine_gamma =
          std::cos(theta) * std::cos(sun_zenith) +
          std::sin(theta) * std::sin(sun_zenith) *
              std::cos(azimuth - sun_azimuth);
      const float gamma = std::acos(clamp(cosine_gamma, -1.0F, 1.0F));
      const color3 yxy{{
          zenith[0] * perez(p_y, theta, gamma) / denominator[0],
          zenith[1] * perez(p_x, theta, gamma) / denominator[1],
          zenith[2] * perez(p_y_chroma, theta, gamma) / denominator[2],
      }};
      const color3 rgb = yxy_to_display_rgb(yxy, exposure);
      const std::size_t offset =
          (static_cast<std::size_t>(y) * parameters.texture_width + x) * 4U;
      result.rgba[offset] = to_byte(rgb[0]);
      result.rgba[offset + 1U] = to_byte(rgb[1]);
      result.rgba[offset + 2U] = to_byte(rgb[2]);
      result.rgba[offset + 3U] = 255U;
    }
  }

  result.ambient_color = texel(
      result.rgba, parameters.texture_width, 0U,
      std::min(parameters.texture_height - 1U,
               parameters.texture_height / 3U));
  const std::uint32_t sun_x = static_cast<std::uint32_t>(
      std::fmod(parameters.sun_azimuth_degrees + 360.0F, 360.0F) /
      360.0F * parameters.texture_width) % parameters.texture_width;
  const std::uint32_t sun_y = std::min(
      parameters.texture_height - 1U,
      static_cast<std::uint32_t>(
          clamp(parameters.sun_zenith_degrees, 0.0F, 90.0F) / 90.0F *
          parameters.texture_height));
  result.diffuse_color =
      texel(result.rgba, parameters.texture_width, sun_x, sun_y);
  result.fog_color = texel(
      result.rgba, parameters.texture_width,
      (sun_x + parameters.texture_width / 2U) % parameters.texture_width,
      parameters.texture_height - 1U);
  return result;
}

}  // namespace core
}  // namespace terra
