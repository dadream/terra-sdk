#ifndef TERRA_FRAME_SURFACE_REPLACEMENT_HPP
#define TERRA_FRAME_SURFACE_REPLACEMENT_HPP

#include <terra/core/types.hpp>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace terra {
namespace frame {

struct replacement_point {
  std::int64_t u = 0, v = 0;
  core::vector3d world{{0.0, 0.0, 0.0}};
};
struct replacement_member {
  std::uint32_t group = 0U;
  std::uint32_t after = 0U;
  std::uint32_t resource_id = 0U;
};

// Inputs are triangle edge samples in cyclic perimeter order, not complete mesh
// arrays. Either winding is accepted. The caller retains their
// immutable source model until completion/cancellation. Each add handles one
// surface. step limits edge/event/active-edge/output operations, including
// equal-coordinate events and final grouping. Heap and union operations have
// logarithmic bounds; allocation and one surface's add are not timed by step.
// Cyclic edges share endpoint storage. Once input is sealed, one sweep workspace
// sized for its longest line is reused. All working storage belongs to this plan.
// No partial proof is exposed before completion.
class surface_replacement_plan {
 public:
  // surfaces counts output memberships. retained_surfaces each contribute two
  // memberships but only one immutable boundary to the working storage.
  static std::size_t payload_bound(std::size_t surfaces, std::size_t points_per_surface,
                                   std::size_t retained_surfaces = 0U);
  // Reuse a complete proof only when every displayed region is a whole before
  // or after group. Finished groups become resource identities. Invalid input
  // leaves rebased unchanged; this operation does not sample mesh boundaries.
  static bool rebase(const std::vector<replacement_member>& proof,
                     const std::vector<std::uint32_t>& displayed,
                     std::vector<replacement_member>& rebased);
  surface_replacement_plan(std::size_t surfaces, std::size_t points_per_surface,
                           bool global, std::size_t retained_surfaces = 0U);
  ~surface_replacement_plan();
  surface_replacement_plan(const surface_replacement_plan&) = delete;
  surface_replacement_plan& operator=(const surface_replacement_plan&) = delete;
  bool add(std::uint32_t resource_id, bool after, std::vector<replacement_point> points);
  // One immutable resource is present on both sides. Its edges participate in
  // both comparisons, but sampling/storage is shared. Output still owns both
  // memberships, including dependencies through an unchanged neighbour.
  bool retain(std::uint32_t resource_id, std::vector<replacement_point> points);
  bool step(std::size_t maximum_operations);
  std::size_t last_step_operations() const;
  bool valid() const;
  const std::vector<replacement_member>& members() const;
  std::vector<replacement_member> take_members();
 private:
  bool add_sides(std::uint32_t resource_id, std::uint8_t sides, std::vector<replacement_point> points);
  struct implementation;
  std::unique_ptr<implementation> impl_;
};

}  // namespace frame
}  // namespace terra
#endif
