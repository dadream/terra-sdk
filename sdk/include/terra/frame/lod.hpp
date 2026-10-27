#ifndef TERRA_FRAME_LOD_HPP
#define TERRA_FRAME_LOD_HPP

#include <terra/core/grid.hpp>
#include <terra/frame/camera.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>
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
  bool converged = false;
  std::size_t change_count = 0U;
  std::size_t priority_update_count = 0U;
  std::size_t pending_priority_update_count = 0U;
  // Another bounded slice can resume interrupted work; waiting for records
  // alone does not exhaust a work budget, even if cut construction was slow.
  bool budget_exhausted = false;
  bool limited_by_capacity = false;
  float requested_threshold = 0.0F;
  float feasible_threshold = 0.0F;
  std::size_t node_count = 0U;
  std::size_t graph_level_count = 0U;
  std::vector<std::size_t> leaf_count_by_level;
  std::vector<lod_patch> patches;
  std::vector<lod_record_request> record_requests;
};

struct lod_height_range {
  // Reconstructed samples of this diamond's own mesh. Descendant relief is
  // not part of its coarse replacement's visibility/error interval.
  lod_detail_key key;
  double minimum = 0.0;
  double maximum = 0.0;
};

struct lod_resource_state {
  // A nonzero revision lets a resource owner avoid rebuilding the index on
  // unchanged steps. Zero retains compatibility with callers using vectors.
  std::uint64_t revision = 0U;
  std::vector<lod_detail_key> available_roots;
  std::vector<lod_detail_key> available_details;
  std::vector<lod_detail_key> unavailable_details;
  std::uint64_t height_revision = 0U;
  std::vector<lod_height_range> height_ranges;
};

struct lod_update_budget {
  std::size_t maximum_change_count = 32U;
  std::size_t maximum_priority_update_count = 256U;
  // Bound dependency discovery independently of this slice's topology credit.
  // A paused publication must retain the inputs its next slice still needs.
  // Zero disables speculative requests, not inputs of the selected surface.
  std::size_t maximum_request_frontier_count = 32U;
  // Zero disables the clock limit, allowing deterministic native/Wasm tests.
  double maximum_elapsed_milliseconds = 4.0;
  // Capacity limits admission of data-ready local splits, never the requested
  // error. Unmet demand survives until coarsening or a budget change frees space.
  std::size_t maximum_node_count = 0U;
  // Positions plus unique certified UV layouts, including persistent roots.
  // Old display cuts and production overlap have separate resource admission.
  std::size_t maximum_visible_mesh_bytes = 0U;
  std::size_t maximum_split_count = 0U;
  // Recover publication capacity without adding another refinement dependency.
  bool coarsening_only = false;
};

class cylindrical_lod_controller {
 public:
  cylindrical_lod_controller();
  ~cylindrical_lod_controller();

  cylindrical_lod_controller(const cylindrical_lod_controller&) = delete;
  cylindrical_lod_controller& operator=(
      const cylindrical_lod_controller&) = delete;

  void clear();
  void configure(double radius, std::uint32_t patch_dimension,
                 std::size_t maximum_level = 40U,
                 std::size_t maximum_node_count = 65536U);
  lod_cut update(float threshold, const camera_snapshot& camera,
                 const lod_resource_state& resources,
                 std::size_t maximum_change_count = 32U);
  lod_cut update_step(float threshold, const camera_snapshot& camera,
                      const lod_resource_state& resources,
                      const lod_update_budget& budget);

 private:
  struct implementation;
  std::unique_ptr<implementation> implementation_;
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
