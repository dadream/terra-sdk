#include <terra/core/wmts.hpp>

#include <limits>
#include <stdexcept>

namespace {

terra::core::bounds2d bounds(double min_x, double min_y,
                             double max_x, double max_y) {
  return terra::core::bounds2d(
      terra::core::vector2d{{min_x, min_y}},
      terra::core::vector2d{{max_x, max_y}});
}

void expect_tile(const terra::core::wmts_tile_key& tile,
                 int level, int matrix, int row, int column) {
  if (!tile.is_valid() || tile.level != level || tile.matrix != matrix ||
      tile.row != row || tile.column != column) {
    throw std::runtime_error("WMTS tile selection changed");
  }
}

}  // namespace

int main() {
  const terra::core::global_geodetic_wmts_selector selector(1, 17);
  if (!selector.is_valid()) {
    return 1;
  }

  const terra::core::wmts_tile_key west =
      selector.select(bounds(-180.0, -90.0, 0.0, 90.0), 256);
  const terra::core::wmts_tile_key east =
      selector.select(bounds(0.0, -90.0, 180.0, 90.0), 256);
  const terra::core::wmts_tile_key north_east =
      selector.select(bounds(90.0, 0.0, 180.0, 90.0), 256);
  const terra::core::wmts_tile_key south_east =
      selector.select(bounds(90.0, -90.0, 180.0, 0.0), 256);
  expect_tile(west, 0, 1, 0, 0);
  expect_tile(east, 0, 1, 0, 1);
  expect_tile(north_east, 1, 2, 0, 3);
  expect_tile(south_east, 1, 2, 1, 3);
  if (selector.subdomain(west, 8) != 0 ||
      selector.subdomain(east, 8) != 1) {
    return 1;
  }

  const double nan = std::numeric_limits<double>::quiet_NaN();
  if (selector.select(bounds(-181.0, -90.0, 0.0, 90.0), 256).is_valid() ||
      selector.select(bounds(-180.0, -90.0, 0.0, 90.0), 0).is_valid() ||
      selector.select(bounds(nan, -90.0, 0.0, 90.0), 256).is_valid()) {
    return 1;
  }

  const terra::core::global_geodetic_wmts_selector overflowing(
      std::numeric_limits<int>::max(), 1);
  if (overflowing.is_valid() ||
      overflowing.subdomain(terra::core::wmts_tile_key(1, 0, 0, 0), 1) !=
          -1) {
    return 1;
  }
  return 0;
}
