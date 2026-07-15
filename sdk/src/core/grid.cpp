#include <terra/core/grid.hpp>

#include <cstdlib>
#include <limits>
#include <stdexcept>

namespace terra {
namespace core {
namespace {

grid_point invalid_grid_point() {
  const grid_value invalid = -(grid_value(1) << (grid_subdivision_bits + 1));
  return {{invalid, invalid, invalid}};
}

grid_value midpoint_component(grid_value left, grid_value right) {
  const std::int64_t sum =
      static_cast<std::int64_t>(left) + static_cast<std::int64_t>(right);
  if (sum >= 0) {
    return static_cast<grid_value>(sum / 2);
  }
  return static_cast<grid_value>(-((-sum + 1) / 2));
}

grid_point midpoint(const grid_point& left, const grid_point& right) {
  return {{midpoint_component(left[0], right[0]),
           midpoint_component(left[1], right[1]),
           midpoint_component(left[2], right[2])}};
}

[[noreturn]] void grid_overflow() {
#if defined(TERRA_SDK_NO_EXCEPTIONS)
  std::abort();
#else
  throw std::overflow_error("grid diamond child coordinate overflow");
#endif
}

[[noreturn]] void grid_index_error() {
#if defined(TERRA_SDK_NO_EXCEPTIONS)
  std::abort();
#else
  throw std::out_of_range("grid diamond child index must be zero or one");
#endif
}

grid_value checked_grid_value(std::int64_t value) {
  if (value < std::numeric_limits<grid_value>::min() ||
      value > std::numeric_limits<grid_value>::max()) {
    grid_overflow();
  }
  return static_cast<grid_value>(value);
}

grid_point add(const grid_point& left, const grid_point& right) {
  return {{checked_grid_value(static_cast<std::int64_t>(left[0]) + right[0]),
           checked_grid_value(static_cast<std::int64_t>(left[1]) + right[1]),
           checked_grid_value(static_cast<std::int64_t>(left[2]) + right[2])}};
}

grid_point subtract(const grid_point& left, const grid_point& right) {
  return {{checked_grid_value(static_cast<std::int64_t>(left[0]) - right[0]),
           checked_grid_value(static_cast<std::int64_t>(left[1]) - right[1]),
           checked_grid_value(static_cast<std::int64_t>(left[2]) - right[2])}};
}

grid_point canonical_point(std::size_t index) {
  const grid_value low = grid_coordinate_min;
  const grid_value high = grid_coordinate_max;
  const grid_point points[] = {
      {{low, low, high}},   {{low, high, high}},
      {{high, high, high}}, {{high, low, high}},
      {{low, low, low}},    {{low, high, low}},
      {{high, high, low}},  {{high, low, low}}};
  return points[index];
}

grid_point cylindrical_point(std::size_t index) {
  const grid_value low_y = grid_coordinate_min;
  const grid_value high_y = grid_coordinate_max;
  const grid_value low = low_y / 2;
  const grid_value high = high_y / 2;
  const grid_point points[] = {
      {{low, low_y, high}},   {{high, low_y, high}},
      {{low, 0, high}},       {{high, 0, high}},
      {{low, high_y, high}},  {{high, high_y, high}},
      {{low, low_y, low}},    {{high, low_y, low}},
      {{low, 0, low}},        {{high, 0, low}},
      {{low, high_y, low}},   {{high, high_y, low}}};
  return points[index];
}

}  // namespace

grid_diamond::grid_diamond()
    : corners_{{invalid_grid_point(), invalid_grid_point(),
                invalid_grid_point(), invalid_grid_point()}} {}

grid_diamond::grid_diamond(const grid_point& corner0,
                           const grid_point& corner1,
                           const grid_point& corner2,
                           const grid_point& corner3)
    : corners_{{corner0, corner1, corner2, corner3}} {}

bool grid_diamond::is_valid() const {
  const grid_point invalid = invalid_grid_point();
  return corners_[0] != invalid || corners_[2] != invalid;
}

const grid_point& grid_diamond::corner(std::size_t index) const {
  return corners_.at(index);
}

grid_point grid_diamond::id() const {
  return midpoint(corners_[0], corners_[2]);
}

grid_point grid_diamond::parent_id(std::size_t index) const {
  return corners_.at(1 + 2 * index);
}

grid_point grid_diamond::child_id(std::size_t parent_index,
                                  std::size_t child_index) const {
  if (parent_index > 1U || child_index > 1U) {
    grid_index_error();
  }
  const std::size_t corner_index = 2 * parent_index + child_index;
  const grid_point invalid = invalid_grid_point();
  if (corners_.at(corner_index) == invalid ||
      corners_.at((corner_index + 1) % 4) == invalid) {
    return invalid;
  }
  return midpoint(corners_[corner_index],
                  corners_[(corner_index + 1) % 4]);
}

grid_diamond grid_diamond::cylindrical_child_diamond(
    std::size_t parent_index, std::size_t child_index) const {
  const grid_point center = id();
  const grid_point child_center = child_id(parent_index, child_index);
  const grid_point other_corner =
      add(child_center, subtract(child_center, center));

  grid_diamond child;
  if (parent_index == 0U && child_index == 0U) {
    child = grid_diamond(corners_[1], center, corners_[0], other_corner);
  } else if (parent_index == 0U && child_index == 1U) {
    child = grid_diamond(corners_[1], other_corner, corners_[2], center);
  } else if (parent_index == 1U && child_index == 0U) {
    child = grid_diamond(corners_[3], center, corners_[2], other_corner);
  } else {
    child = grid_diamond(corners_[3], other_corner, corners_[0], center);
  }

  const grid_value minimum = grid_coordinate_min / 2;
  const grid_value maximum = grid_coordinate_max / 2;
  std::array<grid_point, 2> external{{child.corner(1), child.corner(3)}};
  bool changed = false;
  for (grid_point& point : external) {
    for (std::size_t axis = 0U; axis < 3U; axis += 2U) {
      grid_value delta = 0;
      if (point[axis] < minimum) {
        delta = minimum - point[axis];
        point[axis] = minimum;
      } else if (point[axis] > maximum) {
        delta = point[axis] - maximum;
        point[axis] = maximum;
      }
      if (delta == 0) {
        continue;
      }
      const std::size_t other_axis = (axis + 2U) % 4U;
      if (point[other_axis] == maximum) {
        point[other_axis] -= delta;
      } else if (point[other_axis] == minimum) {
        point[other_axis] += delta;
      }
      changed = true;
      break;
    }
  }
  return changed
             ? grid_diamond(child.corner(0), external[0], child.corner(2),
                            external[1])
             : child;
}

grid_diamond planar_root() {
  static const std::size_t indices[] = {0, 1, 2, 3};
  return grid_diamond(canonical_point(indices[0]),
                      canonical_point(indices[1]),
                      canonical_point(indices[2]),
                      canonical_point(indices[3]));
}

std::array<grid_diamond, 8> cylindrical_roots() {
  static const std::size_t corner0[] = {2, 9, 9, 2, 2, 9, 9, 2};
  static const std::size_t corner1[] = {4, 3, 11, 8, 3, 7, 8, 0};
  static const std::size_t corner2[] = {5, 5, 10, 10, 1, 1, 6, 6};
  static const std::size_t corner3[] = {3, 11, 8, 4, 0, 3, 7, 8};

  std::array<grid_diamond, 8> roots;
  for (std::size_t i = 0; i < roots.size(); ++i) {
    roots[i] = grid_diamond(cylindrical_point(corner0[i]),
                            cylindrical_point(corner1[i]),
                            cylindrical_point(corner2[i]),
                            cylindrical_point(corner3[i]));
  }
  return roots;
}

}  // namespace core
}  // namespace terra
