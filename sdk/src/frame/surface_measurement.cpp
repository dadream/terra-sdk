#include <terra/frame/surface_measurement.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

#if defined(__EMSCRIPTEN__)
extern "C" double terra_monotonic_milliseconds();
#endif

namespace terra { namespace frame {
namespace {
double measurement_clock() {
#if defined(__EMSCRIPTEN__)
  return terra_monotonic_milliseconds();
#else
  return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
bool waiting(surface_projection_status s) {
  return s==surface_projection_status::waiting_for_workspace||s==surface_projection_status::waiting_for_regions||
    s==surface_projection_status::waiting_for_subdivision;
}
}

surface_measurement_work::surface_measurement_work(surface_model model,triangle_projection_context context,
    core::payload_budget budget,surface_measurement_options options,surface_measurement_previous previous)
    :model_(std::move(model)),context_(std::move(context)),budget_(std::move(budget)),options_(std::move(options)),
      previous_(std::move(previous)) {
  if(!model_){status_=surface_measurement_status::invalid_input;return;}
  if(previous_.input) {
    std::size_t count=0U;
    if(options_.bounds_only||options_.domains.count||std::isnan(previous_.projective_pixels_per_uv)||
        previous_.projective_pixels_per_uv<0.0||!imagery_controller::read_input(previous_.input,0U,nullptr,0U,count)) {
      status_=surface_measurement_status::invalid_input;return;
    }
    const auto shape=imagery_controller::input_shape(previous_.input);
    previous_count_=shape.first;hull_=shape.second;options_.tight=true;
    if(previous_count_){merging_=true;status_=surface_measurement_status::inspecting_previous;return;}
    previous_=surface_measurement_previous();
  }
  start_projection();
}
surface_measurement_work::~surface_measurement_work(){cancel();}
void surface_measurement_work::start_projection() {
  ::new(static_cast<void*>(&projection_storage_)) surface_projection_work(model_,context_,budget_,options_);
  projection_live_=true;options_=surface_measurement_options();
  status_=surface_measurement_status::waiting_for_work;
  required_=projection().step(0U).required_work_bytes;
}
void surface_measurement_work::retire_source() {
  if(projection_live_){projection().~surface_projection_work();projection_live_=false;}
  model_=surface_model();options_=surface_measurement_options();previous_.input.reset();
}
surface_measurement_progress surface_measurement_work::progress(std::size_t operations)const {
  const bool boundary=status_==surface_measurement_status::waiting_for_work||status_==surface_measurement_status::waiting_for_input;
  return {status_,operations,boundary?required_:0U,regions_,hull_,copied_,hull_copied_,normalized_};
}
bool surface_measurement_work::admit_work(core::payload_budget::credit& credit) {
  if(status_!=surface_measurement_status::waiting_for_work||!projection_live_)return false;
  if(!projection().admit(credit)) {
    if(projection().step(0U).status==surface_projection_status::allocation_failed)
      status_=surface_measurement_status::allocation_failed;
    return false;
  }
  status_=surface_measurement_status::measuring;required_=0U;return true;
}
bool surface_measurement_work::admit_input(imagery_controller& destination,const imagery::node_key& source,
    std::uint64_t maximum) {
  if(status_!=surface_measurement_status::waiting_for_input||maximum<required_)return false;
  imagery_input_work next;
  if(!destination.stage_input(next,1U,1U,regions_,hull_,maximum)||
      !next.append_surface(0U,source,regions_,hull_))return false;
  input_=std::move(next);status_=surface_measurement_status::copying;required_=0U;return true;
}
surface_measurement_progress surface_measurement_work::step(std::size_t maximum,double milliseconds) {
  using status=surface_measurement_status;
  std::size_t operations=0U;
  if(!std::isfinite(milliseconds)||milliseconds<0.0){status_=status::invalid_input;return progress(0U);}
  const auto start=milliseconds>0.0?measurement_clock():0.0;
  while(operations<maximum||status_==status::waiting_for_work) {
    const auto allowance=std::min(std::size_t(256),maximum-operations);
    if(status_==status::inspecting_previous) {
      std::array<measurement_region,256U> rows;std::size_t count=0U;
      const auto amount=std::min(allowance,previous_count_-inspected_);
      if(!imagery_controller::read_input(previous_.input,inspected_,rows.data(),amount,count)||count!=amount) {
        status_=status::invalid_input;break;
      }
      for(std::size_t i=0U;i<count;++i) {
        const auto& row=rows[i];
        if(row.flags&1U){++preserved_;continue;}
        if(row.domain>=selected_seen_.size()||selected_count_==selected_.size()||selected_seen_[row.domain]) {
          status_=status::invalid_input;break;
        }
        selected_seen_[row.domain]=true;selected_[selected_count_++]=row.domain;
      }
      inspected_+=count;operations+=count;
      if(status_==status::invalid_input)break;
      if(inspected_==previous_count_) {
        if(!selected_count_) {
          summary_=previous_.summary;summary_.refinable=false;
          projective_density_=previous_.projective_pixels_per_uv;
          regions_=normalized_=previous_count_;result_=std::move(previous_.input);
          retire_source();status_=status::complete;break;
        }
        options_.tight=true;options_.domains={{},selected_.data(),selected_count_};start_projection();
      }
    }else if(status_==status::waiting_for_work||status_==status::measuring) {
      const double remaining=milliseconds>0.0?std::max(1e-9,milliseconds-(measurement_clock()-start)):0.0;
      const auto p=projection().step(maximum-operations,remaining);operations+=p.operations;
      if(waiting(p.status)){status_=status::waiting_for_work;required_=p.required_work_bytes;}
      else if(p.status==surface_projection_status::complete) {
        summary_=projection().summary();new_regions_=p.output_count;regions_=new_regions_+preserved_;hull_=model_.layout().hull_count();
        if(merging_) {
          summary_.refinable=false;summary_.visible=preserved_>0U||summary_.visible;
          if(preserved_)summary_.uv=previous_.summary.uv;
          summary_.center_distance=std::min(previous_.summary.center_distance,summary_.center_distance);
        }
        const auto bytes=imagery_input_work::work_bytes(1U,1U,regions_,hull_);
        if(bytes==std::numeric_limits<std::uint64_t>::max()||bytes>std::numeric_limits<std::size_t>::max())status_=status::invalid_input;
        else {required_=std::size_t(bytes);status_=status::waiting_for_input;}
      }else if(p.status==surface_projection_status::allocation_failed)status_=status::allocation_failed;
      else if(p.status==surface_projection_status::invalid_input||p.status==surface_projection_status::source_unavailable)
        status_=status::invalid_input;
      else if(p.status==surface_projection_status::internal_error||p.status==surface_projection_status::resource_limit)
        status_=status::internal_error;
      break;
    }else if(status_==status::copying) {
      if(copied_<new_regions_) {
        std::array<measurement_region,256U> rows;std::size_t count=0U;
        const auto amount=std::min(allowance,new_regions_-copied_);
        if(!projection().read(copied_,rows.data(),amount,count)||count!=amount){status_=status::internal_error;break;}
        for(std::size_t i=0U;i<count;++i) {
          if(!input_.append_region(rows[i])){status_=status::internal_error;break;}
          measured_density_=std::max(measured_density_,rows[i].value.pixels_per_uv);
          if(rows[i].flags&1U)projective_density_=std::max(projective_density_,rows[i].value.pixels_per_uv);
        }
        copied_+=count;operations+=count;
      }else if(previous_copied_<previous_count_) {
        std::array<measurement_region,256U> rows;std::size_t count=0U;
        const auto amount=std::min(allowance,previous_count_-previous_copied_);
        if(!imagery_controller::read_input(previous_.input,previous_copied_,rows.data(),amount,count)||count!=amount) {
          status_=status::internal_error;break;
        }
        for(std::size_t i=0U;i<count;++i)if(rows[i].flags&1U) {
          if(!input_.append_region(rows[i])){status_=status::internal_error;break;}
          ++copied_;
        }
        previous_copied_+=count;operations+=count;
      }else if(hull_copied_<hull_) {
        const auto count=std::min(allowance,hull_-hull_copied_);
        if(!input_.append_hull(model_.layout(),hull_copied_,count)){status_=status::internal_error;break;}
        hull_copied_+=count;operations+=count;
      }else {
        if(copied_!=regions_){status_=status::internal_error;break;}
        if(merging_) {
          summary_.pixels_per_uv=std::max(measured_density_,previous_.projective_pixels_per_uv);
          projective_density_=std::max(projective_density_,previous_.projective_pixels_per_uv);
        }
        retire_source();status_=status::normalizing;++operations;
      }
    }else if(status_==status::normalizing) {
      std::size_t count=0U;
      if(!input_.normalize_surface(allowance,count)){status_=status::internal_error;break;}
      normalized_+=count;operations+=count;
      if(normalized_==regions_) {
        result_=input_.take_surface();status_=result_?status::complete:status::internal_error;
        if(!count)++operations;
      }
    }else break;
    if(milliseconds>0.0&&measurement_clock()-start>=milliseconds)break;
  }
  return progress(operations);
}
std::shared_ptr<const imagery_surface_input> surface_measurement_work::take_input() {
  if(status_!=surface_measurement_status::complete)return {};
  return std::move(result_);
}
void surface_measurement_work::cancel() {
  retire_source();input_.cancel();result_.reset();required_=0U;status_=surface_measurement_status::cancelled;
}
} }
