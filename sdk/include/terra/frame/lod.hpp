#ifndef TERRA_FRAME_LOD_HPP
#define TERRA_FRAME_LOD_HPP

#include <terra/core/grid.hpp>
#include <terra/frame/camera.hpp>

#include <cstddef>
#include <cstdint>
#include <vector>

namespace terra {
namespace frame {

struct lod_patch {
  std::size_t level = 0U;
  core::grid_point id{{0, 0, 0}};
  bool visible = false;
  float priority = 0.0F;
};

struct lod_cut {
  bool complete = false;
  std::size_t graph_level_count = 0U;
  std::vector<std::size_t> leaf_count_by_level;
  std::vector<lod_patch> patches;
};

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level = 40U,
    std::size_t maximum_node_count = 65536U);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_LOD_HPP
