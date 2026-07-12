#ifndef TERRA_CORE_WMTS_HPP
#define TERRA_CORE_WMTS_HPP

#include <terra/core/types.hpp>

#include <cstddef>

namespace terra {
namespace core {

struct wmts_tile_key {
  wmts_tile_key();
  wmts_tile_key(int level_value, int matrix_value,
                int row_value, int column_value);

  bool is_valid() const;

  int level;
  int matrix;
  int row;
  int column;
};

class global_geodetic_wmts_selector {
 public:
  global_geodetic_wmts_selector(int matrix_level_offset,
                                int maximum_level);

  bool is_valid() const;
  int matrix_level_offset() const;
  int maximum_level() const;

  wmts_tile_key select(const bounds2d& bounds,
                       std::size_t tile_width) const;
  int subdomain(const wmts_tile_key& tile,
                int subdomain_count) const;

 private:
  int closest_level(double units_per_pixel,
                    std::size_t tile_width) const;

  int matrix_level_offset_;
  int maximum_level_;
};

}  // namespace core
}  // namespace terra

#endif  // TERRA_CORE_WMTS_HPP
