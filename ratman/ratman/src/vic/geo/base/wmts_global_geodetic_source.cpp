#include <vic/geo/base/wmts_global_geodetic_source.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <sstream>

namespace vic {
namespace geo {
namespace base {

namespace {

const double k_min_longitude = -180.0;
const double k_max_longitude = 180.0;
const double k_min_latitude = -90.0;
const double k_max_latitude = 90.0;
const double k_level_zero_tile_span = 180.0;
const int k_max_safe_level = 28;

std::size_t power_of_two(int exponent) {
  return std::size_t(1) << exponent;
}

}  // namespace

wmts_tile_coordinate::wmts_tile_coordinate()
    : level(-1), matrix(-1), row(-1), column(-1) {
}

wmts_tile_coordinate::wmts_tile_coordinate(
    int level_value, int matrix_value, int row_value, int column_value)
    : level(level_value),
      matrix(matrix_value),
      row(row_value),
      column(column_value) {
}

bool wmts_tile_coordinate::is_valid() const {
  return level >= 0 && matrix >= 0 && row >= 0 && column >= 0;
}

wmts_global_geodetic_source::wmts_global_geodetic_source(
    const std::string& endpoint,
    const std::string& layer,
    const std::string& style,
    const std::string& format,
    const std::string& matrix_set,
    int matrix_level_offset,
    int max_level,
    int subdomain_count,
    const std::string& token_parameter,
    const std::string& token)
    : endpoint_(endpoint),
      layer_(layer),
      style_(style),
      format_(format),
      matrix_set_(matrix_set),
      matrix_level_offset_(matrix_level_offset),
      max_level_(max_level),
      subdomain_count_(subdomain_count),
      token_parameter_(token_parameter),
      token_(token) {
}

bool wmts_global_geodetic_source::is_valid() const {
  return !endpoint_.empty() && !layer_.empty() && !style_.empty() &&
         !format_.empty() && !matrix_set_.empty() &&
         matrix_level_offset_ >= 0 &&
         max_level_ >= 0 && max_level_ <= k_max_safe_level &&
         matrix_level_offset_ <=
             std::numeric_limits<int>::max() - max_level_ &&
         subdomain_count_ > 0;
}

const std::string& wmts_global_geodetic_source::endpoint() const {
  return endpoint_;
}

const std::string& wmts_global_geodetic_source::layer() const {
  return layer_;
}

const std::string& wmts_global_geodetic_source::matrix_set() const {
  return matrix_set_;
}

int wmts_global_geodetic_source::max_level() const {
  return max_level_;
}

int wmts_global_geodetic_source::closest_level(
    double units_per_pixel, std::size_t tile_width) const {
  if (!is_valid() || !std::isfinite(units_per_pixel) ||
      units_per_pixel <= 0.0 || tile_width == 0) {
    return -1;
  }

  int best_level = 0;
  double best_resolution =
      k_level_zero_tile_span / static_cast<double>(tile_width);
  double best_delta = std::fabs(units_per_pixel - best_resolution);

  for (int level = 1; level <= max_level_; ++level) {
    const double resolution =
        k_level_zero_tile_span /
        (static_cast<double>(tile_width) *
         static_cast<double>(power_of_two(level)));
    const double delta = std::fabs(units_per_pixel - resolution);
    if (delta < best_delta) {
      best_level = level;
      best_resolution = resolution;
      best_delta = delta;
    }
  }

  if (best_level == max_level_) {
    const double next_resolution = 0.5 * best_resolution;
    if (std::fabs(units_per_pixel - next_resolution) < best_delta) {
      return -1;
    }
  }
  return best_level;
}

wmts_tile_coordinate wmts_global_geodetic_source::tile_for_bbox(
    double min_x, double min_y, double max_x, double max_y,
    std::size_t tile_width) const {
  if (!is_valid() || tile_width == 0 ||
      !std::isfinite(min_x) || !std::isfinite(min_y) ||
      !std::isfinite(max_x) || !std::isfinite(max_y) ||
      min_x < k_min_longitude || max_x > k_max_longitude ||
      min_y < k_min_latitude || max_y > k_max_latitude ||
      min_x >= max_x || min_y >= max_y) {
    return wmts_tile_coordinate();
  }

  const double units_per_pixel =
      std::max((max_x - min_x) / static_cast<double>(tile_width),
               (max_y - min_y) / static_cast<double>(tile_width));
  const int level = closest_level(units_per_pixel, tile_width);
  if (level < 0) {
    return wmts_tile_coordinate();
  }

  const std::size_t rows = power_of_two(level);
  const std::size_t columns = 2 * rows;
  const double tile_span =
      k_level_zero_tile_span / static_cast<double>(rows);
  const double center_x = 0.5 * (min_x + max_x);
  const double center_y = 0.5 * (min_y + max_y);
  const int tms_x = static_cast<int>(
      std::floor((center_x - k_min_longitude) / tile_span));
  const int tms_y = static_cast<int>(
      std::floor((center_y - k_min_latitude) / tile_span));
  if (tms_x < 0 || tms_y < 0 ||
      static_cast<std::size_t>(tms_x) >= columns ||
      static_cast<std::size_t>(tms_y) >= rows) {
    return wmts_tile_coordinate();
  }

  return wmts_tile_coordinate(
      level,
      level + matrix_level_offset_,
      static_cast<int>(rows - 1 - static_cast<std::size_t>(tms_y)),
      tms_x);
}

std::string wmts_global_geodetic_source::endpoint_for_tile(
    const wmts_tile_coordinate& tile) const {
  std::string result = endpoint_;
  const std::string placeholder = "{s}";
  const std::size_t position = result.find(placeholder);
  if (position != std::string::npos) {
    const int subdomain = (tile.row + tile.column) % subdomain_count_;
    std::ostringstream value;
    value << subdomain;
    result.replace(position, placeholder.size(), value.str());
  }
  return result;
}

std::string wmts_global_geodetic_source::tile_url(
    const wmts_tile_coordinate& tile) const {
  if (!is_valid() || !tile.is_valid() || tile.level > max_level_) {
    return "";
  }

  const std::size_t rows = power_of_two(tile.level);
  const std::size_t columns = 2 * rows;
  if (tile.matrix != tile.level + matrix_level_offset_ ||
      static_cast<std::size_t>(tile.row) >= rows ||
      static_cast<std::size_t>(tile.column) >= columns) {
    return "";
  }

  std::ostringstream result;
  const std::string endpoint = endpoint_for_tile(tile);
  result << endpoint;
  if (endpoint[endpoint.size() - 1] != '?' &&
      endpoint[endpoint.size() - 1] != '&') {
    result << (endpoint.find('?') == std::string::npos ? '?' : '&');
  }
  result << "SERVICE=WMTS"
         << "&REQUEST=GetTile"
         << "&VERSION=1.0.0"
         << "&LAYER=" << layer_
         << "&STYLE=" << style_
         << "&TILEMATRIXSET=" << matrix_set_
         << "&FORMAT=" << format_
         << "&TILEMATRIX=" << tile.matrix
         << "&TILEROW=" << tile.row
         << "&TILECOL=" << tile.column;
  if (!token_parameter_.empty() && !token_.empty()) {
    result << '&' << token_parameter_ << '=' << token_;
  }
  return result.str();
}

std::string wmts_global_geodetic_source::tile_url_for_bbox(
    double min_x, double min_y, double max_x, double max_y,
    std::size_t tile_width) const {
  return tile_url(tile_for_bbox(min_x, min_y, max_x, max_y, tile_width));
}

}  // namespace base
}  // namespace geo
}  // namespace vic
