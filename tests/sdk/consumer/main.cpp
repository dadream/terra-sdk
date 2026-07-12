#include <terra/core/coordinate_transform.hpp>

#include <cmath>

int main() {
  const terra::core::coordinate_transform transform =
      terra::core::coordinate_transform::cylindrical(6378000.0);
  const terra::core::vector3d xyz =
      transform.xyz_from_uvh(terra::core::vector3d{{0.0, 0.0, 0.0}});
  return std::fabs(xyz[2] - 6378000.0) < 0.000001 ? 0 : 1;
}
