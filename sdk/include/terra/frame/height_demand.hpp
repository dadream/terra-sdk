#ifndef TERRA_FRAME_HEIGHT_DEMAND_HPP
#define TERRA_FRAME_HEIGHT_DEMAND_HPP

#include <terra/core/grid.hpp>
#include <terra/core/types.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace terra {
namespace frame {

struct height_demand_request {
  bool cylindrical = true;
  core::bounds2d bounds;
  double radius = 6378000.0;
  double u = 0.0, v = 0.0;
  // A horizontal sampling requirement, never a promise of vertical accuracy.
  double sample_spacing_metres = 30.0;
  std::uint32_t patch_dimension = 64U;
  std::uint32_t maximum_level = 39U;
  std::size_t maximum_node_count = 512U;
};

constexpr std::size_t no_height_parent = static_cast<std::size_t>(-1);

struct height_demand_parent {
  std::size_t index = no_height_parent;
  std::uint8_t fragment = 0U;
  std::uint8_t child = 0U;
};

struct height_demand_node {
  core::grid_diamond diamond;
  std::uint32_t level = 0U;
  std::uint8_t fragment_mask = 0U;
  // Roots need their root record. Only nodes used as parents need a detail
  // record. The target does not need its own residual to reconstruct its height.
  bool needs_detail = false;
  std::array<height_demand_parent, 2> parents;
};

struct height_demand_plan {
  // Parent-before-child order. A dependency shared by branches occurs once.
  std::vector<height_demand_node> nodes;
  std::size_t target = no_height_parent;
  std::uint8_t fragment = 0U;
  double sample_spacing_metres = 0.0;
  // Geometric reachability only; source availability/accuracy is still unknown.
  bool spacing_reached = false;
};

enum class height_demand_state {
  idle, working, ready, invalid_argument, resource_limit, invalid_topology
};

// Camera-independent CBDAM dependency planner. No I/O, terrain LOD mutation,
// decoded height arrays or render resources. Each work unit advances one grid
// level, resolves one parent, or emits one node; step(0) performs no work.
// plan() stays empty until completion. begin()/clear() release old work.
class height_demand_planner {
 public:
  height_demand_planner();
  ~height_demand_planner();
  height_demand_planner(const height_demand_planner&) = delete;
  height_demand_planner& operator=(const height_demand_planner&) = delete;

  height_demand_state begin(const height_demand_request& request);
  height_demand_state step(std::size_t maximum_work);
  void clear();
  height_demand_state state() const;
  const height_demand_plan& plan() const;
  std::size_t work_count() const;
  std::size_t node_count() const;

 private:
  struct implementation;
  std::unique_ptr<implementation> implementation_;
};

}  // namespace frame
}  // namespace terra
#endif
