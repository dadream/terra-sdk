#include <terra/frame/surface_projection.hpp>
#include <terra/frame/mesh.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using namespace terra;
using namespace terra::frame;
using model_status=surface_model_status;
using projection_status=surface_projection_status;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
struct fixture {
  std::shared_ptr<patch_surface_mesh> mesh;
  std::shared_ptr<std::vector<float>> uv;
  std::shared_ptr<height_storage::block> heights;
  surface_source source;
  surface_source_parameters parameters;
};
fixture make_source(std::uint32_t dimension,bool globe,bool resident=false,double height_scale=0.125) {
  fixture f;f.parameters.dimension=dimension;f.parameters.height_scale=height_scale;
  f.parameters.cylindrical=globe;f.parameters.radius=6378000.0;
  f.parameters.bounds=globe?core::bounds2d({{-180,-90}},{{180,90}}):core::bounds2d({{-10,-5}},{{10,15}});
  const auto diamond=globe?core::cylindrical_roots()[3]:core::planar_root();
  lod_patch patch;patch.id=diamond.id();patch.fragment_mask=3U;
  for(unsigned i=0U;i<4U;++i)patch.corners[i]=diamond.corner(i);
  codec::height_patch record;record.rows=record.columns=dimension+1U;record.values.resize(record.rows*record.columns);
  for(std::size_t i=0U;i<record.values.size();++i)record.values[i]=std::int32_t(i*13U%1024U)+200;
  height_storage storage(16U*1024U*1024U);
  require(storage.root(record,f.heights)==codec::hierarchy_status::ok,"Cannot build actual CBDAM height");
  f.mesh=std::make_shared<patch_surface_mesh>();
  require(describe_patch_surface(patch,0U,dimension,globe,f.parameters.radius,f.parameters.bounds,*f.mesh)==surface_mesh_status::ok,"Invalid CBDAM description");
  if(resident) {
    const auto result=globe?make_cylindrical_patch_surface(patch,0U,f.heights->value().fragments[0],height_scale,f.parameters.radius,*f.mesh)
      :make_planar_patch_surface(patch,0U,f.heights->value().fragments[0],height_scale,f.parameters.bounds,*f.mesh);
    require(result==surface_mesh_status::ok,"Cannot produce source arrays");
  }
  f.source=surface_source(f.mesh,{},f.heights,f.parameters);require(f.source.valid(),"Invalid frozen source");return f;
}
surface_model build(surface_source source,core::payload_budget budget,std::size_t quantum,surface_layout reuse={}) {
  surface_model_work work(std::move(source),budget,std::move(reuse));
  require(work.admit(),"Model grant failed");
  surface_model_progress p;
  do{p=work.step(quantum);require(p.operations<=quantum&&p.total_operations<10000000U,"Model lost bounded convergence");}while(p.status==model_status::building);
  require(p.status==model_status::complete,"Model failed");auto result=work.take_model();
  require(bool(result)&&work.allocated_bytes()==0U,"Model transfer left private arrays");return result;
}
void topology(std::uint32_t dimension,bool globe) {
  const auto input=make_source(dimension,globe);core::payload_budget budget(16U*1024U*1024U);
  auto model=build(input.source,budget,17U);const auto& layout=model.layout();
  require(layout.face_count()==dimension*dimension,"CBDAM face count differs");
  std::vector<std::uint16_t> strip,faces;
  require(make_triangular_patch_strip_indices(dimension,strip)==mesh_index_status::ok,"Strip fixture failed");
  for(std::size_t i=2U;i<strip.size();++i) {
    const auto a=strip[i-2U],b=strip[i-1U],c=strip[i];if(a==b||b==c||a==c)continue;
    faces.push_back(i%2U?b:a);faces.push_back(i%2U?a:b);faces.push_back(c);
  }
  require(faces.size()==layout.face_count()*3U&&std::equal(faces.begin(),faces.end(),layout.faces()),"Analytic topology differs from actual CBDAM strip");
  require(layout.block_count()>0U&&layout.block_count()<=16U&&layout.hull_count()>=3U&&layout.hull_count()<=3U*dimension,"Invalid UV grouping/hull");
  std::vector<bool> seen(layout.face_count(),false);std::uint32_t first=0U;
  for(unsigned i=0U;i<layout.block_count();++i) {
    const auto& b=model.block(i);require(b.first==first&&b.count>0U,"Non-contiguous grouping");first+=b.count;
    for(unsigned j=0U;j<b.count;++j) {
      const auto face=layout.order()[b.first+j];require(face<seen.size()&&!seen[face],"Grouping duplicates or misses a face");seen[face]=true;
      for(unsigned vertex=0U;vertex<3U;++vertex) {
        float xyz[3],uv[2];require(input.source.read(layout.faces()[face*3U+vertex],1U,xyz,uv)==surface_mesh_status::ok,"Source sampling failed");
        for(unsigned axis=0U;axis<3U;++axis)require(xyz[axis]>=b.minimum[axis]&&xyz[axis]<=b.maximum[axis],"Spatial bound excludes terrain");
        for(unsigned axis=0U;axis<2U;++axis)require(uv[axis]>=b.uv.minimum[axis]&&uv[axis]<=b.uv.maximum[axis],"UV bound excludes triangle");
      }
    }
    require(std::isfinite(b.deviation)&&b.deviation>=0.0,"Invalid derivative radius");
  }
  require(first==layout.grouped_face_count(),"Grouping total differs");
  require(budget.work_bytes()==0U&&budget.resident_bytes()==model.payload_bytes()+layout.payload_bytes(),"Model has unowned payload");
  model=surface_model();require(budget.resident_bytes()==0U,"Model/UV arenas leaked");
}
core::payload_budget* observed=nullptr;bool free_order=true;
void before_free(std::size_t){if(observed->work_bytes()+observed->resident_bytes()<test_allocations::live_bytes)free_order=false;}
void ownership() {
  auto f=make_source(64U,true);core::payload_budget budget(16U*1024U*1024U);
  surface_model_work work(f.source,budget);const auto quote=work.step(0U).required_work_bytes;
  core::payload_budget::credit blocker;
  require(budget.reserve(budget.maximum_bytes()-quote+1U,blocker),"Cannot constrain model");
  observed=&budget;free_order=true;test_allocations::before_free=before_free;
  test_allocations::allocations=test_allocations::peak_bytes=0U;test_allocations::measuring=true;
  require(!work.admit()&&test_allocations::allocations==0U&&work.step(1U).operations==0U,"Unfunded model allocated");
  blocker.clear();require(work.admit()&&work.allocated_bytes()==quote&&test_allocations::allocations==3U,"Model quote/allocation differs");
  surface_model_progress p;
  do{p=work.step(7U);}while(p.status==model_status::building);
  require(p.status==model_status::complete&&test_allocations::allocations==3U,"Hidden model allocations");
  require(test_allocations::live_bytes==work.allocated_bytes()&&budget.work_bytes()+budget.resident_bytes()==quote,"Completed arenas uncharged");
  auto model=work.take_model();auto layout=model.layout();
  require(test_allocations::live_bytes==model.payload_bytes()+layout.payload_bytes()&&budget.work_bytes()==0U,"Scratch retained after transfer");
  std::weak_ptr<height_storage::block> heights=f.heights;std::weak_ptr<patch_surface_mesh> mesh=f.mesh;
  f=fixture();require(!heights.expired(),"Model did not retain frozen height");
  auto loan=model;model=surface_model();require(!heights.expired(),"Model copy lost real loan");loan=surface_model();
  require(heights.expired()&&mesh.expired()&&budget.resident_bytes()==layout.payload_bytes(),"UV layout pins old geometry");
  layout=surface_layout();require(test_allocations::live_bytes==0U&&budget.resident_bytes()==0U,"Last loan leaked resident arena");
  test_allocations::measuring=false;test_allocations::before_free=nullptr;require(free_order,"Model refunded before free");
}
void reuse() {
  const auto first=make_source(32U,true),second=make_source(32U,true,false,4.0);
  core::payload_budget budget(16U*1024U*1024U);auto a=build(first.source,budget,1U);const auto layout=a.layout();
  require(layout.compatible(second.source),"Exact sampled UV recipe cannot share");
  surface_model_work fresh(second.source,budget),reused(second.source,budget,layout);
  require(fresh.step(0U).required_work_bytes-reused.step(0U).required_work_bytes==layout.payload_bytes(),"Reuse did not remove UV quote");
  auto b=build(second.source,budget,64U,layout);require(b.layout().faces()==layout.faces()&&b.layout().hull()==layout.hull(),"Reuse rebuilt immutable layout");
  bool changed=false;for(unsigned i=0U;i<layout.block_count();++i)changed=changed||a.block(i).maximum!=b.block(i).maximum;
  require(changed,"Reused UV layout froze old geometry");
  const auto resident_a=make_source(32U,true,true),resident_b=make_source(32U,true,true);
  auto c=build(resident_a.source,budget,64U);
  require(!c.layout().compatible(resident_b.source),"Distinct resident UV owners aliased by recipe");
  surface_model_work invalid(resident_b.source,budget,c.layout());require(invalid.step(1U).status==model_status::invalid_input&&!invalid.admit(),"Incompatible layout accepted");
}
triangle_projection_context projection(const surface_source& source,bool deep) {
  triangle_projection_context p;p.origin=source.origin();p.scale_x=320;p.scale_y=180;
  // Clockwise planar terrain is front facing. Deep view clips and subdivides.
  p.matrix=deep?matrix4d{{0.2,0,0,0,0,0.2,0,-1,0,0,0.001,0,0.03,0,0.001,1}}
    :matrix4d{{0.05,0,0,0,0,0.05,0,-0.25,0,0,0.001,0,0,0,0,1}};
  return p;
}
struct measurement_result {surface_projection_summary summary;std::vector<measurement_region> rows;std::size_t subdivisions=0U;std::uint64_t operations=0U;};
measurement_result measure(surface_model model,bool deep,bool tight,std::size_t quantum,surface_domain_view domains={}) {
  core::payload_budget budget(32U*1024U*1024U);surface_measurement_options options;options.tight=tight;options.domains=domains;
  surface_projection_work work(model,projection(model.source(),deep),budget,options);surface_projection_progress p;
  observed=&budget;free_order=true;test_allocations::before_free=before_free;
  test_allocations::allocations=test_allocations::peak_bytes=0U;test_allocations::measuring=true;
  measurement_result result;
  for(;;) {
    p=work.step(quantum);require(p.operations<=quantum&&p.total_operations<10000000U,"Projection lost bounded convergence");
    if(p.status==projection_status::complete)break;
    if(p.required_work_bytes) {
      if(p.status==projection_status::waiting_for_subdivision)++result.subdivisions;
      core::payload_budget::credit blocker;require(budget.reserve(budget.maximum_bytes()-work.authorized_bytes()-p.required_work_bytes+1U,blocker),"Cannot block measurement grant");
      require(!work.admit()&&work.step(quantum).operations==0U,"Partial quote started measurement");blocker.clear();require(work.admit(),"Cannot admit full measurement");
    }else require(p.status==projection_status::counting||p.status==projection_status::generating||p.status==projection_status::compacting,"Full measurement failed");
  }
  require(test_allocations::live_bytes==work.allocated_bytes(),"Full model measurement has uncharged allocations");
  const auto allocations=test_allocations::allocations;
  test_allocations::measuring=false;
  result.summary=work.summary();result.operations=p.total_operations;result.rows.resize(p.output_count);
  for(std::size_t first=0U;first<p.output_count;first+=256U) {
    std::size_t count=0U;require(work.read(first,result.rows.data()+first,std::min(std::size_t(256),p.output_count-first),count)&&count>0U,"Cannot read complete measurement");
  }
  const bool projected=std::any_of(result.rows.begin(),result.rows.end(),[](const measurement_region& r){return bool(r.flags&1U);});
  require(allocations==1U+(p.raw_count?1U:0U)+(result.subdivisions?1U:0U)+(projected?1U:0U),"Full model measurement has hidden allocations");
  require(work.allocated_bytes()==budget.work_bytes()&&work.authorized_bytes()==work.allocated_bytes(),"Full measurement has unowned work");
  work.cancel();test_allocations::before_free=nullptr;
  require(free_order&&test_allocations::live_bytes==0U,"Measurement refunded before free or retained arrays");
  require(budget.work_bytes()==0U&&budget.resident_bytes()==0U,"Measurement refunded model's independent owner or leaked");return result;
}
bool same_rows(const std::vector<measurement_region>& a,const std::vector<measurement_region>& b) {
  if(a.size()!=b.size())return false;
  for(std::size_t i=0U;i<a.size();++i){const auto& x=a[i];const auto& y=b[i];
    if(x.flags!=y.flags||x.domain!=y.domain||x.value.uv.minimum!=y.value.uv.minimum||x.value.uv.maximum!=y.value.uv.maximum||
        x.value.pixels_per_uv!=y.value.pixels_per_uv||x.value.projection!=y.value.projection||x.value.triangle!=y.value.triangle||x.value.numerator_bound!=y.value.numerator_bound)return false;}
  return true;
}
void full_measurement() {
  const auto f=make_source(64U,false);core::payload_budget budget(16U*1024U*1024U);const auto model=build(f.source,budget,64U);
  for(bool deep:{false,true})for(bool tight:{false,true}) {
    const auto a=measure(model,deep,tight,1U),b=measure(model,deep,tight,4096U);
    require(a.summary.visible&&!a.rows.empty()&&same_rows(a.rows,b.rows)&&a.operations==b.operations,"Yield boundaries change model measurement");
    if(!deep&&!tight)require(a.subdivisions==0U&&a.rows.size()<=16U&&a.operations<1000U&&a.summary.refinable,"Shallow bound became full face walk");
    if(deep)require(a.subdivisions==1U,"Deep view did not fund lazy subdivision");
    if(!deep&&tight) {
      for(const auto& r:a.rows)require(!r.flags&&r.domain!=UINT32_MAX,"Tight shallow path exploded into per-face regions");
      const std::uint32_t domain=a.rows.front().domain;
      const auto selected=measure(model,false,true,7U,{{},&domain,1U});
      require(selected.rows.size()==1U&&selected.rows.front().domain==domain,"Selective root refinement differs");
    }
  }
  // Waiting/partial cancellation must not refund a live peer or the model.
  surface_projection_work a(model,projection(f.source,true),budget),b(model,projection(f.source,true),budget);
  require(a.admit()&&b.admit(),"Cannot fund peers");const auto resident=budget.resident_bytes();
  auto p=a.step(64U);while(p.status==projection_status::counting)p=a.step(64U);
  require(p.status==projection_status::waiting_for_subdivision&&a.admit(),"No subdivision cancellation fixture");a.step(13U);a.cancel();
  require(budget.work_bytes()==b.authorized_bytes()&&budget.resident_bytes()==resident,"Cancellation refunds live peer/model");b.cancel();
}
void failures() {
  const auto f=make_source(16U,false);core::payload_budget budget(16U*1024U*1024U),foreign(16U*1024U*1024U);
  for(unsigned stage=0U;stage<3U;++stage) {
    surface_model_work work(f.source,budget);core::payload_budget::credit grant;
    require((stage==0U?foreign:budget).reserve(work.step(0U).required_work_bytes-(stage==1U?1U:0U),grant),"Cannot reserve failure grant");
    if(stage==2U)test_allocations::fail_next=true;
    const auto bytes=grant.bytes();require(!work.admit(grant)&&grant.bytes()==bytes&&grant.attached()&&!work.allocated_bytes(),"Rejected model grant changed ownership");
    grant.clear();work.cancel();require(budget.work_bytes()==0U&&budget.resident_bytes()==0U,"Failed model leaked");
  }
  surface_model_work cancelled(f.source,budget);require(cancelled.admit(),"Cannot prepare cancellation");cancelled.step(17U);
  require(!cancelled.take_model(),"Partial layout published");cancelled.cancel();require(!budget.work_bytes()&&!budget.resident_bytes(),"Partial model leaked");
  const auto model=build(f.source,budget,64U);
  for(const auto codes: {std::array<std::uint32_t,2>{{0U,0U}},std::array<std::uint32_t,2>{{0U,1U}},std::array<std::uint32_t,2>{{999U,1U}}}) {
    surface_measurement_options options;options.domains={{},codes.data(),codes.size()};surface_projection_work work(model,projection(f.source,false),budget,options);
    require(work.admit(),"Cannot test invalid domains");auto p=work.step(64U);require(p.status==projection_status::invalid_input,"Invalid/overlapping domains accepted");
  }
  bool missing_child=false;
  for(unsigned root=0U;root<model.layout().block_count()&&!missing_child;++root) {
    const auto& b=model.block(root);bool children[4]{};
    for(unsigned i=0U;i<b.count;++i) {
      const auto* ids=model.layout().faces()+model.layout().order()[b.first+i]*3U;double middle[2]{};
      for(unsigned vertex=0U;vertex<3U;++vertex){float uv[2];require(f.source.read_uv(ids[vertex],1U,uv)==surface_mesh_status::ok,"Cannot inspect test domain");for(unsigned axis=0U;axis<2U;++axis)middle[axis]+=uv[axis];}
      unsigned key=0U;for(unsigned axis=0U;axis<2U;++axis) {
        const auto cell=std::max(0.0,std::min(1.0,std::floor((middle[axis]/3.0-b.uv.minimum[axis])*(2.0/std::max(1e-12,b.uv.maximum[axis]-b.uv.minimum[axis])))));
        key+=unsigned(cell)*(axis?2U:1U);
      }
      children[key]=true;
    }
    const auto count=unsigned(std::count(std::begin(children),std::end(children),true));
    if(count<2U||count==4U)continue;
    const std::uint32_t code=root*21U+1U+count*5U;
    surface_measurement_options options;options.domains={{},&code,1U};surface_projection_work work(model,projection(f.source,false),budget,options);
    require(work.admit(),"Cannot test absent child");auto p=work.step(64U);
    while(p.status==projection_status::counting||p.status==projection_status::waiting_for_subdivision) {
      if(p.required_work_bytes)require(work.admit(),"Cannot reconstruct test child");
      p=work.step(64U);
    }
    require(p.status==projection_status::invalid_input,"Absent dense child was accepted as invisible");missing_child=true;
  }
  require(missing_child,"Test did not reach an absent dense child");
}
}
int main() {
  try {
    for(auto d:{1U,2U,3U,4U,16U,64U,256U})for(bool global:{false,true})topology(d,global);
    ownership();reuse();full_measurement();failures();
    std::cout<<"Native surface model: CBDAM topology, immutable UV reuse, funded arenas, shallow/deep/selective measurement and cancellation passed\n";return 0;
  }catch(const std::exception& e){test_allocations::measuring=false;test_allocations::before_free=nullptr;std::cerr<<e.what()<<'\n';return 1;}
}
