#include <terra/imagery/model.hpp>

#include <cmath>

namespace terra {
namespace imagery {

bool node_key::is_valid() const {
  return level >= 0 && level <= 27 && row >= 0 && column >= 0 &&
      row < (2 << level) && column < (4 << level);
}

node_key node_key::parent() const {
  return level > 0 ? node_key(level - 1, row / 2, column / 2) : node_key();
}

node_key node_key::child(int y, int x) const {
  return is_valid() && level < 27 && (y == 0 || y == 1) && (x == 0 || x == 1)
      ? node_key(level + 1, row * 2 + y, column * 2 + x) : node_key();
}

int node_key::root(bool global) const {
  if (!is_valid()) return -1;
  const int scale = 1 << level;
  return (row / scale) * (global ? 4 : 1) + column / scale;
}

bool texture_model::contains(const node_key& node) const {
  if (!node.is_valid()) return false;
  const int scale = 1 << node.level;
  return node.column < (global ? 4 : 1) * scale &&
         node.row < (global ? 2 : 1) * scale;
}

core::bounds2d texture_model::bounds(const node_key& node) const {
  if (!contains(node)) return {};
  const double scale = std::ldexp(1.0, node.level);
  const double width = (extent.maximum[0] - extent.minimum[0]) / ((global ? 4 : 1) * scale);
  const double height = (extent.maximum[1] - extent.minimum[1]) / ((global ? 2 : 1) * scale);
  const double x = extent.minimum[0] + node.column * width;
  const double y = extent.maximum[1] - node.row * height;
  return {{{x, y - height}}, {{x + width, y}}};
}

node_key terrain_anchor(const core::grid_diamond& diamond,
                        unsigned geometry_level, unsigned fragment, bool global) {
  if (fragment > 1 || geometry_level / 2 > 27 || !diamond.is_valid()) return {};
  const auto point = geometry_level % 2 ? diamond.parent_id(fragment) : diamond.id();
  const int depth = static_cast<int>(geometry_level / 2);
  const int scale = 1 << depth;
  const double root = core::grid_coordinate_max;
  double x = 0.0, y = 0.0;
  if (global) {
    const auto half = core::grid_coordinate_max / 2;
    if (point[2] == half) x = (point[0] + double(half)) / root;
    else if (point[0] == half) x = 1.0 + (-point[2] + double(half)) / root;
    else if (point[2] == -half) x = 2.0 + (-point[0] + double(half)) / root;
    else if (point[0] == -half) x = 3.0 + (point[2] + double(half)) / root;
    else return {};
    y = (root - point[1]) / root;
  } else {
    x = (point[0] + root) / (2.0 * root);
    y = (root - point[1]) / (2.0 * root);
  }
  const node_key result(depth, static_cast<int>(std::floor(y * scale)),
                       static_cast<int>(std::floor(x * scale)));
  texture_model model;
  model.global = global;
  return model.contains(result) ? result : node_key();
}

}  // namespace imagery
}  // namespace terra
