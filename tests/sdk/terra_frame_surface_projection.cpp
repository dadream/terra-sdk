#include <terra/frame/surface_projection.hpp>
#include <terra/frame/mesh.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using namespace terra;
using namespace terra::frame;
using status=surface_projection_status;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
std::uint32_t u32(std::istream& in) {
  unsigned char b[4]{};in.read(reinterpret_cast<char*>(b),4);require(bool(in),"Truncated integer");
  return std::uint32_t(b[0])|std::uint32_t(b[1])<<8U|std::uint32_t(b[2])<<16U|std::uint32_t(b[3])<<24U;
}
double f64(std::istream& in) {
  const auto a=u32(in),b=u32(in);const std::uint64_t bits=std::uint64_t(a)|(std::uint64_t(b)<<32U);
  double result;std::memcpy(&result,&bits,8U);return result;
}
float f32(std::istream& in){const auto bits=u32(in);float result;std::memcpy(&result,&bits,4U);return result;}
bool same(double a,double b) {
  if(std::isnan(a))return std::isnan(b);
  if(a==0.0&&b==0.0)return std::signbit(a)==std::signbit(b);
  return a==b||(std::isfinite(a)&&std::isfinite(b)&&std::abs(a-b)<=std::max(1e-11,std::abs(a)*1e-11));
}
void kernel_contract(const char* path) {
  std::ifstream in(path,std::ios::binary);char magic[8]{};in.read(magic,8);
  require(std::memcmp(magic,"TERRATP1",8U)==0&&u32(in)==65U,"Missing frozen projection cases");
  for(unsigned c=0U;c<65U;++c) {
    const auto length=u32(in);require(length<256U,"Invalid case name");std::string name(length,' ');in.read(&name[0],length);
    triangle_projection_context context;triangle_projection_input input;
    for(double& v:context.matrix)v=f64(in);
    for(double& v:context.origin)v=f64(in);
    context.scale_x=f64(in);context.scale_y=f64(in);context.clip=u32(in)!=0U;context.cull=u32(in)!=0U;
    for(float& v:input.positions)v=f32(in);
    for(float& v:input.uv)v=f32(in);
    const auto count=u32(in);std::vector<double> expected(15U+count*2U);for(double& v:expected)v=f64(in);
    projected_triangle actual;require(project_imagery_triangle(context,input,actual),"Frozen valid projection failed");
    require(actual.vertex_count==count,"Frozen clipped count changed");
    std::array<double,47> values{};values[0]=actual.pixels_per_uv;values[1]=actual.center_distance;
    std::copy(actual.bounds.begin(),actual.bounds.end(),values.begin()+2U);
    std::copy(actual.projection.begin(),actual.projection.end(),values.begin()+6U);
    for(unsigned i=0U;i<count;++i){values[15U+i*2U]=actual.polygon[i][0];values[16U+i*2U]=actual.polygon[i][1];}
    for(std::size_t i=0U;i<expected.size();++i)if(!same(expected[i],values[i]))
      throw std::runtime_error(name+" field "+std::to_string(i)+" differs from frozen JS");
  }
  require(in.peek()==std::char_traits<char>::eof(),"Unexpected frozen bytes");
  triangle_projection_context context;context.matrix={{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1}};
  triangle_projection_input input;input.positions={{0,0,0,1,0,0,0,1,0}};input.uv={{0,0,1,0,0,1}};
  for(unsigned fault=0U;fault<4U;++fault) {
    auto c=context;auto v=input;
    if(fault==0U)c.scale_x=0.0;
    if(fault==1U)c.matrix[0]=std::numeric_limits<double>::infinity();
    if(fault==2U)v.uv[0]=std::numeric_limits<float>::quiet_NaN();
    if(fault==3U){c.matrix[0]=1e308;v.positions[3]=100.0F;}
    projected_triangle out;out.vertex_count=99U;out.pixels_per_uv=123.0;
    require(!project_imagery_triangle(c,v,out)&&out.vertex_count==99U&&out.pixels_per_uv==123.0,"Invalid kernel output escaped");
  }
}

struct input_fixture {
  surface_source source;
  std::shared_ptr<const std::vector<std::uint16_t>> faces;
  triangle_projection_context projection;
};
input_fixture source_fixture(bool global) {
  const unsigned dimension=16U;
  surface_source_parameters parameters;parameters.dimension=dimension;parameters.height_scale=0.125;
  parameters.cylindrical=global;parameters.radius=6378000.0;
  parameters.bounds=global?core::bounds2d({{-180,-90}},{{180,90}}):core::bounds2d({{-10,-5}},{{10,15}});
  const auto diamond=global?core::cylindrical_roots()[3]:core::planar_root();
  lod_patch patch;patch.id=diamond.id();patch.fragment_mask=3U;
  for(unsigned i=0U;i<4U;++i)patch.corners[i]=diamond.corner(i);
  codec::height_patch record;record.rows=record.columns=dimension+1U;
  record.values.resize(record.rows*record.columns);
  for(std::size_t i=0U;i<record.values.size();++i)record.values[i]=std::int32_t(i*13U%1024U)+200;
  height_storage storage(1048576U);height_storage::handle heights;
  require(storage.root(record,heights)==codec::hierarchy_status::ok,"Cannot make frozen heights");
  auto metadata=std::make_shared<patch_surface_mesh>();
  require(describe_patch_surface(patch,0U,dimension,global,parameters.radius,parameters.bounds,*metadata)==surface_mesh_status::ok,"Cannot describe CBDAM surface");
  surface_source sampled(metadata,{},heights,parameters);require(sampled.valid()&&!sampled.resident_positions(),"Source did not freeze candidate height");
  auto complete=std::make_shared<patch_surface_mesh>();
  const auto result=global?make_cylindrical_patch_surface(patch,0U,heights->value().fragments[0],parameters.height_scale,parameters.radius,*complete)
    :make_planar_patch_surface(patch,0U,heights->value().fragments[0],parameters.height_scale,parameters.bounds,*complete);
  require(result==surface_mesh_status::ok,"Cannot produce comparison mesh");
  surface_source resident(complete,{},heights,parameters);require(resident.valid()&&resident.resident_positions(),"Resident array loan failed");
  // Future production fills a previously empty resource; frozen sampling must
  // not start observing it, even if it has unrelated data after this point.
  metadata->positions_xyz.assign(complete->positions_xyz.size(),-123.0F);
  std::array<float,64U*3U> xyz;std::array<float,64U*2U> uv;
  for(const auto* source:{&sampled,&resident})for(std::uint32_t first=0U;first<source->vertex_count();first+=64U) {
    const auto count=std::min(64U,source->vertex_count()-first);
    require(source->read(first,count,xyz.data(),uv.data())==surface_mesh_status::ok,"Bounded source read failed");
    require(std::memcmp(xyz.data(),complete->positions_xyz.data()+first*3U,count*3U*sizeof(float))==0&&
      std::memcmp(uv.data(),complete->texture_uv.data()+first*2U,count*2U*sizeof(float))==0,"Sampled/resident bytes differ from actual CBDAM mesh");
  }
  require(sampled.read(0U,65U,xyz.data(),uv.data())==surface_mesh_status::invalid_argument,"Unbounded source sample allowed");
  std::weak_ptr<height_storage::block> frozen=heights;const auto bytes=storage.resident_bytes();heights.reset();
  require(!frozen.expired()&&storage.resident_bytes()==bytes,"Frozen reader refunded live height");
  std::vector<std::uint16_t> strip;require(make_triangular_patch_strip_indices(dimension,strip)==mesh_index_status::ok,"Cannot make index template");
  auto faces=std::make_shared<std::vector<std::uint16_t>>();
  for(std::size_t i=2U;i<strip.size();++i) {
    const auto a=strip[i-2U],b=strip[i-1U],c=strip[i];
    if(a>=sampled.vertex_count()||b>=sampled.vertex_count()||c>=sampled.vertex_count()||a==b||b==c||a==c)continue;
    faces->push_back(i%2U?b:a);faces->push_back(i%2U?a:b);faces->push_back(c);
  }
  triangle_projection_context projection;projection.origin=sampled.origin();projection.scale_x=320;projection.scale_y=180;
  if(global) {
    globe_camera camera(6378000.0F,640,360,0.8F);camera.set_target_degrees(-45.0,30.0);
    projection.matrix=camera.snapshot().projection_view;
  }else projection.matrix={{0.05,0,0,0,0,0.05,0,-0.25,0,0,0.001,0,0,0,0,1}};
  return {sampled,faces,projection};
}

core::payload_budget* observed_budget=nullptr;
bool refund_order=true;
void before_free(std::size_t) {if(observed_budget->work_bytes()<test_allocations::live_bytes)refund_order=false;}
void work_contract(const input_fixture& input,std::size_t quantum) {
  core::payload_budget budget(16U*1024U*1024U);
  surface_projection_work work(input.source,{input.faces,input.faces->data(),input.faces->size()},input.projection,budget);
  auto p=work.step(0U);require(p.status==status::waiting_for_workspace&&p.required_work_bytes>0U,"No sampling quote");
  const auto fixed=p.required_work_bytes;
  core::payload_budget::credit blocker;
  require(budget.reserve(budget.maximum_bytes()-fixed+1U,blocker),"Cannot block sampling");
  test_allocations::allocations=test_allocations::peak_bytes=0U;test_allocations::measuring=true;
  observed_budget=&budget;refund_order=true;test_allocations::before_free=before_free;
  require(!work.admit()&&test_allocations::allocations==0U&&work.step(quantum).operations==0U,"Unfunded sampler allocated or polled");
  blocker.clear();require(work.admit()&&work.allocated_bytes()==fixed&&test_allocations::allocations==1U,"Sampler allocation differs from quote");
  do {p=work.step(quantum);require(p.operations<=quantum,"Count exceeded work limit");}while(p.status==status::counting);
  require(p.status==status::waiting_for_regions&&p.raw_count>0U,"Expected visible exact regions");
  require(test_allocations::allocations==1U,"Count materialized raw rows");
  const auto second=p.required_work_bytes;
  require(budget.reserve(budget.maximum_bytes()-fixed-second+1U,blocker),"Cannot block joint regions");
  require(!work.admit()&&work.allocated_bytes()==fixed&&work.step(quantum).operations==0U,"Short joint grant started production");
  blocker.clear();core::payload_budget::credit grant;
  require(budget.reserve(second,grant)&&work.admit(grant)&&!grant.attached(),"Joint grant transfer failed");
  require(work.authorized_bytes()==budget.work_bytes()&&work.allocated_bytes()<work.authorized_bytes(),"Reserved compaction was allocated early or lost");
  do {p=work.step(quantum);require(p.operations<=quantum&&p.total_operations<10000000U,"Work budget/convergence violated");}
  while(p.status==status::generating||p.status==status::compacting);
  require(p.status==status::complete&&p.output_count>0U&&work.summary().visible,"Fused task failed to complete");
  require(test_allocations::allocations==3U&&test_allocations::live_bytes==work.allocated_bytes(),"Hidden production allocation or wrong quote");
  require(work.allocated_bytes()==budget.work_bytes()&&work.authorized_bytes()==work.allocated_bytes(),"Compaction transfer double counted");
  std::array<measurement_region,256> output;std::size_t count=0U;
  require(!work.read(0U,output.data(),257U,count),"Unbounded output allowed");
  for(std::size_t first=0U;first<p.output_count;first+=256U)require(work.read(first,output.data(),256U,count)&&count>0U,"Output page rejected");
  require(test_allocations::allocations==3U,"Output read allocated");
  work.cancel();require(work.allocated_bytes()==0U&&budget.work_bytes()==0U&&test_allocations::live_bytes==0U,"Cancelled pipeline retained arrays or credit");
  test_allocations::measuring=false;test_allocations::before_free=nullptr;require(refund_order,"Credit refunded before actual free");
  require(!work.read(0U,output.data(),1U,count)&&work.step(1U).status==status::cancelled,"Cancelled pipeline resumed");
}

void interleaving(const input_fixture& input) {
  core::payload_budget budget(32U*1024U*1024U);
  surface_triangle_view faces{input.faces,input.faces->data(),input.faces->size()};
  surface_projection_work first(input.source,faces,input.projection,budget),second(input.source,faces,input.projection,budget);
  require(first.admit()&&second.admit(),"Cannot fund peer samplers");
  auto p=first.step(7U),q=second.step(1U);
  while(p.status==status::counting) {
    p=first.step(7U);q=second.step(1U);
    require(q.status==status::counting,"Peer fixture completed too early");
  }
  require(p.status==status::waiting_for_regions&&first.admit(),"Cannot fund first joint group");
  first.step(17U);first.cancel();
  require(budget.work_bytes()==second.authorized_bytes(),"One cancellation refunded a live peer");
  do {
    q=second.step(64U);
    if(q.status==status::waiting_for_regions)require(second.admit(),"Peer lost capacity after cancellation");
    require(q.status==status::counting||q.status==status::waiting_for_regions||q.status==status::generating||q.status==status::compacting||q.status==status::complete,"Peer work failed");
  }while(q.status!=status::complete);
  require(q.output_count>0U,"Peer output was invalidated");second.cancel();require(budget.work_bytes()==0U,"Peer cancellation leaked quota");
}

void failures(const input_fixture& input) {
  using credit=core::payload_budget::credit;
  core::payload_budget budget(16U*1024U*1024U),foreign(16U*1024U*1024U);
  credit a,b;require(budget.reserve(10U,a)&&foreign.reserve(10U,b),"Cannot reserve split test");
  const auto peak=budget.peak_bytes();credit out;
  require(!budget.split_work(a,11U,out)&&a.bytes()==10U&&!out.attached(),"Oversized split consumed source");
  auto resident=budget.resident_credit();require(!budget.split_work(resident,0U,out),"Resident split accepted");
  require(!budget.split_work(b,1U,out)&&b.bytes()==10U&&!out.attached(),"Foreign split consumed credit");
  require(budget.split_work(a,4U,out)&&a.bytes()==6U&&out.bytes()==4U&&budget.work_bytes()==10U&&budget.peak_bytes()==peak,"Split changed accounting");
  require(!budget.split_work(a,7U,b)&&a.bytes()==6U&&b.bytes()==10U,"Invalid split changed owners");a.clear();b.clear();out.clear();
  {
    surface_projection_work work(input.source,{input.faces,input.faces->data(),input.faces->size()},input.projection,budget);
    require(work.admit(),"Timed sampler admission failed");
    const auto p=work.step(1000000U,1e-9);require(p.operations>0U&&p.operations<=64U,"Count exceeded elapsed window");
  }
  for(std::uint64_t stop:{0U,1U,127U,1000U,10000U}) {
    surface_projection_work work(input.source,{input.faces,input.faces->data(),input.faces->size()},input.projection,budget);
    while(true) {
      const auto p=work.step(7U);
      if(p.status==status::waiting_for_workspace||p.status==status::waiting_for_regions)require(work.admit(),"Cancellation funding failed");
      else require(p.status==status::counting||p.status==status::generating||p.status==status::compacting||p.status==status::complete,"Cancellation task failed");
      if(p.total_operations>=stop||p.status==status::complete)break;
    }
    work.cancel();work.cancel();require(budget.work_bytes()==0U,"Partial cancellation leaked quota");
  }
  for(unsigned stage=0U;stage<3U;++stage) {
    surface_projection_work work(input.source,{input.faces,input.faces->data(),input.faces->size()},input.projection,budget);
    if(stage) {
      require(work.admit(),"Cannot fund failure count");while(work.step(4096U).status==status::counting){}
      if(stage==2U) {
        require(work.admit(),"Cannot fund failed compaction");
        while(work.step(1U).status==status::generating){}
        test_allocations::fail_next=true;
        while(work.step(1U).status==status::compacting){}
      }
    }
    if(stage<2U){test_allocations::fail_next=true;require(!work.admit(),"Injected failure allocated");}
    require(work.step(0U).status==status::allocation_failed,"Allocation failure was not explicit");
    work.cancel();require(budget.work_bytes()==0U,"Failed production retained quota");
  }
}
}

int main(int argc,char** argv) {
  try {
    require(argc==2,"A frozen projection oracle is required");kernel_contract(argv[1]);
    const auto planar=source_fixture(false),globe=source_fixture(true);
    for(const auto* input:{&planar,&globe})for(const std::size_t quantum:{1U,7U,64U,4096U})work_contract(*input,quantum);
    failures(planar);interleaving(planar);
    std::cout<<"Native fused exact faces: 65 frozen kernels, CBDAM frozen/resident byte parity, eight work schedules, joint grants and cancellation passed\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
