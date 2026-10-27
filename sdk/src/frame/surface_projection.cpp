#include <terra/frame/surface_projection.hpp>
#include "surface_measurement_cursor.hpp"

#include <algorithm>
#include <cmath>
#include <new>
#include <type_traits>
#include <utility>

namespace terra {
namespace frame {
using namespace surface_detail;
namespace {
constexpr auto complete = surface_projection_status::complete;
constexpr std::size_t maximum_rows = 1048576U;
}

struct surface_projection_work::state {
  sample_cache cache;
  projected_triangle projected;
  measurement_region row;
  measurement_cursor* full = nullptr;
  std::size_t cursor = 0U, rows = 0U, fan = 0U;
  measurement_region* input = nullptr;
  core::payload_budget::credit input_credit,compaction_credit;
  typename std::aligned_storage<sizeof(region_compaction_work),alignof(region_compaction_work)>::type compaction_storage;
  bool compaction_live = false;
  region_compaction_work* compactor() {return reinterpret_cast<region_compaction_work*>(&compaction_storage);}
  const region_compaction_work* compactor() const {return reinterpret_cast<const region_compaction_work*>(&compaction_storage);}
  static std::size_t cursor_offset(){return (sizeof(state)+alignof(measurement_cursor)-1U)/alignof(measurement_cursor)*alignof(measurement_cursor);}
  static std::size_t bytes(bool model){return model?cursor_offset()+sizeof(measurement_cursor):sizeof(state);}
  ~state() {
    if(compaction_live)compactor()->~region_compaction_work();
    // Semantic rows are trivially destructible; there is no unbounded element
    // destruction loop or materialized full output. Free storage before credit.
    static_assert(std::is_trivially_destructible<measurement_region>::value,"Row lifetime needs explicit disposal");
    ::operator delete(input); input_credit.clear(); compaction_credit.clear();
    if(full)full->~measurement_cursor();
  }
  bool project(const surface_source& source,const surface_triangle_view& triangles,
               const triangle_projection_context& projection) {
    triangle_projection_input input;
    return cache.triangle(source,triangles.indices+cursor*3U,input)&&project_imagery_triangle(projection,input,projected);
  }
  bool visible() const {
    return projected.vertex_count>=3U&&projected.bounds[2]>projected.bounds[0]&&projected.bounds[3]>projected.bounds[1];
  }
};

surface_projection_work::surface_projection_work(surface_source source,surface_triangle_view triangles,
    triangle_projection_context projection,core::payload_budget budget)
    :source_(std::move(source)),triangles_(std::move(triangles)),projection_(std::move(projection)),budget_(std::move(budget)) {
  if(!source_.valid()||!valid_triangle_projection_context(projection_)||projection_.origin!=source_.origin()||
      triangles_.count%3U||(triangles_.count&&!triangles_.indices)||triangles_.count/3U>maximum_rows)
    status_=surface_projection_status::invalid_input;
}
surface_projection_work::surface_projection_work(surface_model model,triangle_projection_context projection,
    core::payload_budget budget,surface_measurement_options options)
    :source_(model?model.source():surface_source()),model_(std::move(model)),options_(std::move(options)),
      projection_(std::move(projection)),budget_(std::move(budget)) {
  if(!model_||!source_.valid()||!valid_triangle_projection_context(projection_)||
      projection_.origin!=source_.origin()||options_.domains.count>256U||
      (options_.domains.count&&!options_.domains.codes))status_=surface_projection_status::invalid_input;
}
surface_projection_work::~surface_projection_work(){cancel();}
void surface_projection_work::state_deleter::operator()(state* p)const{if(p){p->~state();::operator delete(p);}}

surface_projection_progress surface_projection_work::progress(std::size_t operations) const {
  surface_projection_progress out;out.status=status_;out.operations=operations;out.total_operations=total_operations_;
  out.raw_count=raw_count_;
  if(status_==surface_projection_status::waiting_for_workspace)out.required_work_bytes=state::bytes(bool(model_));
  if(status_==surface_projection_status::waiting_for_subdivision)out.required_work_bytes=state_->full->required_bytes();
  if(status_==surface_projection_status::waiting_for_regions)
    out.required_work_bytes=raw_count_*sizeof(measurement_region)+region_compaction_work::work_bytes(raw_count_,projective_count_);
  if(status_==complete&&state_&&state_->compaction_live)out.output_count=state_->compactor()->step(0U).output_count;
  return out;
}
bool surface_projection_work::admit() {
  const auto bytes=progress(0U).required_work_bytes;if(!bytes)return false;
  core::payload_budget::credit credit;if(!budget_.reserve(bytes,credit))return false;
  return admit(credit);
}
bool surface_projection_work::admit(core::payload_budget::credit& credit) {
  const auto bytes=progress(0U).required_work_bytes;
  if(!bytes||!credit.is_work_credit()||!credit.belongs_to(budget_)||credit.bytes()!=bytes)return false;
  if(status_==surface_projection_status::waiting_for_workspace) {
    void* allocation=::operator new(bytes,std::nothrow);
    if(!allocation){status_=surface_projection_status::allocation_failed;return false;}
    state_.reset(::new(allocation) state);state_credit_=std::move(credit);
    if(model_)state_->full=::new(static_cast<void*>(static_cast<unsigned char*>(allocation)+state::cursor_offset()))
      measurement_cursor(model_,options_,projection_,budget_);
    status_=surface_projection_status::counting;return true;
  }
  if(status_==surface_projection_status::waiting_for_subdivision) {
    if(!state_->full->admit(credit)){status_=surface_projection_status::allocation_failed;return false;}
    status_=surface_projection_status::counting;return true;
  }
  void* allocation=::operator new(raw_count_*sizeof(measurement_region),std::nothrow);
  if(!allocation){status_=surface_projection_status::allocation_failed;return false;}
  state_->input=static_cast<measurement_region*>(allocation);
  // Both destinations were authorized together before raw production. Splitting
  // a grant cannot expose a temporary refund or require double reservation.
  const auto compaction_bytes=region_compaction_work::work_bytes(raw_count_,projective_count_);
  if(!budget_.split_work(credit,compaction_bytes,state_->compaction_credit)) {
    ::operator delete(state_->input);state_->input=nullptr;status_=surface_projection_status::internal_error;return false;
  }
  state_->input_credit=std::move(credit);state_->cursor=state_->rows=state_->fan=0U;
  if(state_->full)state_->full->fill();
  status_=surface_projection_status::generating;return true;
}

surface_projection_progress surface_projection_work::step(std::size_t maximum_operations,double window) {
  if(!maximum_operations||!std::isfinite(window)||window<0.0)return progress(0U);
  if(status_!=surface_projection_status::counting&&status_!=surface_projection_status::generating&&
      status_!=surface_projection_status::compacting)return progress(0U);
  const auto start=window>0.0?clock_ms():0.0;
  std::size_t operations=0U;
  while(operations<maximum_operations) {
    auto& s=*state_;
    if(status_==surface_projection_status::counting) {
      if(s.full) {
        const auto event=s.full->next(nullptr,s.cache);
        if(event==measurement_event::scalar||event==measurement_event::projective) {
          if(raw_count_==maximum_rows){status_=surface_projection_status::resource_limit;break;}
          ++raw_count_;if(event==measurement_event::projective)++projective_count_;
        }else if(event==measurement_event::capacity)status_=surface_projection_status::waiting_for_subdivision;
        else if(event==measurement_event::invalid)status_=surface_projection_status::invalid_input;
        else if(event==measurement_event::complete){summary_=s.full->summary();status_=raw_count_?surface_projection_status::waiting_for_regions:complete;}
      }else {
      if(s.cursor==triangles_.count/3U) {
        status_=raw_count_?surface_projection_status::waiting_for_regions:complete;break;
      }
      if(!s.project(source_,triangles_,projection_)){status_=surface_projection_status::source_unavailable;break;}
      ++s.cursor;
      const auto& p=s.projected;
      if(p.vertex_count>=3U)summary_.center_distance=minimum(summary_.center_distance,p.center_distance);
      if(s.visible()) {
        if(std::isnan(p.pixels_per_uv)){status_=surface_projection_status::invalid_input;break;}
        const auto rows=p.vertex_count-2U;
        if(rows>maximum_rows-raw_count_){status_=surface_projection_status::resource_limit;break;}
        if(!summary_.visible) {
          summary_.uv.minimum={{p.bounds[0],p.bounds[1]}};summary_.uv.maximum={{p.bounds[2],p.bounds[3]}};
        }else for(std::size_t axis=0U;axis<2U;++axis) {
          summary_.uv.minimum[axis]=minimum(summary_.uv.minimum[axis],p.bounds[axis]);
          summary_.uv.maximum[axis]=maximum(summary_.uv.maximum[axis],p.bounds[axis+2U]);
        }
        summary_.visible=true;summary_.pixels_per_uv=maximum(summary_.pixels_per_uv,p.pixels_per_uv);raw_count_+=rows;projective_count_+=rows;
      }
      }
    }else if(status_==surface_projection_status::generating) {
      bool finished=false;
      if(s.full) {
        const auto event=s.full->next(&s.row,s.cache);
        if(event==measurement_event::scalar||event==measurement_event::projective) {
          if(s.rows==raw_count_){status_=surface_projection_status::internal_error;break;}
          construct(s.input+s.rows++,s.row);
        }else if(event==measurement_event::complete)finished=true;
        else if(event!=measurement_event::progress){status_=surface_projection_status::internal_error;break;}
      }else if(s.fan) {
        if(s.rows==raw_count_){status_=surface_projection_status::internal_error;break;}
        auto* row=::new(static_cast<void*>(s.input+s.rows++)) measurement_region;
        row->flags=3U;auto& r=row->value;const auto& p=s.projected;
        r.triangle={{p.polygon[0],p.polygon[s.fan],p.polygon[s.fan+1U]}};
        r.projection=p.projection;r.pixels_per_uv=p.pixels_per_uv;
        r.uv.minimum=r.uv.maximum=r.triangle[0];
        for(std::size_t i=1U;i<3U;++i)for(std::size_t axis=0U;axis<2U;++axis) {
          r.uv.minimum[axis]=minimum(r.uv.minimum[axis],r.triangle[i][axis]);
          r.uv.maximum[axis]=maximum(r.uv.maximum[axis],r.triangle[i][axis]);
        }
        if(++s.fan+1U==p.vertex_count)s.fan=0U;
      }else if(s.cursor==triangles_.count/3U) {
        finished=true;
      }else {
        if(!s.project(source_,triangles_,projection_)){status_=surface_projection_status::source_unavailable;break;}
        ++s.cursor;if(s.visible())s.fan=1U;
      }
      if(finished) {
        if(s.rows!=raw_count_){status_=surface_projection_status::internal_error;break;}
        ::new(static_cast<void*>(&s.compaction_storage)) region_compaction_work({{},s.input,s.rows},budget_);
        s.compaction_live=true;status_=surface_projection_status::compacting;
      }
    }else if(status_==surface_projection_status::compacting) {
      const auto remaining=window>0.0?window-(clock_ms()-start):0.0;
      if(window>0.0&&remaining<=0.0)break;
      const auto p=s.compactor()->step(maximum_operations-operations,remaining);
      operations+=p.operations;
      if(p.status==region_compaction_status::waiting_for_capacity) {
        if(operations==maximum_operations)break;
        ++operations;
        if(!s.compactor()->admit(s.compaction_credit)) {
          status_=s.compactor()->step(0U).status==region_compaction_status::allocation_failed
            ?surface_projection_status::allocation_failed:surface_projection_status::internal_error;
        }
      }else if(p.status==region_compaction_status::complete)status_=complete;
      else if(p.status!=region_compaction_status::validating&&p.status!=region_compaction_status::running)
        status_=surface_projection_status::internal_error;
      if(status_==complete||status_==surface_projection_status::internal_error||
          status_==surface_projection_status::allocation_failed||
          (window>0.0&&clock_ms()-start>=window))break;
      continue;
    }else break;
    ++operations;
    if(window>0.0&&operations%64U==0U&&clock_ms()-start>=window)break;
  }
  total_operations_+=operations;return progress(operations);
}
std::size_t surface_projection_work::allocated_bytes() const {
  return state_?state::bytes(bool(model_))+(state_->full?state_->full->allocated_bytes():0U)+state_->input_credit.bytes()+
    (state_->compaction_live?state_->compactor()->allocated_bytes():0U):0U;
}
std::size_t surface_projection_work::authorized_bytes() const {
  return allocated_bytes()+(state_?state_->compaction_credit.bytes():0U);
}
bool surface_projection_work::read(std::size_t first,measurement_region* output,std::size_t capacity,std::size_t& count) const {
  count=0U;if(status_!=complete)return false;
  if(state_->compaction_live)return state_->compactor()->read(first,output,capacity,count);
  return !first&&capacity<=256U&&(!capacity||output);
}
void surface_projection_work::cancel() {
  status_=surface_projection_status::cancelled;state_.reset();state_credit_.clear();
  triangles_=surface_triangle_view();options_=surface_measurement_options();source_=surface_source();model_=surface_model();
}

} // namespace frame
} // namespace terra
