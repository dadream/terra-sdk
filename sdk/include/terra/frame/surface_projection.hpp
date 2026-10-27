#ifndef TERRA_FRAME_SURFACE_PROJECTION_HPP
#define TERRA_FRAME_SURFACE_PROJECTION_HPP

#include <terra/frame/region_compaction.hpp>
#include <terra/frame/surface_source.hpp>
#include <terra/frame/surface_model.hpp>
#include <terra/frame/triangle_projection.hpp>

#include <limits>

namespace terra {
namespace frame {

// Selected, ordered exact triangles, not a renderer strip. Caller owns/charges
// this immutable layout. An optional owner retains the underlying native loan.
struct surface_triangle_view {
  std::shared_ptr<const void> owner;
  const std::uint16_t* indices = nullptr;
  std::size_t count = 0U;
};
struct surface_domain_view {
  // Already-owned immutable provenance for this exact model. A root uses
  // root*21; child c uses +1+c*5; grandchild g uses +2+c*5+g. Empty selects all.
  // Codes use dense nonempty-child ordinals; overlapping selections are invalid.
  std::shared_ptr<const void> owner;
  const std::uint32_t* codes=nullptr;
  std::size_t count=0U;
};
struct surface_measurement_options {
  bool tight=false,bounds_only=false;
  surface_domain_view domains;
};

enum class surface_projection_status {
  waiting_for_workspace, counting, waiting_for_regions, generating, compacting,
  complete, cancelled, invalid_input, source_unavailable, allocation_failed,
  internal_error, resource_limit, waiting_for_subdivision
};

struct surface_projection_summary {
  core::bounds2d uv;
  double pixels_per_uv = 0.0;
  double center_distance = std::numeric_limits<double>::infinity();
  bool visible = false;
  bool refinable = false;
};

struct surface_projection_progress {
  surface_projection_status status = surface_projection_status::waiting_for_workspace;
  std::size_t operations = 0U, required_work_bytes = 0U;
  std::uint64_t total_operations = 0U;
  std::size_t raw_count = 0U, output_count = 0U;
};

// Counts actual scalar/clipped fan rows, reserves raw rows and compaction
// together, constructs rows in bounded steps and feeds their immutable view
// directly to the compactor. Whole-model measurement preserves shallow bounds
// and lazily funds difficult two-level domains; selected exact faces skip that
// selection stage. Waiting requires explicit admission, never polling.
class surface_projection_work {
 public:
  surface_projection_work(surface_source source, surface_triangle_view triangles,
                          triangle_projection_context projection, core::payload_budget budget);
  // Whole immutable model: shallow bounds and selected difficult domains feed
  // the same raw-region/compaction producer as explicitly selected exact faces.
  surface_projection_work(surface_model model,triangle_projection_context projection,
                          core::payload_budget budget,surface_measurement_options options={});
  ~surface_projection_work();
  surface_projection_work(const surface_projection_work&) = delete;
  surface_projection_work& operator=(const surface_projection_work&) = delete;
  surface_projection_progress step(std::size_t maximum_operations,
                                   double maximum_milliseconds = 0.0);
  // Explicitly fund the reported stage. Refusal never consumes caller credit.
  bool admit();
  bool admit(core::payload_budget::credit& authorized);
  std::size_t allocated_bytes() const;
  std::size_t authorized_bytes() const;
  bool read(std::size_t first, measurement_region* output, std::size_t capacity,
            std::size_t& count) const;
  const surface_projection_summary& summary() const { return summary_; }
  void cancel();
 private:
  struct state;
  struct state_deleter {void operator()(state*) const;};
  surface_source source_;
  surface_model model_;
  surface_measurement_options options_;
  surface_triangle_view triangles_;
  triangle_projection_context projection_;
  core::payload_budget budget_;
  core::payload_budget::credit state_credit_;
  std::unique_ptr<state,state_deleter> state_;
  surface_projection_status status_ = surface_projection_status::waiting_for_workspace;
  surface_projection_summary summary_;
  std::size_t raw_count_ = 0U,projective_count_=0U;
  std::uint64_t total_operations_ = 0U;
  surface_projection_progress progress(std::size_t operations) const;
};

} // namespace frame
} // namespace terra
#endif
