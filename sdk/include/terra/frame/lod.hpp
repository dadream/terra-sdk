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
  std::array<core::grid_point, 4> corners{{}};
  std::uint8_t fragment_mask = 0U;

  bool has_fragment(std::size_t fragment) const {
    return fragment < 2U &&
           (fragment_mask & (std::uint8_t(1U) << fragment)) != 0U;
  }
};

enum class lod_record_kind : std::uint8_t {
  root = 1U,
  detail = 2U
};

struct lod_detail_key {
  std::size_t level = 0U;
  core::grid_point id{{0, 0, 0}};
};

struct lod_record_request {
  lod_record_kind kind = lod_record_kind::detail;
  lod_patch patch;
};

struct lod_cut {
  bool complete = false;
  std::size_t graph_level_count = 0U;
  std::vector<std::size_t> leaf_count_by_level;
  std::vector<lod_patch> patches;
  std::vector<lod_record_request> record_requests;
};

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level = 40U,
    std::size_t maximum_node_count = 65536U);

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level,
    std::size_t maximum_node_count,
    const std::vector<lod_detail_key>& unavailable_details);

lod_cut select_fixed_planar_lod(
    std::uint32_t patch_dimension, std::size_t target_level,
    std::size_t maximum_level = 12U,
    std::size_t maximum_node_count = 65536U);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_LOD_HPP
