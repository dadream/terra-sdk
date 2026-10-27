#include <terra/frame/imagery_input.hpp>
#include <terra/frame/surface_projection.hpp>
#include <terra/frame/mesh.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
using namespace terra;
using namespace terra::frame;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
measurement_region scalar(std::uint32_t domain=UINT32_MAX) {
  measurement_region r;r.value.uv=core::bounds2d({{0,0}},{{1,1}});
  r.value.pixels_per_uv=4096;r.domain=domain;return r;
}
imagery_cut finish(imagery_controller& controller) {
  imagery_cut cut;std::size_t rounds=0U;
  do {
    cut=controller.update_step(3U,3U,0.0);
    require(cut.complete&&++rounds<10000U,"Canonical input did not converge");
  }while(!cut.decisions_complete);
  return cut;
}
void semantics() {
  auto absent=scalar(0U),zero=absent;zero.flags=3U;
  zero.value.triangle={{{{0,0}},{{1,0}},{{0,1}}}};
  const core::bounds2d inside({{0.1,0.1}},{{0.2,0.2}}),outside({{0.8,0.8}},{{1,1}});
  require(valid_measurement_region(absent)&&valid_measurement_region(zero),"Presence rejected zero projection");
  require(imagery_region_error(absent,inside)==4096&&std::isinf(imagery_region_error(zero,inside)),
    "Absent and zero-W projection lost distinct semantics");
  require(imagery_region_error(zero,outside)==0.0&&imagery_region_error(absent,outside)==4096,
    "Triangle support became rectangular scalar support");
  auto envelope=absent;envelope.flags=5U;envelope.value.projection[6]=1;
  envelope.value.numerator_bound=32;
  require(valid_measurement_region(envelope)&&imagery_region_error(envelope,inside)==32,
    "Rectangular derivative envelope requires a triangle");
  zero.flags=1U;require(!valid_measurement_region(zero),"Unbounded projection without triangle accepted");
  zero.flags=8U;require(!valid_measurement_region(zero),"Unknown semantic flags accepted");
  absent.value.projection[0]=std::numeric_limits<double>::quiet_NaN();
  require(valid_measurement_region(absent),"Absent matrix participated in validation");
}
imagery_controller* observed=nullptr;bool free_order=true;
void before_free(std::size_t) {
  if(observed->input_allocated_bytes()<test_allocations::live_bytes)free_order=false;
}
void ownership() {
  using namespace test_allocations;
  imagery_controller controller,foreign;imagery_budget budget;budget.maximum_level=0U;
  const auto baseline=controller.input_allocated_bytes();
  imagery_input_work empty;
  allocations=0U;measuring=true;
  require(controller.stage_input(empty,0U,0U,0U,0U,0U)&&empty.complete(),"Empty input rejected");
  require(allocations==0U&&empty.allocated_bytes()==0U,"Empty input allocated");
  empty.cancel();
  constexpr std::size_t rows=16384U;
  const auto quote=imagery_input_work::work_bytes(1U,1U,rows,0U);
  imagery_input_work work;
  require(!controller.stage_input(work,1U,1U,rows,0U,quote-1U)&&!work.active()&&allocations==0U,
    "Short input grant allocated or changed work");
  fail_next=true;
  require(!controller.stage_input(work,1U,1U,rows,0U,quote)&&!work.active()&&allocations==0U,
    "State allocation failure published a partial transaction");
  observed=&controller;free_order=true;test_allocations::before_free=before_free;
  require(controller.stage_input(work,1U,1U,rows,0U,quote),"Funded input stage rejected");
  const auto staged=live_bytes;
  fail_next=true;bool refused=false;
  try{work.append_surface(7U,imagery::node_key(0,0,0),rows,0U);}catch(const std::bad_alloc&){refused=true;}
  require(refused&&!work.has_member()&&live_bytes==staged&&controller.input_allocated_bytes()==staged,
    "Canonical allocation failure changed member/account ownership");
  require(work.append_surface(7U,imagery::node_key(0,0,0),rows,0U),"Cannot open final canonical owner");
  require(!controller.commit_input(std::move(work),budget)&&work.active(),"Incomplete input committed");
  for(std::size_t i=0U;i<rows;++i)require(work.append_region(scalar(i==0?0U:i==1?335U:UINT32_MAX)),"Cannot fill canonical row");
  require(work.complete()&&live_bytes==work.allocated_bytes()&&live_bytes==controller.input_allocated_bytes(),
    "Canonical input has unowned payload");
  largest_allocation=0U;
  require(controller.commit_input(std::move(work),budget)&&!work.active(),"Complete input did not commit");
  require(largest_allocation<4096U,"Commit copied a region-sized array");
  measuring=false;
  auto input=controller.retain_surface(7U);measurement_region page[3];page[0].domain=99U;std::size_t count=99U;
  require(input&&!imagery_controller::read_input(input,0U,page,3U,count)&&count==0U&&page[0].domain==99U,
    "Partial normalization became a published mirror");
  const auto cut=finish(controller);
  require(cut.draws->size()==1U&&cut.maximum_pixel_error==16,"Canonical input changed scalar planning");
  require(imagery_controller::read_input(input,0U,page,3U,count)&&count==3U&&
    page[0].domain==0U&&page[1].domain==335U&&page[2].domain==UINT32_MAX,"Domain provenance changed at normalization");
  require(!imagery_controller::read_input(input,0U,page,257U,count)&&count==0U,"Unbounded canonical read accepted");
  require(!imagery_controller::read_input(input,rows+1U,page,1U,count),"Invalid canonical range accepted");
  require(imagery_controller::read_input(input,rows,nullptr,0U,count)&&count==0U,"Empty tail read rejected");
  const auto prior=controller.input_allocated_bytes();
  imagery_input_work peer;const auto retained_quote=imagery_input_work::work_bytes(1U,0U,0U,0U);
  measuring=true;
  require(controller.stage_input(peer,1U,0U,0U,0U,retained_quote)&&peer.append_retained(input,9U),"Retained input stage rejected");
  require(controller.input_allocated_bytes()-prior==peer.allocated_bytes(),"Retained payload charged twice");
  require(!foreign.commit_input(std::move(peer),budget)&&peer.complete(),"Foreign controller stole work");
  imagery_input_work foreign_work;
  measuring=false;
  require(foreign.stage_input(foreign_work,1U,0U,0U,0U,retained_quote)&&!foreign_work.append_retained(input,9U),
    "Foreign canonical payload admitted");foreign_work.cancel();
  const auto old_draws=cut.draws;
  controller.clear();
  require(controller.input_allocated_bytes()>rows*sizeof(measurement_region),"Clear refunded borrowed canonical input");
  require(imagery_controller::read_input(input,0U,page,3U,count)&&count==3U,"Clear invalidated immutable input");
  require(controller.commit_input(std::move(peer),budget),"Peer cannot commit after clear");
  require(finish(controller).draws->front().draw_index==9U&&old_draws->front().draw_index==7U,
    "Rebinding changed old output or retained draw index");
  input.reset();controller.clear();
  require(controller.input_allocated_bytes()==baseline&&live_bytes==0U&&free_order,"Canonical owner leaked or refunded before free");
  test_allocations::before_free=nullptr;
}
void failures_and_loans() {
  imagery_controller controller;imagery_input_work work;imagery_budget budget;budget.maximum_level=0U;
  const auto quote=imagery_input_work::work_bytes(1U,1U,1U,1U);
  require(controller.stage_input(work,1U,1U,1U,1U,quote)&&work.append_surface(1U,imagery::node_key(0,0,0),1U,1U),"Cannot open invalid-row case");
  auto bad=scalar();bad.flags=8U;
  require(!work.append_region(bad)&&work.failed()&&!controller.commit_input(std::move(work),budget),"Invalid row was committed");
  work.cancel();require(controller.input_allocated_bytes()==0U,"Invalid input leaked");
  require(controller.stage_input(work,1U,1U,1U,1U,quote)&&work.append_surface(1U,imagery::node_key(0,0,0),1U,1U)&&work.append_region(scalar()),"Cannot open invalid-hull case");
  require(!work.append_hull(core::vector2d{{std::numeric_limits<double>::infinity(),0}})&&work.failed(),"Invalid hull accepted");
  work.cancel();
  std::shared_ptr<const imagery_surface_input> loan;
  {
    imagery_controller temporary;imagery_input_work fresh;
    require(temporary.stage_input(fresh,1U,1U,1U,0U,imagery_input_work::work_bytes(1U,1U,1U,0U))&&
      fresh.append_surface(2U,imagery::node_key(0,0,0),1U,0U)&&fresh.append_region(scalar())&&
      temporary.commit_input(std::move(fresh),budget),"Cannot build surviving loan");
    finish(temporary);loan=temporary.retain_surface(2U);
  }
  measurement_region row;std::size_t count=0U;
  require(imagery_controller::read_input(loan,0U,&row,1U,count)&&count==1U&&row.value.pixels_per_uv==4096,
    "Controller destruction invalidated borrowed input");
}
struct failing_callback_copy {
  static bool fail;
  failing_callback_copy()=default;
  failing_callback_copy(const failing_callback_copy&){if(fail)throw std::bad_alloc();}
  std::string operator()(const imagery::node_key&,double)const{return "root";}
};
bool failing_callback_copy::fail=false;
void throwing_budget() {
  imagery_controller controller;imagery_input_work work;imagery_budget budget;
  budget.resource_key=failing_callback_copy();
  test_allocations::allocations=0U;test_allocations::measuring=true;
  const auto quote=imagery_input_work::work_bytes(64U,64U,64U,0U);
  require(controller.stage_input(work,64U,64U,64U,0U,quote),"Cannot stage callback failure case");
  for(unsigned i=0U;i<64U;++i)require(work.append_surface(i,imagery::node_key(0,0,0),1U,0U)&&
    work.append_region(scalar()),"Cannot fill callback failure case");
  failing_callback_copy::fail=true;bool threw=false;
  try{controller.commit_input(std::move(work),budget);}catch(const std::bad_alloc&){threw=true;}
  failing_callback_copy::fail=false;work.cancel();
  require(threw&&controller.input_allocated_bytes()==test_allocations::live_bytes,
    "Callback copy failure left transferred member storage uncharged");
  test_allocations::measuring=false;controller.clear();
  require(controller.input_allocated_bytes()==0U&&test_allocations::live_bytes==0U,"Failed commit leaked canonical input");
}
void native_producer() {
  // Actual CBDAM topology and frozen heights, matching the production sampler.
  const auto diamond=core::planar_root();lod_patch patch;patch.id=diamond.id();patch.fragment_mask=3U;
  for(unsigned i=0U;i<4U;++i)patch.corners[i]=diamond.corner(i);
  codec::height_patch record;record.rows=record.columns=17U;record.values.resize(289U);
  for(std::size_t i=0U;i<record.values.size();++i)record.values[i]=std::int32_t(i*13U%1024U)+200;
  height_storage storage(1024U*1024U);height_storage::handle heights;
  require(storage.root(record,heights)==codec::hierarchy_status::ok,"Cannot prepare CBDAM source");
  auto mesh=std::make_shared<patch_surface_mesh>();surface_source_parameters parameters;
  parameters.dimension=16U;parameters.height_scale=0.125;parameters.bounds=core::bounds2d({{-10,-5}},{{10,15}});
  require(describe_patch_surface(patch,0U,16U,false,parameters.radius,parameters.bounds,*mesh)==surface_mesh_status::ok,"Cannot describe CBDAM mesh");
  surface_source source(mesh,{},heights,parameters);core::payload_budget payload(16U*1024U*1024U);
  surface_model_work model_work(source,payload);require(model_work.admit(),"Model admission failed");
  surface_model_progress mp;
  do{mp=model_work.step(37U);}while(mp.status==surface_model_status::building);
  require(mp.status==surface_model_status::complete,"CBDAM model build failed");auto model=model_work.take_model();
  triangle_projection_context projection;projection.origin=source.origin();projection.scale_x=320;projection.scale_y=180;
  projection.matrix=matrix4d{{0.05,0,0,0,0,0.05,0,-0.25,0,0,0.001,0,0,0,0,1}};
  surface_measurement_options options;options.tight=true;
  surface_projection_work producer(model,projection,payload,options);surface_projection_progress progress;
  do {
    progress=producer.step(41U);
    if(progress.required_work_bytes)require(producer.admit(),"Projection admission failed");
    else require(progress.status==surface_projection_status::counting||progress.status==surface_projection_status::generating||
      progress.status==surface_projection_status::compacting||progress.status==surface_projection_status::complete,"Projection failed");
    require(progress.total_operations<1000000U,"Projection did not converge");
  }while(progress.status!=surface_projection_status::complete);
  const auto rows=progress.output_count;const std::size_t hull=model.layout().hull_count();
  require(producer.summary().visible&&rows>0U,"Producer comparison only tested culled geometry");
  imagery_surface oracle;oracle.draw_index=5U;oracle.source=imagery::node_key(0,0,0);oracle.regions.resize(rows);
  for(std::size_t first=0U;first<rows;first+=256U){std::size_t count=0U;require(producer.read(first,oracle.regions.data()+first,std::min(std::size_t(256),rows-first),count),"Cannot read oracle");}
  oracle.hull.assign(model.layout().hull(),model.layout().hull()+hull);
  imagery_controller direct,reference;imagery_budget budget;budget.maximum_level=4U;budget.maximum_texture_count=4096U;budget.maximum_draw_count=4096U;
  imagery_input_work work;const auto quote=imagery_input_work::work_bytes(1U,1U,rows,hull);
  require(direct.stage_input(work,1U,1U,rows,hull,quote)&&work.append_surface(5U,oracle.source,rows,hull),"Cannot admit direct producer output");
  require(!work.append_regions(producer,rows,1U)&&work.remaining_regions()==rows,"Bad direct range partly filled input");
  for(std::size_t first=0U;first<rows;first+=256U)require(work.append_regions(producer,first,std::min(std::size_t(256),rows-first)),"Direct semantic production failed");
  require(work.append_hull(model.layout(),0U,hull)&&direct.commit_input(std::move(work),budget),"Direct canonical handoff failed");
  producer.cancel();model=surface_model();model_work.cancel();source=surface_source();
  const auto expected=reference.plan({oracle},budget),actual=finish(direct);
  require(expected.complete&&expected.decisions_complete&&actual.maximum_pixel_error==expected.maximum_pixel_error&&actual.draws->size()==expected.draws->size(),"Direct production changed planning quality");
  for(std::size_t i=0U;i<actual.draws->size();++i) {
    const auto& a=(*actual.draws)[i];const auto& b=(*expected.draws)[i];
    require(a.draw_index==b.draw_index&&a.tile.level==b.tile.level&&a.tile.row==b.tile.row&&
      a.tile.column==b.tile.column&&a.pixel_error==b.pixel_error,"Direct production changed local node demand");
  }
  auto input=direct.retain_surface(5U);measurement_region row;std::size_t count=0U;
  for(std::size_t i=0U;i<rows;++i)require(imagery_controller::read_input(input,i,&row,1U,count)&&count==1U&&
    row.flags==oracle.regions[i].flags&&row.domain==oracle.regions[i].domain&&
    row.value.pixels_per_uv==imagery_region_error(oracle.regions[i],oracle.regions[i].value.uv),"Canonical normalization lost producer semantics");
  std::vector<core::vector2d> points(hull);
  require(imagery_controller::read_input_hull(input,0U,points.data(),hull,count)&&count==hull&&points==oracle.hull,"Canonical hull changed");
}
}
int main() {
  try {
    semantics();ownership();failures_and_loans();throwing_budget();native_producer();
    std::cout<<"Canonical imagery input: explicit semantics, funded ownership, bounded readers, retained peers and direct CBDAM production passed\n";return 0;
  }catch(const std::exception& e){test_allocations::measuring=false;test_allocations::before_free=nullptr;std::cerr<<e.what()<<'\n';return 1;}
}
