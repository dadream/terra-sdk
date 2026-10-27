#ifndef TERRA_FRAME_SURFACE_MEASUREMENT_HPP
#define TERRA_FRAME_SURFACE_MEASUREMENT_HPP

#include <terra/frame/imagery_input.hpp>
#include <terra/frame/surface_projection.hpp>
#include <type_traits>

namespace terra { namespace frame {

enum class surface_measurement_status {
  inspecting_previous,waiting_for_work,measuring,waiting_for_input,copying,normalizing,complete,
  cancelled,invalid_input,allocation_failed,internal_error
};

// Complete canonical evidence for this same immutable geometry/view. The
// execution adapter validates that identity before supplying it. Only numeric
// input and summary are retained; no model or production scratch belongs here.
struct surface_measurement_previous {
  std::shared_ptr<const imagery_surface_input> input;
  surface_projection_summary summary;
  double projective_pixels_per_uv=0.0;
};
struct surface_measurement_progress {
  surface_measurement_status status=surface_measurement_status::waiting_for_work;
  std::size_t operations=0U,required_work_bytes=0U,region_count=0U,hull_count=0U;
  std::size_t copied_regions=0U,copied_hull=0U,normalized_regions=0U;
};

// One immutable model/view -> compacted projection -> final canonical input.
// Input admission uses its destination controller's account. Sealing never
// changes that controller's current cut. Production scratch and source/model
// loans retire before normalization/publication; the result owns only numbers.
class surface_measurement_work {
 public:
  surface_measurement_work(surface_model model,triangle_projection_context projection,
      core::payload_budget budget,surface_measurement_options options={},surface_measurement_previous previous={});
  ~surface_measurement_work();
  surface_measurement_work(const surface_measurement_work&)=delete;
  surface_measurement_work& operator=(const surface_measurement_work&)=delete;
  surface_measurement_progress step(std::size_t maximum_operations,double maximum_milliseconds=0.0);
  bool admit_work(core::payload_budget::credit& credit);
  bool admit_input(imagery_controller& destination,const imagery::node_key& source,
                   std::uint64_t maximum_work_bytes);
  const surface_projection_summary& summary()const{return summary_;}
  std::size_t allocated_work_bytes()const{return projection_live_?projection().authorized_bytes():0U;}
  double projective_pixels_per_uv()const{return projective_density_;}
  std::shared_ptr<const imagery_surface_input> take_input();
  void cancel();
 private:
  surface_measurement_progress progress(std::size_t operations)const;
  void start_projection();
  void retire_source();
  surface_projection_work& projection(){return *reinterpret_cast<surface_projection_work*>(&projection_storage_);}
  const surface_projection_work& projection()const{return *reinterpret_cast<const surface_projection_work*>(&projection_storage_);}
  surface_model model_;
  triangle_projection_context context_;
  core::payload_budget budget_;
  surface_measurement_options options_;
  surface_measurement_previous previous_;
  typename std::aligned_storage<sizeof(surface_projection_work),alignof(surface_projection_work)>::type projection_storage_;
  bool projection_live_=false,merging_=false;
  std::array<std::uint32_t,256U> selected_{};
  std::array<bool,336U> selected_seen_{};
  std::size_t selected_count_=0U,previous_count_=0U,inspected_=0U,preserved_=0U,previous_copied_=0U,new_regions_=0U;
  double measured_density_=0.0,projective_density_=0.0;
  imagery_input_work input_;
  std::shared_ptr<const imagery_surface_input> result_;
  surface_measurement_status status_=surface_measurement_status::waiting_for_work;
  surface_projection_summary summary_;
  std::size_t required_=0U,regions_=0U,hull_=0U,copied_=0U,hull_copied_=0U,normalized_=0U;
};

} }
#endif
