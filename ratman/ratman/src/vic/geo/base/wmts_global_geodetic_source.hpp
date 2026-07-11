#ifndef VIC_GEO_BASE_WMTS_GLOBAL_GEODETIC_SOURCE_HPP
#define VIC_GEO_BASE_WMTS_GLOBAL_GEODETIC_SOURCE_HPP

#include <cstddef>
#include <string>

namespace vic {
namespace geo {
namespace base {

struct wmts_tile_coordinate {
  int level;
  int matrix;
  int row;
  int column;

  wmts_tile_coordinate();
  wmts_tile_coordinate(int level_value, int matrix_value,
                       int row_value, int column_value);

  bool is_valid() const;
};

class wmts_global_geodetic_source {
public:
  wmts_global_geodetic_source(
      const std::string& endpoint,
      const std::string& layer,
      const std::string& style = "default",
      const std::string& format = "tiles",
      const std::string& matrix_set = "c",
      int matrix_level_offset = 1,
      int max_level = 18,
      int subdomain_count = 1,
      const std::string& token_parameter = "",
      const std::string& token = "");

  bool is_valid() const;

  const std::string& endpoint() const;
  const std::string& layer() const;
  const std::string& matrix_set() const;
  int max_level() const;

  wmts_tile_coordinate tile_for_bbox(
      double min_x, double min_y, double max_x, double max_y,
      std::size_t tile_width) const;

  std::string tile_url(const wmts_tile_coordinate& tile) const;

  std::string tile_url_for_bbox(
      double min_x, double min_y, double max_x, double max_y,
      std::size_t tile_width) const;

private:
  int closest_level(double units_per_pixel,
                    std::size_t tile_width) const;
  std::string endpoint_for_tile(const wmts_tile_coordinate& tile) const;

private:
  std::string endpoint_;
  std::string layer_;
  std::string style_;
  std::string format_;
  std::string matrix_set_;
  int matrix_level_offset_;
  int max_level_;
  int subdomain_count_;
  std::string token_parameter_;
  std::string token_;
};

}  // namespace base
}  // namespace geo
}  // namespace vic

#endif
