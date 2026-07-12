#include <terra/core/coordinate_transform.hpp>
#include <terra/core/grid.hpp>

#include <cmath>

int main() {
  const terra::core::coordinate_transform transform =
      terra::core::coordinate_transform::cylindrical(6378000.0);
  const terra::core::vector3d xyz =
      transform.xyz_from_uvh(terra::core::vector3d{{0.0, 0.0, 0.0}});
  const std::array<terra::core::grid_diamond, 8> roots =
      terra::core::cylindrical_roots();
  const bool transform_matches =
      std::fabs(xyz[2] - 6378000.0) < 0.000001;
  const bool topology_matches =
      roots.size() == 8 && roots[0].id()[1] == 134217728;
  return transform_matches && topology_matches ? 0 : 1;
}
