#include <terra/core/coordinate_transform.hpp>
#include <terra/core/grid.hpp>
#include <terra/core/wmts.hpp>
#include <terra/codec/cbdam_height.hpp>
#include <terra/frame/camera.hpp>

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
  const terra::core::global_geodetic_wmts_selector selector(1, 17);
  const terra::core::wmts_tile_key west = selector.select(
      terra::core::bounds2d(terra::core::vector2d{{-180.0, -90.0}},
                            terra::core::vector2d{{0.0, 90.0}}),
      256);
  const bool texture_selection_matches =
      west.is_valid() && west.matrix == 1 && west.column == 0;
  const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
  const terra::frame::globe_camera camera(
      static_cast<float>(6378000.0), 1280, 720, y_fov);
  const bool camera_matches =
      camera.is_valid() && camera.snapshot().position[2] > 6378000.0;
  terra::codec::height_patch_record patch_record;
  const bool codec_matches =
      terra::codec::decode_cbdam_height_record(nullptr, 0U, patch_record) ==
      terra::codec::decode_status::invalid_argument;
  return transform_matches && topology_matches &&
                 texture_selection_matches && camera_matches && codec_matches
             ? 0
             : 1;
}
