#ifndef TERRA_IMAGERY_MODEL_HPP
#define TERRA_IMAGERY_MODEL_HPP

#include <terra/core/grid.hpp>
#include <terra/core/types.hpp>

namespace terra {
namespace imagery {

// Row/column are flattened coordinates in the INTERNAL root layout. They
// never identify a remote TileMatrix. Rows increase north to south.
struct node_key {
  int level = -1;
  int row = -1;
  int column = -1;
  node_key() = default;
  node_key(int depth, int y, int x) : level(depth), row(y), column(x) {}
  bool is_valid() const;
  node_key parent() const;
  node_key child(int y, int x) const;
  int root(bool global) const;
};

struct texture_model {
  bool global = true;
  core::bounds2d extent{{{-180.0, -90.0}}, {{180.0, 90.0}}};
  bool contains(const node_key& node) const;
  core::bounds2d bounds(const node_key& node) const;
};

// Fixed CBDAM correspondence. Odd diamonds select the covering even diamond
// through fragment 0/1; no imagery metadata or image data participates.
node_key terrain_anchor(const core::grid_diamond& diamond,
                        unsigned geometry_level, unsigned fragment,
                        bool global);

}  // namespace imagery
}  // namespace terra
#endif
