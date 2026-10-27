#ifndef TERRA_CORE_GRID_HPP
#define TERRA_CORE_GRID_HPP

#include <array>
#include <cstddef>
#include <cstdint>

namespace terra {
namespace core {

using grid_value = std::int32_t;
using grid_point = std::array<grid_value, 3>;

constexpr std::uint32_t grid_subdivision_bits = 28;
constexpr grid_value grid_coordinate_max =
    grid_value(1) << grid_subdivision_bits;
constexpr grid_value grid_coordinate_min = -grid_coordinate_max;

class grid_diamond {
 public:
  grid_diamond();
  grid_diamond(const grid_point& corner0, const grid_point& corner1,
               const grid_point& corner2, const grid_point& corner3);

  bool is_valid() const;
  const grid_point& corner(std::size_t index) const;
  grid_point id() const;
  grid_point parent_id(std::size_t index) const;
  grid_point child_id(std::size_t parent_index,
                      std::size_t child_index) const;
  grid_diamond planar_child_diamond(std::size_t parent_index,
                                    std::size_t child_index) const;
  grid_diamond cylindrical_child_diamond(std::size_t parent_index,
                                         std::size_t child_index) const;

 private:
  std::array<grid_point, 4> corners_;
};

grid_diamond planar_root();
std::array<grid_diamond, 8> cylindrical_roots();

}  // namespace core
}  // namespace terra

#endif  // TERRA_CORE_GRID_HPP
