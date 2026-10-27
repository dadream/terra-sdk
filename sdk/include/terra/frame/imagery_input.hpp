#ifndef TERRA_FRAME_IMAGERY_INPUT_HPP
#define TERRA_FRAME_IMAGERY_INPUT_HPP

#include <terra/frame/imagery.hpp>

namespace terra { namespace frame {
class surface_projection_work;
class surface_layout;

// One controller-owned construction transaction. Fresh rows go directly into
// the canonical input later retained by the planner, never a second staging
// vector. Published inputs and peer transactions stay independently owned.
class imagery_input_work {
 public:
  imagery_input_work();
  ~imagery_input_work();
  imagery_input_work(imagery_input_work&& other) noexcept;
  imagery_input_work& operator=(imagery_input_work&& other) noexcept;
  imagery_input_work(const imagery_input_work&)=delete;
  imagery_input_work& operator=(const imagery_input_work&)=delete;

  // Includes transaction state, member array, fresh canonical owners/payload,
  // and the planner's eventual member identity registry. Zero members need no
  // allocation. UINT64_MAX is an invalid shape. No allocation or hidden retry.
  static std::uint64_t work_bytes(std::size_t members,std::size_t fresh,
      std::size_t regions,std::size_t hull_points);
  bool active() const;
  bool failed() const;
  bool complete() const;
  bool has_member() const;
  std::size_t allocated_bytes() const;
  std::size_t remaining_regions() const;
  std::size_t remaining_hull() const;
  bool append_surface(std::uint32_t draw_index,const imagery::node_key& source,
                      std::size_t regions,std::size_t hull_points);
  bool append_retained(std::shared_ptr<const imagery_surface_input> input,std::uint32_t draw_index);
  bool append_region(const measurement_region& region);
  bool append_hull(const core::vector2d& point);
  // Direct same-side production: at most256 semantic rows/points, no ABI wire
  // or JS object reconstruction. The immutable producer/layout outlives call.
  bool append_regions(const surface_projection_work& source,std::size_t first,std::size_t count);
  bool append_hull(const surface_layout& source,std::size_t first,std::size_t count);
  // A producer may seal one fresh surface without replacing the controller's
  // displayed/planning cut. Normalize in bounded slices, then move the same
  // canonical owner into a loan accepted by this controller's later input.
  // No region-sized allocation or numeric copy is performed while taking it.
  bool normalize_surface(std::size_t maximum_regions,std::size_t& normalized);
  std::shared_ptr<const imagery_surface_input> take_surface();
  void invalidate();
  void cancel();
 private:
  friend class imagery_controller;
  struct state;
  struct state_deleter {void operator()(state*) const;};
  std::unique_ptr<state,state_deleter> state_;
  bool empty_=false;
};
} }
#endif
