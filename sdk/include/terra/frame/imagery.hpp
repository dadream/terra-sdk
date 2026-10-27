#ifndef TERRA_FRAME_IMAGERY_HPP
#define TERRA_FRAME_IMAGERY_HPP

#include <terra/core/types.hpp>
#include <terra/imagery/model.hpp>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace terra {
namespace frame {

struct imagery_region {
  core::bounds2d uv;
  double pixels_per_uv = 0.0;
  // X(u,v), Y(u,v), W(u,v), with X/Y scaled to screen pixels. A positive
  // W at the triangle enables node-local projective error evaluation.
  std::array<double, 9> projection{{}};
  std::array<core::vector2d, 3> triangle{{}};
  // Nonnegative: projection[6..8] is a lower depth envelope over uv, and this
  // is an upper spectral norm of all derivative numerators in the region.
  double numerator_bound = -1.0;
};

// One semantic row from measurement through input normalization and planning.
// Presence is explicit: an absent projection differs from a zero matrix.
struct measurement_region {
  imagery_region value;
  std::uint32_t flags=0U; // projection=1, triangle=2, numerator_bound=4
  std::uint32_t domain=UINT32_MAX;
};
bool valid_measurement_region(const measurement_region& region);
double imagery_region_error(const measurement_region& region, const core::bounds2d& cell);

class imagery_surface_input;
class imagery_input_work;

struct imagery_surface {
  std::uint32_t draw_index = 0U;
  imagery::node_key source;
  std::vector<measurement_region> regions;
  std::vector<core::vector2d> hull;
  // An opaque immutable measurement input retained from this controller.
  // Only draw_index is rebound; regions/hull must be empty and source is
  // restored from the retained input.
  std::shared_ptr<const imagery_surface_input> retained_input;
};

struct imagery_budget {
  double requested_pixel_error = 1.25;
  std::uint32_t tile_size = 256U;
  std::uint32_t maximum_level = 17U;
  std::size_t maximum_texture_count = 214U;
  std::size_t maximum_draw_count = 1024U;
  // The adapter supplies opaque physical identities. Several internal nodes
  // may share one image; topology and draw budgets still count their own nodes.
  std::function<std::string(const imagery::node_key&, double)> resource_key;
};

struct imagery_draw {
  std::uint32_t draw_index = 0U;
  imagery::node_key tile;
  double pixel_error = 0.0;
};

struct imagery_cut {
  // A valid planning state; rebuilding can still have no publishable draws.
  bool complete = false;
  bool decisions_complete = false;
  // Input normalization (no draws), temporary root coverage while restoring a
  // measured, budget-valid cut, or a pending coarsen/refine exchange.
  // Keep the consumer's existing demand until rebuilding is false.
  bool rebuilding = false;
  // No new snapshot has been published: retain the previous output and fund
  // output_work_bytes() before resuming. Topology waits at this boundary.
  bool output_pending = false;
  std::size_t change_count = 0U;
  std::size_t priority_update_count = 0U;
  std::size_t pending_refinement_count = 0U;
  bool limited_by_texture_budget = false;
  bool limited_by_draw_budget = false;
  bool limited_by_level = false;
  bool limited_by_partition_budget = false;
  double requested_pixel_error = 1.25;
  double feasible_pixel_error = 1.25;
  double maximum_pixel_error = 0.0;
  std::size_t selected_texture_count = 0U;
  std::size_t cached_node_count = 0U;
  // Immutable output; unchanged cuts share identity across progress updates.
  // A retained snapshot remains valid after begin, clear or owner destruction.
  std::shared_ptr<const std::vector<imagery_draw>> draws;
};

// Terrain fragments contribute measurements to one spatial imagery cut.
// Persistent nodes and split history are independent of terrain topology.
struct imagery_reclaim_progress {
  std::size_t released_bytes = 0U, visited = 0U;
  bool pending = false;
};

class imagery_controller {
 public:
  imagery_controller();
  ~imagery_controller();
  imagery_controller(const imagery_controller&) = delete;
  imagery_controller& operator=(const imagery_controller&) = delete;
  void clear();
  // Owned allocation payload (including retained output snapshots), excluding
  // allocator bookkeeping, the fixed account control block and the caller's
  // opaque resource-key callback.
  std::size_t allocated_bytes() const;
  std::size_t input_allocated_bytes() const;
  // Region-index capacity is a subset of allocated_bytes(). A step's grant
  // covers gross new allocations, including transient old/new overlap. On a
  // shortage reference_work_bytes() quotes the next allocation and the cursor
  // stays at its unconsumed region. Other metadata is not bounded by this grant.
  std::size_t reference_allocated_bytes() const;
  std::size_t reference_work_bytes() const;
  std::size_t output_allocated_bytes() const;
  std::size_t output_work_bytes() const;
  // Consumed/stale indices can retire without reconstructing pending work.
  // Current and queued child inputs stay pinned. Visits bound both
  // empty-node scans and individual reference releases; no new cache is made.
  imagery_reclaim_progress reclaim_references(std::size_t needed_bytes,
      std::size_t maximum_visits, bool restart);
  std::size_t peak_allocated_bytes() const;
  // Includes member storage, its identity-registry envelope, and each new
  // input's ownership metadata and numeric payload. Retained inputs keep their
  // existing charge; cancellation or a new cut cannot refund them while another
  // member still holds them.
  static std::uint64_t input_work_bytes(std::size_t members, std::size_t new_inputs,
                                    std::size_t regions, std::size_t hull_points);
  // Build fresh canonical inputs in their final owner. Admission covers gross
  // new state, payload and member/registry overlap before allocation. Refusal
  // leaves the transaction and existing planner unchanged.
  bool stage_input(imagery_input_work& work,std::size_t members,std::size_t new_inputs,
                   std::size_t regions,std::size_t hull_points,std::uint64_t maximum_work_bytes);
  bool commit_input(imagery_input_work&& work,const imagery_budget& budget);
  // Returns no handle for a missing or ambiguous draw index. Handles survive
  // clear and cancellation, but cannot be passed to a different controller.
  std::shared_ptr<const imagery_surface_input> retain_surface(std::uint32_t draw_index) const;
  // Region/hull counts of an opaque input, for adapter shape validation.
  static std::pair<std::size_t, std::size_t> input_shape(
      const std::shared_ptr<const imagery_surface_input>& input);
  // Read the normalized immutable snapshot through its real loan. Pending
  // normalization and invalid ranges write nothing; output is bounded to256.
  static bool read_input(const std::shared_ptr<const imagery_surface_input>& input,
      std::size_t first,measurement_region* output,std::size_t capacity,std::size_t& count);
  static bool read_input_hull(const std::shared_ptr<const imagery_surface_input>& input,
      std::size_t first,core::vector2d* output,std::size_t capacity,std::size_t& count);
  // Own the measurement snapshot. Callers retaining their input pass an lvalue;
  // adapters with a converted snapshot transfer it without another region copy.
  // Root grouping, region validation/normalization and child measurement run
  // in update_step. One priority credit visits at most 64 regions/hull edges
  // or bookkeeping boundaries (including empty surfaces); child preparation
  // keeps the parent cut until its complete split is measured and admitted.
  // begin validates surface metadata and budgets, not individual regions.
  // Invalid regions or an excessive source-resource base budget return an
  // incomplete cut from update_step. Retain prior demand while rebuilding.
  // Input accounting, container lifetimes and callbacks are not preemptible;
  // the work allowance is not a hard wall-clock deadline for the whole call.
  bool begin(std::vector<imagery_surface> surfaces,
             const imagery_budget& budget);
  imagery_cut update_step(std::size_t maximum_changes,
                          std::size_t maximum_priorities,
                          double maximum_milliseconds,
                          std::size_t maximum_reference_work_bytes = std::size_t(-1),
                          std::size_t maximum_output_work_bytes = std::size_t(-1));
  bool accept_cut(const std::vector<imagery::node_key>& tiles,
                  std::uint64_t admission_revision);
  imagery_cut plan(std::vector<imagery_surface> surfaces,
                   const imagery_budget& budget);

 private:
  struct memory;
  std::shared_ptr<memory> memory_;
  struct implementation;
  std::unique_ptr<implementation> implementation_;
};

}  // namespace frame
}  // namespace terra

#endif
