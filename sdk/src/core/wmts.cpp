#include <terra/core/wmts.hpp>

#include <algorithm>
#include <cmath>
#include <limits>

namespace terra {
namespace core {
namespace {

const double minimum_longitude = -180.0;
const double maximum_longitude = 180.0;
const double minimum_latitude = -90.0;
const double maximum_latitude = 90.0;
const double level_zero_tile_span = 180.0;
const int maximum_safe_level = 28;

std::size_t power_of_two(int exponent) {
  return std::size_t(1) << exponent;
}

}  // namespace

wmts_tile_key::wmts_tile_key()
    : level(-1), matrix(-1), row(-1), column(-1) {}

wmts_tile_key::wmts_tile_key(int level_value, int matrix_value,
                             int row_value, int column_value)
    : level(level_value),
      matrix(matrix_value),
      row(row_value),
      column(column_value) {}

bool wmts_tile_key::is_valid() const {
  return level >= 0 && matrix >= 0 && row >= 0 && column >= 0;
}

global_geodetic_wmts_selector::global_geodetic_wmts_selector(
    int matrix_level_offset, int maximum_level)
    : matrix_level_offset_(matrix_level_offset),
      maximum_level_(maximum_level) {}

bool global_geodetic_wmts_selector::is_valid() const {
  return matrix_level_offset_ >= 0 && maximum_level_ >= 0 &&
         maximum_level_ <= maximum_safe_level &&
         matrix_level_offset_ <=
             std::numeric_limits<int>::max() - maximum_level_;
}

int global_geodetic_wmts_selector::matrix_level_offset() const {
  return matrix_level_offset_;
}

int global_geodetic_wmts_selector::maximum_level() const {
  return maximum_level_;
}

int global_geodetic_wmts_selector::closest_level(
    double units_per_pixel, std::size_t tile_width) const {
  if (!is_valid() || !std::isfinite(units_per_pixel) ||
      units_per_pixel <= 0.0 || tile_width == 0) {
    return -1;
  }

  int best_level = 0;
  double best_resolution =
      level_zero_tile_span / static_cast<double>(tile_width);
  double best_delta = std::fabs(units_per_pixel - best_resolution);
  for (int level = 1; level <= maximum_level_; ++level) {
    const double resolution =
        level_zero_tile_span /
        (static_cast<double>(tile_width) *
         static_cast<double>(power_of_two(level)));
    const double delta = std::fabs(units_per_pixel - resolution);
    if (delta < best_delta) {
      best_level = level;
      best_resolution = resolution;
      best_delta = delta;
    }
  }

  if (best_level == maximum_level_) {
    const double next_resolution = 0.5 * best_resolution;
    if (std::fabs(units_per_pixel - next_resolution) < best_delta) {
      return -1;
    }
  }
  return best_level;
}

wmts_tile_key global_geodetic_wmts_selector::select(
    const bounds2d& bounds, std::size_t tile_width) const {
  const double width = bounds.maximum[0] - bounds.minimum[0];
  const double height = bounds.maximum[1] - bounds.minimum[1];
  if (!is_valid() || tile_width == 0 || !std::isfinite(width) ||
      !std::isfinite(height) || width <= 0.0 || height <= 0.0) {
    return wmts_tile_key();
  }
  const int level = closest_level(
      std::max(width, height) / static_cast<double>(tile_width), tile_width);
  return level < 0 ? wmts_tile_key() : select_level(bounds, level);
}

wmts_tile_key global_geodetic_wmts_selector::select_clamped(
    const bounds2d& bounds, std::size_t tile_width) const {
  const double width = bounds.maximum[0] - bounds.minimum[0];
  const double height = bounds.maximum[1] - bounds.minimum[1];
  if (!is_valid() || tile_width == 0 || !std::isfinite(width) ||
      !std::isfinite(height) || width <= 0.0 || height <= 0.0) {
    return wmts_tile_key();
  }
  int level = closest_level(
      std::max(width, height) / static_cast<double>(tile_width), tile_width);
  if (level < 0) {
    level = maximum_level_;
  }
  return select_level(bounds, level);
}

wmts_tile_key global_geodetic_wmts_selector::select_level(
    const bounds2d& bounds, int level) const {
  const double min_x = bounds.minimum[0];
  const double min_y = bounds.minimum[1];
  const double max_x = bounds.maximum[0];
  const double max_y = bounds.maximum[1];
  if (!is_valid() || level < 0 || level > maximum_level_ ||
      !std::isfinite(min_x) || !std::isfinite(min_y) ||
      !std::isfinite(max_x) || !std::isfinite(max_y) ||
      min_x < minimum_longitude || max_x > maximum_longitude ||
      min_y < minimum_latitude || max_y > maximum_latitude ||
      min_x >= max_x || min_y >= max_y) {
    return wmts_tile_key();
  }

  const std::size_t rows = power_of_two(level);
  const std::size_t columns = 2U * rows;
  const double tile_span = level_zero_tile_span / static_cast<double>(rows);
  const double center_x = 0.5 * (min_x + max_x);
  const double center_y = 0.5 * (min_y + max_y);
  const int column = static_cast<int>(
      std::floor((center_x - minimum_longitude) / tile_span));
  const int tms_row = static_cast<int>(
      std::floor((center_y - minimum_latitude) / tile_span));
  if (column < 0 || tms_row < 0 ||
      static_cast<std::size_t>(column) >= columns ||
      static_cast<std::size_t>(tms_row) >= rows) {
    return wmts_tile_key();
  }
  return wmts_tile_key(
      level, level + matrix_level_offset_,
      static_cast<int>(rows - 1U - static_cast<std::size_t>(tms_row)),
      column);
}

bounds2d global_geodetic_wmts_selector::tile_bounds(
    const wmts_tile_key& tile) const {
  if (!is_valid() || !tile.is_valid() || tile.level > maximum_level_ ||
      tile.matrix != tile.level + matrix_level_offset_) {
    return bounds2d();
  }
  const std::size_t rows = power_of_two(tile.level);
  const std::size_t columns = 2U * rows;
  if (static_cast<std::size_t>(tile.row) >= rows ||
      static_cast<std::size_t>(tile.column) >= columns) {
    return bounds2d();
  }
  const double span = level_zero_tile_span / static_cast<double>(rows);
  const double min_x = minimum_longitude + tile.column * span;
  const double max_y = maximum_latitude - tile.row * span;
  return bounds2d(vector2d{{min_x, max_y - span}},
                  vector2d{{min_x + span, max_y}});
}

int global_geodetic_wmts_selector::subdomain(
    const wmts_tile_key& tile, int subdomain_count) const {
  if (!is_valid() || !tile.is_valid() || subdomain_count <= 0 ||
      tile.level > maximum_level_ ||
      tile.matrix != tile.level + matrix_level_offset_) {
    return -1;
  }
  const std::size_t rows = power_of_two(tile.level);
  const std::size_t columns = 2 * rows;
  if (static_cast<std::size_t>(tile.row) >= rows ||
      static_cast<std::size_t>(tile.column) >= columns) {
    return -1;
  }
  return (tile.row + tile.column) % subdomain_count;
}

}  // namespace core
}  // namespace terra
