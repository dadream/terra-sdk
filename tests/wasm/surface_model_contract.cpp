// Whole-model private fixture. No test symbol is exported by the SDK package.
#include <terra/frame/surface_projection.hpp>
#include <terra/frame/imagery_input.hpp>
#include "../../sdk/src/c_api/mesh_source.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace {
using namespace terra::frame;
std::uint32_t live=0U;
struct fixture {
  terra::core::payload_budget budget;
  terra::core::payload_budget::credit blocker;
  surface_model_work build;
  surface_model model;
  std::vector<std::uint32_t> domains;
  std::unique_ptr<surface_projection_work> measurement;
  bool resident;
  fixture(surface_source source,std::uint32_t limit,surface_layout layout)
      :budget(limit),build(source,budget,std::move(layout)),resident(source.resident_positions()){++live;}
  ~fixture(){--live;}
};
void write_region(const measurement_region& row,unsigned char* output) {
  const std::uint32_t flags[]={row.flags,row.domain};std::memcpy(output,flags,8U);
  const auto& r=row.value;double values[21];
  values[0]=r.uv.minimum[0];values[1]=r.uv.minimum[1];values[2]=r.uv.maximum[0];values[3]=r.uv.maximum[1];values[4]=r.pixels_per_uv;
  std::copy(r.projection.begin(),r.projection.end(),values+5U);
  for(unsigned i=0U;i<3U;++i){values[14U+i*2U]=r.triangle[i][0];values[15U+i*2U]=r.triangle[i][1];}
  values[20]=r.numerator_bound;std::memcpy(output+8U,values,sizeof(values));
}
}
extern "C" {
fixture* test_model_create(const terra_context* context,std::uint32_t plan,std::uint32_t resource,
                          std::uint32_t limit,const fixture* reuse) {
  surface_source source;
  if(!terra::c_api_detail::borrow_surface_source(context,plan,resource,source))return nullptr;
  return new fixture(std::move(source),limit,reuse&&reuse->model?reuse->model.layout():surface_layout());
}
void test_model_step(fixture* f,std::uint32_t maximum,double ms,unsigned char* output) {
  const auto p=f->build.step(maximum,ms);
  if(p.status==surface_model_status::complete&&!f->model)f->model=f->build.take_model();
  const auto* layout=f->model?&f->model.layout():nullptr;
  const std::uint32_t values[]={std::uint32_t(p.status),std::uint32_t(p.operations),std::uint32_t(p.total_operations),
    std::uint32_t(p.required_work_bytes),std::uint32_t(f->build.allocated_bytes()),std::uint32_t(f->budget.work_bytes()),
    std::uint32_t(f->budget.resident_bytes()),layout?layout->face_count():0U,layout?layout->grouped_face_count():0U,
    layout?layout->block_count():0U,layout?layout->hull_count():0U,f->resident?1U:0U};
  std::memcpy(output,values,sizeof(values));
}
std::uint32_t test_model_admit(fixture* f,std::uint32_t stage) {
  return (stage?bool(f->measurement)&&f->measurement->admit():f->build.admit())?1U:0U;
}
std::uint32_t test_model_block(fixture* f,std::uint32_t bytes) {
  if(!bytes){f->blocker.clear();return 1U;}return f->budget.reserve(bytes,f->blocker)?1U:0U;
}
std::int32_t test_model_read(fixture* f,std::uint32_t kind,std::uint32_t first,std::uint32_t maximum,unsigned char* output) {
  if(!f->model||maximum>256U)return -1;
  const auto& layout=f->model.layout();std::uint32_t total=0U;
  if(kind==0U)total=layout.face_count()*3U;
  else if(kind==1U)total=layout.grouped_face_count();
  else if(kind==2U)total=layout.hull_count();
  else if(kind==3U)total=layout.block_count();
  else return -1;
  if(first>total)return -1;
  const auto count=std::min(maximum,total-first);
  if(kind==0U)std::memcpy(output,layout.faces()+first,count*2U);
  if(kind==1U)std::memcpy(output,layout.order()+first,count*4U);
  for(unsigned i=0U;i<count;++i) {
    if(kind==2U)std::memcpy(output+i*16U,layout.hull()[first+i].data(),16U);
    if(kind==3U) {
      const auto& b=f->model.block(first+i);
      double v[26]={b.uv.minimum[0],b.uv.minimum[1],b.uv.maximum[0],b.uv.maximum[1],double(b.first),double(b.count),double(b.winding)};
      const terra::core::vector3d* vectors[]={&b.minimum,&b.maximum,&b.du,&b.dv,&b.du_radius,&b.dv_radius};
      for(unsigned j=0U;j<6U;++j)std::copy(vectors[j]->begin(),vectors[j]->end(),v+7U+j*3U);
      v[25]=b.deviation;std::memcpy(output+i*sizeof(v),v,sizeof(v));
    }
  }
  return std::int32_t(count);
}
std::uint32_t test_model_same_layout(const fixture* a,const fixture* b) {
  return a->model&&b->model&&a->model.layout().faces()==b->model.layout().faces()?1U:0U;
}
std::uint32_t test_model_measure(fixture* f,const double* matrix,double sx,double sy,std::uint32_t flags,
                               const std::uint32_t* domains,std::uint32_t count) {
  if(!f->model||!matrix||count>256U||(count&&!domains))return 0U;
  f->measurement.reset();f->domains.clear();if(count)f->domains.assign(domains,domains+count);
  triangle_projection_context p;std::copy_n(matrix,16U,p.matrix.begin());p.origin=f->model.source().origin();p.scale_x=sx;p.scale_y=sy;
  surface_measurement_options options;options.tight=bool(flags&1U);options.bounds_only=bool(flags&2U);
  options.domains={{},f->domains.data(),f->domains.size()};
  f->measurement.reset(new surface_projection_work(f->model,p,f->budget,options));return 1U;
}
void test_model_measure_step(fixture* f,std::uint32_t maximum,double ms,unsigned char* output) {
  const auto p=f->measurement->step(maximum,ms);
  const std::uint32_t values[]={std::uint32_t(p.status),std::uint32_t(p.operations),std::uint32_t(p.total_operations),std::uint32_t(p.required_work_bytes),
    std::uint32_t(p.raw_count),std::uint32_t(p.output_count),std::uint32_t(f->measurement->allocated_bytes()),std::uint32_t(f->measurement->authorized_bytes()),
    std::uint32_t(f->budget.work_bytes()),std::uint32_t(f->budget.resident_bytes())};std::memcpy(output,values,sizeof(values));
}
std::int32_t test_model_measure_read(fixture* f,std::uint32_t first,std::uint32_t maximum,unsigned char* output) {
  if(!f->measurement||maximum>256U)return -1;
  std::array<measurement_region,256> rows;std::size_t count=0U;
  if(!f->measurement->read(first,rows.data(),maximum,count))return -1;
  for(std::size_t i=0U;i<count;++i)write_region(rows[i],output+i*176U);
  return std::int32_t(count);
}
void test_model_summary(fixture* f,unsigned char* output) {
  const auto& s=f->measurement->summary();const std::uint32_t flags[]={s.visible?1U:0U,s.refinable?1U:0U};std::memcpy(output,flags,sizeof(flags));
  const double values[]={s.uv.minimum[0],s.uv.minimum[1],s.uv.maximum[0],s.uv.maximum[1],s.pixels_per_uv,s.center_distance};std::memcpy(output+8U,values,sizeof(values));
}
// Exercise same-side semantic handoff on the exact actual CBDAM measurement.
// No product test exports, wire reinterpretation or JS repacking is involved.
std::uint32_t test_model_input(fixture* f) {
  if(!f->measurement||!f->model)return 2U;
  const auto p=f->measurement->step(0U);
  if(p.status!=surface_projection_status::complete)return 3U;
  imagery_controller controller;imagery_input_work input;imagery_budget budget;budget.maximum_level=0U;
  const auto rows=p.output_count;const auto& layout=f->model.layout();
  const auto quote=imagery_input_work::work_bytes(1U,1U,rows,layout.hull_count());
  if(!quote||controller.stage_input(input,1U,1U,rows,layout.hull_count(),quote-1U)||input.active()||controller.input_allocated_bytes())return 4U;
  if(!controller.stage_input(input,1U,1U,rows,layout.hull_count(),quote)||
      !input.append_surface(7U,terra::imagery::node_key(0,0,0),rows,layout.hull_count()))return 5U;
  for(std::size_t first=0U;first<rows;first+=256U)
    if(!input.append_regions(*f->measurement,first,std::min(std::size_t(256),rows-first)))return 6U;
  for(std::size_t first=0U;first<layout.hull_count();first+=256U)
    if(!input.append_hull(layout,first,std::min(std::size_t(256),layout.hull_count()-first)))return 7U;
  if(controller.input_allocated_bytes()!=input.allocated_bytes()||input.allocated_bytes()>quote||
      !controller.commit_input(std::move(input),budget))return 8U;
  imagery_cut cut;
  for(unsigned i=0U;i<10000U;++i) {
    cut=controller.update_step(1U,1U,0.0);
    if(!cut.complete)return 9U;
    if(cut.decisions_complete)break;
  }
  if(!cut.decisions_complete)return 10U;
  auto loan=controller.retain_surface(7U);controller.clear();
  std::array<measurement_region,256U> source,canonical;
  for(std::size_t first=0U;first<rows;first+=256U) {
    std::size_t a=0U,b=0U;
    if(!f->measurement->read(first,source.data(),256U,a)||
        !imagery_controller::read_input(loan,first,canonical.data(),256U,b)||a!=b)return 11U;
    for(std::size_t i=0U;i<a;++i) {
      const auto& s=source[i];const auto& c=canonical[i];
      if(s.flags!=c.flags||s.domain!=c.domain||s.value.uv.minimum!=c.value.uv.minimum||s.value.uv.maximum!=c.value.uv.maximum||
          c.value.pixels_per_uv!=imagery_region_error(s,s.value.uv)||s.value.projection!=c.value.projection||
          s.value.triangle!=c.value.triangle||s.value.numerator_bound!=c.value.numerator_bound)return 12U;
    }
  }
  loan.reset();return controller.input_allocated_bytes()==0U?1U:13U;
}
void test_model_measure_cancel(fixture* f){if(f->measurement)f->measurement->cancel();}
void test_model_destroy(fixture* f){delete f;}
std::uint32_t test_model_handles(){return live;}
}
