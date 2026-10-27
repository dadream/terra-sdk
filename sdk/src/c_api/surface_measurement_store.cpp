#include "surface_measurement_store.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

namespace terra { namespace c_api_detail {
namespace {
template<class slots>std::uint32_t free_id(const slots& values,std::uint32_t& next) {
  for(std::size_t scanned=0U;scanned<values.size()&&next!=UINT32_MAX;++scanned) {
    const auto id=next++;
    if(!values[(id-1U)%values.size()])return id;
  }
  return 0U;
}
bool valid_step(std::uint32_t maximum,double milliseconds) {
  return maximum<=16384U&&std::isfinite(milliseconds)&&milliseconds>=0.0;
}
bool same_node(const imagery::node_key& a,const imagery::node_key& b) {
  return a.level==b.level&&a.row==b.row&&a.column==b.column;
}
static_assert(int(frame::surface_measurement_status::complete)==TERRA_SURFACE_MEASUREMENT_READY&&
    int(frame::surface_measurement_status::allocation_failed)==TERRA_SURFACE_MEASUREMENT_ALLOCATION_FAILED,
    "Core and C measurement phases differ");
void begin_output(terra_surface_work_v1& output,std::uint32_t id) {
  output={};output.struct_size=sizeof(output);output.api_version=TERRA_C_API_VERSION;output.id=id;
}
}
struct surface_measurement_store::model_record {
  std::uint32_t id,resource,plan,quote=1U;
  imagery::node_key anchor;
  frame::surface_model_work build;
  frame::surface_model value;
  core::payload_budget::credit charge;
  model_record(std::uint32_t key,std::uint32_t resource_id,std::uint32_t plan_id,imagery::node_key node,
      frame::surface_source source,core::payload_budget budget,frame::surface_layout layout)
      :id(key),resource(resource_id),plan(plan_id),anchor(node),build(std::move(source),std::move(budget),std::move(layout)){}
};
struct measurement_active {
  std::array<std::uint32_t,256U> domains{};
  frame::surface_measurement_work work;
  static frame::surface_measurement_options options(unsigned flags,const std::uint32_t* codes,std::uint32_t count) {
    frame::surface_measurement_options value;value.tight=bool(flags&1U);value.bounds_only=bool(flags&2U);
    value.domains={{},codes,count};return value;
  }
  measurement_active(frame::surface_model model,frame::triangle_projection_context projection,
      core::payload_budget budget,unsigned flags,const std::uint32_t* codes,std::uint32_t count,
      frame::surface_measurement_previous previous)
      :work(std::move(model),projection,std::move(budget),options(flags,domains.data(),count),std::move(previous)) {
    if(count)std::copy_n(codes,count,domains.begin());
  }
};
struct surface_measurement_store::measurement_record {
  std::uint32_t id=0U,session=0U,model=0U,resource=0U,plan=0U,view=0U,source=0U,quote=1U;
  imagery::node_key anchor;
  std::unique_ptr<measurement_active> active;
  std::shared_ptr<const frame::imagery_surface_input> value;
  terra_surface_work_v1 progress{};
  frame::surface_projection_summary summary;
  terra_surface_projection_v1 projection{};
  double projective_density=0.0;
  bool whole=false;
  core::payload_budget::credit charge;
};
template<class T>void surface_measurement_store::charged_delete<T>::operator()(T* value)const {
  if(!value)return;
  auto charge=std::move(value->charge);delete value;charge.clear();
}
surface_measurement_store::surface_measurement_store():budget_(UINT32_MAX){}
surface_measurement_store::~surface_measurement_store()=default;
std::uint32_t surface_measurement_store::model_bytes(){return sizeof(model_record);}
std::uint32_t surface_measurement_store::measurement_bytes(){return sizeof(measurement_record)+sizeof(measurement_active);}
std::size_t surface_measurement_store::allocated_bytes()const{return budget_.work_bytes()+budget_.resident_bytes();}
surface_measurement_store::model_record* surface_measurement_store::model(std::uint32_t id)const {
  if(!id)return nullptr;
  auto* value=models_[(id-1U)%models_.size()].get();return value&&value->id==id?value:nullptr;
}
surface_measurement_store::measurement_record* surface_measurement_store::measurement(std::uint32_t id)const {
  if(!id)return nullptr;
  auto* value=measurements_[(id-1U)%measurements_.size()].get();return value&&value->id==id?value:nullptr;
}
terra_status surface_measurement_store::open_model(frame::surface_source source,imagery::node_key anchor,
    std::uint32_t resource,std::uint32_t plan,std::uint32_t reuse,std::uint32_t maximum,std::uint32_t& id) {
  if(!source.valid()||!anchor.is_valid())return TERRA_STATUS_INVALID_ARGUMENT;
  const auto* previous=reuse?model(reuse):nullptr;
  if(reuse&&(!previous||!previous->value))return TERRA_STATUS_INVALID_STATE;
  if(maximum<model_bytes())return TERRA_STATUS_RESOURCE_LIMIT;
  const auto key=free_id(models_,next_model_);if(!key)return TERRA_STATUS_RESOURCE_LIMIT;
  core::payload_budget::credit credit;if(!budget_.reserve(model_bytes(),credit))return TERRA_STATUS_RESOURCE_LIMIT;
  auto* created=new(std::nothrow) model_record(key,resource,plan,anchor,std::move(source),budget_,
    previous?previous->value.layout():frame::surface_layout());
  if(!created)return TERRA_STATUS_RESOURCE_LIMIT;
  created->charge=std::move(credit);models_[(key-1U)%models_.size()].reset(created);id=key;return TERRA_STATUS_OK;
}
terra_status surface_measurement_store::step_model(std::uint32_t id,std::uint32_t maximum,double milliseconds,
    std::uint32_t quote,std::uint32_t grant,terra_surface_work_v1& output) {
  auto* record=model(id);if(!record)return TERRA_STATUS_INVALID_STATE;
  if(!valid_step(maximum,milliseconds))return TERRA_STATUS_INVALID_ARGUMENT;
  auto p=record->build.step(0U);
  if(grant) {
    if(!quote||quote!=record->quote)return TERRA_STATUS_INVALID_STATE;
    if(p.status!=frame::surface_model_status::waiting_for_capacity||grant<p.required_work_bytes)return TERRA_STATUS_RESOURCE_LIMIT;
    core::payload_budget::credit credit;
    if(!budget_.reserve(p.required_work_bytes,credit)||!record->build.admit(credit))return TERRA_STATUS_RESOURCE_LIMIT;
    ++record->quote;
  }else if(quote)return TERRA_STATUS_INVALID_ARGUMENT;
  p=record->build.step(maximum,milliseconds);
  if(p.status==frame::surface_model_status::complete&&!record->value)record->value=record->build.take_model();
  begin_output(output,id);output.phase=std::uint32_t(p.status);output.operations=p.operations;
  output.required_work_bytes=p.required_work_bytes;output.model_id=id;output.resource_id=record->resource;output.plan_id=record->plan;
  output.hull_count=record->value?record->value.layout().hull_count():0U;
  output.quote_id=p.required_work_bytes?record->quote:0U;
  return TERRA_STATUS_OK;
}
terra_status surface_measurement_store::open_measurement(std::uint32_t session,const terra_surface_projection_v1& request,
    const std::uint32_t* domains,std::uint32_t count,std::uint32_t maximum,std::uint32_t& id) {
  const auto* source=model(request.model_id);
  if(!source||!source->value)return TERRA_STATUS_INVALID_STATE;
  if(request.flags>3U||request.reserved1||count>256U||(count&&!domains)||
      (request.previous_measurement_id&&(request.flags!=1U||count)))return TERRA_STATUS_INVALID_ARGUMENT;
  frame::triangle_projection_context projection;
  std::copy_n(request.matrix,16U,projection.matrix.begin());projection.scale_x=request.scale_x;projection.scale_y=request.scale_y;
  projection.origin=source->value.source().origin();
  if(!frame::valid_triangle_projection_context(projection))return TERRA_STATUS_INVALID_ARGUMENT;
  frame::surface_measurement_previous previous;
  if(request.previous_measurement_id) {
    const auto* input=measurement(request.previous_measurement_id);
    if(!input||!input->value||!input->whole||input->session!=session||input->resource!=source->resource||
        !same_node(input->anchor,source->anchor)||input->source!=request.source_revision||
        input->projection.scale_x!=request.scale_x||input->projection.scale_y!=request.scale_y||
        !std::equal(input->projection.matrix,input->projection.matrix+16U,request.matrix))return TERRA_STATUS_INVALID_STATE;
    previous.input=input->value;previous.summary=input->summary;previous.projective_pixels_per_uv=input->projective_density;
  }
  if(maximum<measurement_bytes())return TERRA_STATUS_RESOURCE_LIMIT;
  const auto key=free_id(measurements_,next_measurement_);if(!key)return TERRA_STATUS_RESOURCE_LIMIT;
  core::payload_budget::credit credit;if(!budget_.reserve(measurement_bytes(),credit))return TERRA_STATUS_RESOURCE_LIMIT;
  std::unique_ptr<measurement_record,charged_delete<measurement_record>> record(new(std::nothrow) measurement_record);
  if(!record)return TERRA_STATUS_RESOURCE_LIMIT;
  record->charge=std::move(credit);
  record->active.reset(new(std::nothrow) measurement_active(source->value,projection,budget_,request.flags,domains,count,std::move(previous)));
  if(!record->active)return TERRA_STATUS_RESOURCE_LIMIT;
  record->id=key;record->session=session;record->model=request.model_id;record->resource=source->resource;record->plan=source->plan;
  record->view=request.view_revision;record->source=request.source_revision;record->anchor=source->anchor;
  record->projection=request;record->whole=count==0U;
  begin_output(record->progress,key);
  measurements_[(key-1U)%measurements_.size()]=std::move(record);id=key;return TERRA_STATUS_OK;
}
terra_status surface_measurement_store::step_measurement(std::uint32_t id,frame::imagery_controller& controller,
    std::uint32_t session,std::uint32_t maximum,double milliseconds,std::uint32_t quote,std::uint32_t grant,terra_surface_work_v1& output) {
  auto* record=measurement(id);if(!record||record->session!=session)return TERRA_STATUS_INVALID_STATE;
  if(!valid_step(maximum,milliseconds))return TERRA_STATUS_INVALID_ARGUMENT;
  if(!record->active){if(grant||quote)return TERRA_STATUS_INVALID_STATE;output=record->progress;output.operations=0U;return TERRA_STATUS_OK;}
  auto& work=record->active->work;auto p=work.step(0U);
  if(grant) {
    if(!quote||quote!=record->quote)return TERRA_STATUS_INVALID_STATE;
    if(grant<p.required_work_bytes)return TERRA_STATUS_RESOURCE_LIMIT;
    if(p.status==frame::surface_measurement_status::waiting_for_work) {
      core::payload_budget::credit credit;
      if(!budget_.reserve(p.required_work_bytes,credit)||!work.admit_work(credit))return TERRA_STATUS_RESOURCE_LIMIT;
    }else if(p.status==frame::surface_measurement_status::waiting_for_input) {
      if(!work.admit_input(controller,record->anchor,grant))return TERRA_STATUS_RESOURCE_LIMIT;
    }else return TERRA_STATUS_INVALID_STATE;
    ++record->quote;
  }else if(quote)return TERRA_STATUS_INVALID_ARGUMENT;
  p=work.step(maximum,milliseconds);
  begin_output(record->progress,id);auto& result=record->progress;
  result.phase=std::uint32_t(p.status);result.operations=p.operations;result.required_work_bytes=p.required_work_bytes;
  result.model_id=record->model;result.resource_id=record->resource;result.plan_id=record->plan;
  result.view_revision=record->view;result.source_revision=record->source;
  result.region_count=p.region_count;result.hull_count=p.hull_count;result.copied_regions=p.copied_regions;
  result.copied_hull=p.copied_hull;result.normalized_regions=p.normalized_regions;
  result.quote_id=p.required_work_bytes?record->quote:0U;
  if(p.status==frame::surface_measurement_status::complete) {
    record->summary=work.summary();record->projective_density=work.projective_pixels_per_uv();record->value=work.take_input();
    record->active.reset();record->charge.shrink(sizeof(measurement_record));
  }
  output=result;return TERRA_STATUS_OK;
}
terra_status surface_measurement_store::summary(std::uint32_t id,terra_surface_summary_v1& output)const {
  const auto* record=measurement(id);if(!record||!record->value)return TERRA_STATUS_INVALID_STATE;
  const auto& value=record->summary;output={};output.struct_size=sizeof(output);output.api_version=TERRA_C_API_VERSION;
  output.visible=value.visible;output.refinable=value.refinable;
  output.minimum_u=value.uv.minimum[0];output.minimum_v=value.uv.minimum[1];output.maximum_u=value.uv.maximum[0];output.maximum_v=value.uv.maximum[1];
  output.pixels_per_uv=value.pixels_per_uv;output.center_distance=value.center_distance;return TERRA_STATUS_OK;
}
std::shared_ptr<const frame::imagery_surface_input> surface_measurement_store::input(std::uint32_t id,std::uint32_t session)const {
  const auto* record=measurement(id);return record&&record->session==session?record->value:nullptr;
}
bool surface_measurement_store::close_model(std::uint32_t id) {
  if(!model(id))return false;
  models_[(id-1U)%models_.size()].reset();return true;
}
bool surface_measurement_store::close_measurement(std::uint32_t id) {
  if(!measurement(id))return false;
  measurements_[(id-1U)%measurements_.size()].reset();return true;
}
void surface_measurement_store::close_session(std::uint32_t session) {
  for(auto& value:measurements_)if(value&&value->session==session)value.reset();
}
void surface_measurement_store::clear() {
  for(auto& value:measurements_)value.reset();
  for(auto& value:models_)value.reset();
}
} }
