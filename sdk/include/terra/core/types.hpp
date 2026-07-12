#ifndef TERRA_CORE_TYPES_HPP
#define TERRA_CORE_TYPES_HPP

#include <array>
#include <cstdint>
#include <string>

namespace terra {
namespace core {

using vector2d = std::array<double, 2>;
using vector3d = std::array<double, 3>;

struct bounds2d {
  bounds2d();
  bounds2d(const vector2d& minimum_value, const vector2d& maximum_value);

  vector2d minimum;
  vector2d maximum;
};

enum class coordinate_transform_kind {
  planar,
  cylindrical
};

struct dataset_metadata {
  dataset_metadata();

  std::uint32_t format_version;
  std::uint32_t patch_dimension;
  double height_scale_factor;
  std::string srs;
  std::string about;
  coordinate_transform_kind transform;
  bounds2d bounds;
  double radius;
};

}  // namespace core
}  // namespace terra

#endif  // TERRA_CORE_TYPES_HPP
