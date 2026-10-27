#include <terra/c_api/terra.h>
#include <terra/frame/surface_projection.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

namespace {
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
void ok(terra_status value){require(value==TERRA_STATUS_OK,"Native measurement C API failed");}
std::vector<std::uint8_t> read(const char* name) {
  std::ifstream file(name,std::ios::binary|std::ios::ate);require(bool(file),"Cannot open terrain record");
  const auto size=file.tellg();file.seekg(0);std::vector<std::uint8_t> result(static_cast<std::size_t>(size));
  file.read(reinterpret_cast<char*>(result.data()),size);require(bool(file),"Cannot read terrain record");return result;
}
terra_terrain_manifest_v3 manifest() {
  terra_terrain_manifest_v3 m{};m.struct_size=sizeof(m);m.api_version=TERRA_C_API_VERSION;
  m.format_version=1U;m.patch_dimension=64U;m.transform=TERRA_TRANSFORM_PLANAR;
  m.height_scale_factor=0.0000976563;m.maximum_u=m.maximum_v=1025.0;return m;
}
std::vector<terra_mesh_resource_v3> resources(terra_context* c,std::uint32_t plan=0U) {
  std::size_t count=0U;
  const auto size=plan?terra_get_prepared_mesh_resources(c,plan,nullptr,0U,&count):terra_get_mesh_resources(c,nullptr,0U,&count);
  require(size==TERRA_STATUS_OK||size==TERRA_STATUS_BUFFER_TOO_SMALL,"Cannot size mesh resources");
  std::vector<terra_mesh_resource_v3> out(count);
  ok(plan?terra_get_prepared_mesh_resources(c,plan,out.data(),count,&count):terra_get_mesh_resources(c,out.data(),count,&count));return out;
}
std::uint32_t model(terra_context* c,std::uint32_t resource,std::uint32_t plan=0U) {
  const auto before=terra_imagery_input_payload_bytes(c),quote=terra_surface_model_work_bytes();std::uint32_t id=99U;
  require(terra_open_surface_model(c,plan,resource,0U,quote-1U,&id)==TERRA_STATUS_RESOURCE_LIMIT&&id==99U&&
    terra_imagery_input_payload_bytes(c)==before,"Short metadata grant allocated");
  ok(terra_open_surface_model(c,plan,resource,0U,quote,&id));return id;
}
std::uint32_t finish_model(terra_context* c,std::uint32_t id,std::uint32_t quantum) {
  terra_surface_work_v1 p{};p.struct_size=sizeof(p);ok(terra_step_surface_model(c,id,0U,0.0,0U,0U,&p));
  const auto initial_quote=p.required_work_bytes;
  for(unsigned turn=0U;turn<100000U;++turn) {
    if(p.phase==2U)return initial_quote;
    const auto grant=p.required_work_bytes,token=p.quote_id;
    if(grant) {
      const auto before=terra_imagery_input_payload_bytes(c);auto copy=p;
      require(terra_step_surface_model(c,id,quantum,0.0,p.quote_id,grant-1U,&copy)==TERRA_STATUS_RESOURCE_LIMIT&&
        terra_imagery_input_payload_bytes(c)==before,"Short model arena grant advanced work");
      require(terra_step_surface_model(c,id,quantum,0.0,p.quote_id+1U,grant,&copy)==TERRA_STATUS_INVALID_STATE&&
        terra_imagery_input_payload_bytes(c)==before,"Stale model stage grant advanced work");
    }
    ok(terra_step_surface_model(c,id,quantum,0.0,p.quote_id,grant,&p));require(p.operations<=quantum,"Model ignored quantum");
    if(grant) {
      const auto charged=terra_imagery_input_payload_bytes(c);auto copy=p;
      require(terra_step_surface_model(c,id,quantum,0.0,token,grant,&copy)==TERRA_STATUS_INVALID_STATE&&
        terra_imagery_input_payload_bytes(c)==charged,"Consumed model grant was accepted twice");
    }
    require(p.phase<=2U,"Model reached failure state");
  }
  require(false,"Model did not converge");
  return 0U;
}
struct measured {
  std::uint32_t id=0U;terra_surface_work_v1 progress{};terra_surface_summary_v1 summary{};
  std::vector<terra_imagery_region_v4> rows;
};
measured measure(terra_context* c,std::uint32_t session,std::uint32_t model_id,std::uint32_t quantum,
    unsigned flags=0U,bool inject_failures=false,std::uint32_t previous=0U) {
  terra_camera_snapshot_v1 camera{};camera.struct_size=sizeof(camera);ok(terra_get_camera_snapshot(c,&camera));
  terra_surface_projection_v1 options{};options.struct_size=sizeof(options);options.api_version=TERRA_C_API_VERSION;
  options.model_id=model_id;options.flags=flags;options.view_revision=17U;options.source_revision=23U;
  options.previous_measurement_id=previous;
  std::copy_n(camera.projection_view,16U,options.matrix);options.scale_x=320;options.scale_y=180;
  measured value;const auto quote=terra_surface_measurement_work_bytes(),before=terra_imagery_input_payload_bytes(c);
  require(terra_open_surface_measurement(c,session,&options,nullptr,0U,quote-1U,&value.id)==TERRA_STATUS_RESOURCE_LIMIT&&
    terra_imagery_input_payload_bytes(c)==before,"Short projection metadata grant allocated");
  std::array<std::uint32_t,257U> oversized{};
  require(terra_open_surface_measurement(c,session,&options,oversized.data(),oversized.size(),quote,&value.id)==TERRA_STATUS_INVALID_ARGUMENT&&
    terra_imagery_input_payload_bytes(c)==before,"Too many domains allocated a task");
  if(inject_failures) {
    test_allocations::fail_next=true;
    require(terra_open_surface_measurement(c,session,&options,nullptr,0U,quote,&value.id)==TERRA_STATUS_RESOURCE_LIMIT&&
      value.id==0U&&terra_imagery_input_payload_bytes(c)==before,"Failed measurement metadata leaked credit or published a handle");
  }
  ok(terra_open_surface_measurement(c,session,&options,nullptr,0U,quote,&value.id));
  auto& p=value.progress;p.struct_size=sizeof(p);ok(terra_step_surface_measurement(c,session,value.id,0U,0.0,0U,0U,&p));
  bool canonical_failed=false;
  for(unsigned turn=0U;turn<100000U&&p.phase!=TERRA_SURFACE_MEASUREMENT_READY;++turn) {
    require(p.phase<TERRA_SURFACE_MEASUREMENT_READY,"Measurement reached failure state");
    const auto grant=p.required_work_bytes,token=p.quote_id;
    if(grant) {
      const auto charged=terra_imagery_input_payload_bytes(c);auto copy=p;
      require(terra_step_surface_measurement(c,session,value.id,quantum,0.0,p.quote_id,grant-1U,&copy)==TERRA_STATUS_RESOURCE_LIMIT&&
        terra_imagery_input_payload_bytes(c)==charged,"Short projection/input grant advanced work");
      require(terra_step_surface_measurement(c,session,value.id,quantum,0.0,p.quote_id+1U,grant,&copy)==TERRA_STATUS_INVALID_STATE&&
        terra_imagery_input_payload_bytes(c)==charged,"Stale projection/input stage grant advanced work");
      if(inject_failures&&p.phase==TERRA_SURFACE_MEASUREMENT_WAITING_FOR_INPUT&&!canonical_failed) {
        test_allocations::fail_next=true;
        require(terra_step_surface_measurement(c,session,value.id,quantum,0.0,token,grant,&copy)==TERRA_STATUS_RESOURCE_LIMIT&&
          terra_imagery_input_payload_bytes(c)==charged,"Failed canonical allocation leaked or consumed the retryable stage");
        canonical_failed=true;
      }
    }
    ok(terra_step_surface_measurement(c,session,value.id,quantum,0.0,p.quote_id,grant,&p));
    if(grant) {
      const auto charged=terra_imagery_input_payload_bytes(c);auto copy=p;
      require(terra_step_surface_measurement(c,session,value.id,quantum,0.0,token,grant,&copy)==TERRA_STATUS_INVALID_STATE&&
        terra_imagery_input_payload_bytes(c)==charged,"Consumed projection/input grant was accepted twice");
    }
    require(p.operations<=quantum&&p.model_id==model_id&&p.view_revision==17U&&p.source_revision==23U,
      "Native work changed its immutable identity or quantum");
  }
  require(p.phase==TERRA_SURFACE_MEASUREMENT_READY&&p.region_count==p.normalized_regions,"Measurement did not seal normalized input");
  require(!inject_failures||canonical_failed,"Canonical allocation failure was not exercised");
  value.summary.struct_size=sizeof(value.summary);ok(terra_get_surface_measurement_summary(c,value.id,&value.summary));
  value.rows.resize(p.region_count);
  for(unsigned first=0U;first<p.region_count;first+=256U) {
    std::uint32_t count=0U;
    ok(terra_get_surface_measurement_regions(c,session,value.id,first,value.rows.data()+first,std::min(256U,p.region_count-first),&count));
    require(count==std::min(256U,p.region_count-first),"Bounded canonical read lost rows");
  }
  return value;
}
void allocation_failures(terra_context* c,std::uint32_t resource,std::uint32_t session) {
  const auto base=terra_imagery_input_payload_bytes(c);std::uint32_t id=99U;
  test_allocations::fail_next=true;
  require(terra_open_surface_model(c,0U,resource,0U,terra_surface_model_work_bytes(),&id)==TERRA_STATUS_RESOURCE_LIMIT&&
    id==99U&&terra_imagery_input_payload_bytes(c)==base,"Failed model metadata leaked or changed output");
  id=model(c,resource);terra_surface_work_v1 p{};p.struct_size=sizeof(p);
  ok(terra_step_surface_model(c,id,0U,0.0,0U,0U,&p));
  const auto metadata=terra_imagery_input_payload_bytes(c);test_allocations::fail_next=true;
  require(terra_step_surface_model(c,id,1U,0.0,p.quote_id,p.required_work_bytes,&p)==TERRA_STATUS_RESOURCE_LIMIT&&
    terra_imagery_input_payload_bytes(c)==metadata,"Failed model arena retained credit");
  ok(terra_step_surface_model(c,id,0U,0.0,0U,0U,&p));
  require(p.phase==5U&&!p.required_work_bytes&&!p.quote_id,"Failed model still advertised an allocation quote");
  ok(terra_close_surface_model(c,id));require(terra_imagery_input_payload_bytes(c)==base,"Failed model cancellation leaked");
  id=model(c,resource);finish_model(c,id,4096U);
  terra_camera_snapshot_v1 camera{};camera.struct_size=sizeof(camera);ok(terra_get_camera_snapshot(c,&camera));
  terra_surface_projection_v1 request{};request.struct_size=sizeof(request);request.api_version=TERRA_C_API_VERSION;
  request.model_id=id;std::copy_n(camera.projection_view,16U,request.matrix);request.scale_x=320;request.scale_y=180;
  std::uint32_t pending=0U;
  ok(terra_open_surface_measurement(c,session,&request,nullptr,0U,terra_surface_measurement_work_bytes(),&pending));
  ok(terra_step_surface_measurement(c,session,pending,0U,0.0,0U,0U,&p));
  const auto occupied=terra_imagery_input_payload_bytes(c);test_allocations::fail_next=true;
  require(terra_step_surface_measurement(c,session,pending,1U,0.0,p.quote_id,p.required_work_bytes,&p)==TERRA_STATUS_RESOURCE_LIMIT&&
    terra_imagery_input_payload_bytes(c)==occupied,"Failed projection workspace retained credit");
  ok(terra_step_surface_measurement(c,session,pending,0U,0.0,0U,0U,&p));
  require(p.phase==TERRA_SURFACE_MEASUREMENT_ALLOCATION_FAILED&&!p.required_work_bytes&&!p.quote_id,
    "Failed measurement still advertised an allocation quote");
  ok(terra_close_surface_measurement(c,pending));ok(terra_close_surface_model(c,id));
  require(terra_imagery_input_payload_bytes(c)==base,"Failed measurement cancellation leaked");
}
void refinement_lifetime(terra_context* c,const std::vector<terra_mesh_resource_v3>& meshes,
    std::uint32_t session,std::uint32_t foreign_session) {
  const auto base=terra_imagery_input_payload_bytes(c),native=model(c,meshes.front().resource_id);
  finish_model(c,native,4096U);const auto previous=measure(c,session,native,4096U);
  require(previous.summary.visible&&previous.summary.refinable&&!previous.rows.empty(),"No scalar refinement fixture");
  terra_camera_snapshot_v1 camera{};camera.struct_size=sizeof(camera);ok(terra_get_camera_snapshot(c,&camera));
  terra_surface_projection_v1 request{};request.struct_size=sizeof(request);request.api_version=TERRA_C_API_VERSION;
  request.model_id=native;request.flags=1U;request.view_revision=18U;request.source_revision=23U;
  request.previous_measurement_id=previous.id;request.scale_x=320;request.scale_y=180;
  std::copy_n(camera.projection_view,16U,request.matrix);
  const auto reject=[&](terra_surface_projection_v1 value,std::uint32_t target=0U) {
    const auto bytes=terra_imagery_input_payload_bytes(c);std::uint32_t output=99U;
    require(terra_open_surface_measurement(c,target?target:session,&value,nullptr,0U,
      terra_surface_measurement_work_bytes(),&output)==TERRA_STATUS_INVALID_STATE&&output==99U&&
      terra_imagery_input_payload_bytes(c)==bytes,"Mismatched refinement identity allocated or published work");
  };
  auto changed=request;changed.matrix[0]+=1e-12;reject(changed);
  changed=request;changed.scale_y*=2;reject(changed);
  changed=request;++changed.source_revision;reject(changed);reject(request,foreign_session);
  require(meshes.size()>1U,"No foreign immutable resource fixture");
  const auto foreign=model(c,meshes.back().resource_id);finish_model(c,foreign,4096U);
  changed=request;changed.model_id=foreign;reject(changed);ok(terra_close_surface_model(c,foreign));
  std::uint32_t joined=0U;
  ok(terra_open_surface_measurement(c,session,&request,nullptr,0U,terra_surface_measurement_work_bytes(),&joined));
  terra_surface_work_v1 p{};p.struct_size=sizeof(p);ok(terra_step_surface_measurement(c,session,joined,0U,0.0,0U,0U,&p));
  require(p.phase==TERRA_SURFACE_MEASUREMENT_INSPECTING_PREVIOUS&&!p.required_work_bytes&&!p.quote_id,
    "Previous inspection allocated work before discovering its loose domains");
  ok(terra_close_surface_measurement(c,previous.id));ok(terra_close_surface_model(c,native));
  for(unsigned turn=0U;turn<100000U&&p.phase!=TERRA_SURFACE_MEASUREMENT_READY;++turn) {
    ok(terra_step_surface_measurement(c,session,joined,17U,0.0,p.quote_id,p.required_work_bytes,&p));
    require(p.phase<=TERRA_SURFACE_MEASUREMENT_READY&&p.operations<=17U&&p.model_id==native&&p.view_revision==18U,
      "Closed previous/model handles invalidated their real active loans");
  }
  require(p.phase==TERRA_SURFACE_MEASUREMENT_READY&&p.region_count>0U,"Refinement lost complete numeric coverage");
  terra_surface_summary_v1 summary{};summary.struct_size=sizeof(summary);ok(terra_get_surface_measurement_summary(c,joined,&summary));
  require(summary.visible&&!summary.refinable,"Refinement did not seal a tight complete snapshot");
  ok(terra_close_surface_measurement(c,joined));require(terra_imagery_input_payload_bytes(c)==base,"Refinement retained prior/model loans");
  const auto peer=model(c,meshes.front().resource_id);finish_model(c,peer,4096U);
  const auto kept=measure(c,session,peer,4096U);request.model_id=peer;request.previous_measurement_id=kept.id;
  const auto occupied=terra_imagery_input_payload_bytes(c);
  ok(terra_open_surface_measurement(c,session,&request,nullptr,0U,terra_surface_measurement_work_bytes(),&joined));
  ok(terra_step_surface_measurement(c,session,joined,1U,0.0,0U,0U,&p));ok(terra_close_surface_measurement(c,joined));
  require(terra_imagery_input_payload_bytes(c)==occupied,"Inspection cancellation refunded a live previous/model peer");
  ok(terra_get_surface_measurement_summary(c,kept.id,&summary));
  ok(terra_close_surface_measurement(c,kept.id));ok(terra_close_surface_model(c,peer));
  require(terra_imagery_input_payload_bytes(c)==base,"Cancelled refinement leaked");
}
}
int main(int argc,char** argv) {
  try {
    require(argc==3,"Expected real planar root and detail records");
    const auto root=read(argv[1]),detail=read(argv[2]);
    std::unique_ptr<terra_context,decltype(&terra_destroy)> owner(terra_create(),terra_destroy);auto* c=owner.get();
    const auto m=manifest();ok(terra_load_terrain_manifest(c,&m));
    terra_viewport_v1 viewport{};viewport.struct_size=sizeof(viewport);viewport.width=640;viewport.height=360;viewport.vertical_fov_radians=0.7;
    ok(terra_set_viewport(c,&viewport));ok(terra_set_planar_target(c,600,400));
    terra_camera_v3 camera{};camera.struct_size=sizeof(camera);camera.distance=3000;ok(terra_set_camera(c,&camera));
    for(unsigned i=0U;i<3U;++i) {
      ok(terra_update(c,0.02F));std::size_t count=0U;terra_get_requests(c,nullptr,0U,&count);
      std::vector<terra_request_v1> requests(count);ok(terra_get_requests(c,requests.data(),count,&count));
      for(const auto& request:requests) {
        const auto& bytes=request.kind==TERRA_REQUEST_ROOT?root:detail;
        ok(terra_submit_record(c,request.kind,&request.key,bytes.data(),bytes.size()));
      }
    }
    const auto meshes=resources(c);require(!meshes.empty(),"Fixture has no real terrain");
    std::uint32_t session=0U,other=0U;ok(terra_open_imagery(c,&session));ok(terra_open_imagery(c,&other));
    allocation_failures(c,meshes.front().resource_id,session);
    refinement_lifetime(c,meshes,session,other);
    const auto base=terra_imagery_input_payload_bytes(c);const auto native=model(c,meshes.front().resource_id);
    const auto initial_quote=finish_model(c,native,17U);
    std::uint32_t reused=0U;
    ok(terra_open_surface_model(c,0U,meshes.front().resource_id,native,terra_surface_model_work_bytes(),&reused));
    require(finish_model(c,reused,4096U)<initial_quote,"C API layout reuse rebuilt the full UV layout");
    ok(terra_close_surface_model(c,reused));
    const auto first=measure(c,session,native,13U,0U,true),second=measure(c,session,native,4096U);
    require(first.summary.visible&&!first.rows.empty(),"Contract tested only invisible terrain");
    require(first.rows.size()==second.rows.size(),"Yield boundaries changed output count");
    for(std::size_t i=0U;i<first.rows.size();++i) {
      const auto& a=first.rows[i];const auto& b=second.rows[i];
      require(a.flags==b.flags&&a.domain==b.domain&&a.pixels_per_uv==b.pixels_per_uv&&
        std::equal(a.projection,a.projection+9U,b.projection)&&std::equal(a.triangle_uv,a.triangle_uv+6U,b.triangle_uv),
        "Yield boundaries changed canonical values");
    }
    const auto charged=terra_imagery_input_payload_bytes(c);ok(terra_close_surface_model(c,native));
    require(terra_imagery_input_payload_bytes(c)<charged,"Canonical result pinned its model/production scratch");
    terra_surface_summary_v1 summary{};summary.struct_size=sizeof(summary);ok(terra_get_surface_measurement_summary(c,first.id,&summary));
    terra_imagery_options_v4 options{};options.struct_size=sizeof(options);options.api_version=TERRA_C_API_VERSION;
    options.tile_size=256;options.maximum_level=options.source_maximum_level=0;options.source_root_columns=options.source_root_rows=1;
    options.maximum_texture_count=options.maximum_draw_count=64;options.requested_pixel_error=1.25;
    const auto members=terra_imagery_input_work_bytes(1U,0U,0U,0U);
    ok(terra_stage_imagery_input(c,other,&options,1U,0U,0U,0U,members,0U));
    require(terra_append_measured_imagery_surface(c,other,first.id,7U)==TERRA_STATUS_INVALID_STATE,"Foreign session accepted input");
    ok(terra_cancel_imagery_input(c,other));
    ok(terra_stage_imagery_input(c,session,&options,1U,0U,0U,0U,members,0U));
    test_allocations::largest_allocation=0U;test_allocations::allocations=0U;test_allocations::measuring=true;
    ok(terra_append_measured_imagery_surface(c,session,first.id,7U));
    require(test_allocations::allocations==0U,"Appending the canonical owner allocated/copies rows");
    ok(terra_commit_imagery_input(c,session,1U));test_allocations::measuring=false;
    require(test_allocations::largest_allocation<4096U,"Planner handoff copied the region array");
    ok(terra_close_surface_measurement(c,first.id));ok(terra_close_surface_measurement(c,second.id));
    require(terra_imagery_input_payload_bytes(c)>base,"Closing result refunded the planner's canonical loan");
    std::uint32_t complete=0U;
    for(unsigned i=0U;i<10000U&&!complete;++i)ok(terra_step_imagery(c,session,8U,8U,0.0,UINT32_MAX,UINT32_MAX,&complete));
    require(complete,"Sealed input did not plan");
    ok(terra_reset_imagery(c,session));require(terra_imagery_input_payload_bytes(c)==base,"Canonical planner loan leaked");
    const auto surviving=model(c,meshes.front().resource_id);finish_model(c,surviving,4096U);
    const auto closed=measure(c,other,surviving,4096U);
    ok(terra_close_imagery(c,other));summary.struct_size=sizeof(summary);
    require(terra_get_surface_measurement_summary(c,closed.id,&summary)==TERRA_STATUS_INVALID_STATE,
      "Session close retained canonical measurement handles");
    ok(terra_close_surface_model(c,surviving));require(terra_imagery_input_payload_bytes(c)==base,"Session close stranded input credit");
    const auto stale=model(c,meshes.front().resource_id);ok(terra_load_terrain_manifest(c,&m));
    terra_surface_work_v1 p{};p.struct_size=sizeof(p);
    require(terra_step_surface_model(c,stale,1U,0.0,1U,UINT32_MAX,&p)==TERRA_STATUS_INVALID_STATE&&
      terra_imagery_input_payload_bytes(c)==0U,"Dataset reset retained work or accepted late grants");
    std::cout<<"Native model/projection/input production, exact credit, immutable identities, canonical loans and no-copy planner handoff passed\n";
    return 0;
  }catch(const std::exception& error){test_allocations::measuring=false;std::cerr<<error.what()<<'\n';return 1;}
}
