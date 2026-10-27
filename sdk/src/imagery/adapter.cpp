#include <terra/imagery/adapter.hpp>

#include <cmath>
#include <algorithm>

namespace terra {
namespace imagery {
bool bind_node(const texture_model& model, const node_key& node,
               const source_descriptor& source, int source_level,
               texture_binding& result) {
  result = {};
  if (!model.contains(node) || source.tile_size == 0 || source_level < 0 ||
      static_cast<std::size_t>(source_level) >= source.matrices.size()) return false;
  const auto& matrix = source.matrices[source_level];
  if (matrix.columns <= 0 || matrix.rows <= 0) return false;
  const auto bounds = model.bounds(node);
  const double width = (source.extent.maximum[0] - source.extent.minimum[0]) / matrix.columns;
  const double height = (source.extent.maximum[1] - source.extent.minimum[1]) / matrix.rows;
  if (!(width > 0.0) || !(height > 0.0) || !std::isfinite(width + height)) return false;
  const double column_value = std::floor((0.5 * (bounds.minimum[0] + bounds.maximum[0]) - source.extent.minimum[0]) / width);
  const double row_value = std::floor((source.extent.maximum[1] - 0.5 * (bounds.minimum[1] + bounds.maximum[1])) / height);
  // Check before narrowing: a disjoint/tiny source extent can overflow int.
  if (!(row_value >= 0 && row_value < matrix.rows &&
        column_value >= 0 && column_value < matrix.columns)) return false;
  const int column = static_cast<int>(column_value), row = static_cast<int>(row_value);
  const double x = source.extent.minimum[0] + column * width;
  const double y = source.extent.maximum[1] - row * height;
  const double epsilon = 1e-9 * std::max(width, height);
  if (bounds.minimum[0] < x - epsilon || bounds.maximum[0] > x + width + epsilon ||
      bounds.minimum[1] < y - height - epsilon || bounds.maximum[1] > y + epsilon) return false;
  result.node = node;
  result.resource = {source.id, matrix.identifier, source_level,
      source.top_left ? row : matrix.rows - 1 - row, column};
  result.uv_scale = {{(bounds.maximum[0] - bounds.minimum[0]) / width,
                      (bounds.maximum[1] - bounds.minimum[1]) / height}};
  result.uv_offset = {{(bounds.minimum[0] - x) / width, (y - bounds.maximum[1]) / height}};
  result.units_per_pixel = {{width / source.tile_size, height / source.tile_size}};
  return true;
}
}  // namespace imagery
}  // namespace terra
