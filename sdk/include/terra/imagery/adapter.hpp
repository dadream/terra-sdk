#ifndef TERRA_IMAGERY_ADAPTER_HPP
#define TERRA_IMAGERY_ADAPTER_HPP

#include <terra/imagery/model.hpp>
#include <string>
#include <vector>

namespace terra {
namespace imagery {

struct source_matrix {
  std::string identifier;
  int columns = 0;
  int rows = 0;
};

struct source_descriptor {
  std::string id;
  core::bounds2d extent{{{-180.0, -90.0}}, {{180.0, 90.0}}};
  unsigned tile_size = 256;
  bool top_left = true;
  std::vector<source_matrix> matrices;
};

struct resource_key {
  std::string source;
  std::string matrix;
  int level = -1;  // Local descriptor index, not the external identifier.
  int row = -1;
  int column = -1;
};

struct texture_binding {
  node_key node;
  resource_key resource;
  core::vector2d uv_scale{{1.0, 1.0}};
  core::vector2d uv_offset{{0.0, 0.0}};
  core::vector2d units_per_pixel{{0.0, 0.0}};
};

// Aligned grids only. URL construction/authentication live in the transport
// backend. Explicit matrix identifiers support both TMS and WMTS conventions.
bool bind_node(const texture_model& model, const node_key& node,
               const source_descriptor& source, int source_level,
               texture_binding& result);

}  // namespace imagery
}  // namespace terra
#endif
