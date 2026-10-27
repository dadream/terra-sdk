#include "compact_regions.hpp"
#include <terra/frame/triangle_projection.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace {
struct projection_parameters {
  double matrix[16],origin[3],scale_x,scale_y;
  std::uint32_t clip,cull;
};
static_assert(sizeof(terra_bench::region)==176U,"Unexpected imagery wire layout");
static_assert(sizeof(projection_parameters)==176U,"Unexpected experiment layout");
terra::frame::triangle_projection_context parameters(const projection_parameters& input) {
  terra::frame::triangle_projection_context result;
  std::copy_n(input.matrix,16U,result.matrix.begin());
  std::copy_n(input.origin,3U,result.origin.begin());
  result.scale_x=input.scale_x;result.scale_y=input.scale_y;
  result.clip=input.clip!=0U;result.cull=input.cull!=0U;
  return result;
}
template<class Accept> bool project(const projection_parameters* settings,const float* positions,
    const float* uv,const std::uint16_t* faces,std::uint32_t count,Accept accept) {
  const auto context=parameters(*settings);
  if(!terra::frame::valid_triangle_projection_context(context))return false;
  for(std::uint32_t f=0U;f<count;++f) {
    terra::frame::triangle_projection_input input;
    for(std::size_t i=0U;i<3U;++i) {
      const auto index=faces[f*3U+i];
      std::copy_n(positions+index*3U,3U,input.positions.begin()+i*3U);
      std::copy_n(uv+index*2U,2U,input.uv.begin()+i*2U);
    }
    terra::frame::projected_triangle result;
    if(!terra::frame::project_imagery_triangle(context,input,result))return false;
    if(result.vertex_count>=3U&&result.bounds[2]>result.bounds[0]&&result.bounds[3]>result.bounds[1]&&!accept(result))return false;
  }
  return true;
}
}

extern "C" {
std::uint32_t bench_region_bytes(std::uint32_t count){return terra_bench::region_work_bytes(count);}
terra_bench::region* bench_copy_output(const terra_bench::region* input,std::uint32_t count,
    void* buffer,std::uint32_t first,std::uint32_t range) {
  return terra_bench::copy_region_output(input,count,buffer,first,range);
}
std::uint32_t bench_compact(const terra_bench::region* input,std::uint32_t count,
    void* buffer,std::uint32_t bytes) {
  if(bytes<terra_bench::region_work_bytes(count))return 0xffffffffU;
  return terra_bench::compact_regions(input,count,buffer);
}

std::uint32_t bench_count(const projection_parameters* settings,const float* positions,
    const float* uv,const std::uint16_t* faces,std::uint32_t count) {
  std::uint32_t regions=0U;
  const bool ok=project(settings,positions,uv,faces,count,[&](const terra::frame::projected_triangle& value){
    regions+=value.vertex_count-2U;return regions<=1048576U;});
  return ok?regions:0xffffffffU;
}

std::uint32_t bench_project(const projection_parameters* settings,const float* positions,
    const float* uv,const std::uint16_t* faces,std::uint32_t count,
    terra_bench::region* input,std::uint32_t capacity,void* buffer,std::uint32_t bytes) {
  if(bytes<terra_bench::region_work_bytes(capacity))return 0xffffffffU;
  std::uint32_t used=0U;
  const bool ok=project(settings,positions,uv,faces,count,[&](const terra::frame::projected_triangle& value){
    if(value.vertex_count-2U>capacity-used)return false;
    for(std::uint32_t j=1U;j+1U<value.vertex_count;++j) {
      auto& out=input[used++];out={};
      const auto& a=value.polygon[0];const auto& b=value.polygon[j];const auto& c=value.polygon[j+1U];
      out.minimum_u=std::min({a[0],b[0],c[0]});out.maximum_u=std::max({a[0],b[0],c[0]});
      out.minimum_v=std::min({a[1],b[1],c[1]});out.maximum_v=std::max({a[1],b[1],c[1]});
      out.pixels_per_uv=value.pixels_per_uv;out.numerator_bound=-1.0;out.flags=3U;out.domain=UINT32_MAX;
      std::copy_n(value.projection.begin(),9U,out.projection);
      std::copy_n(a.begin(),2U,out.triangle_uv);std::copy_n(b.begin(),2U,out.triangle_uv+2U);std::copy_n(c.begin(),2U,out.triangle_uv+4U);
    }
    return true;
  });
  if(!ok||used!=capacity)return 0xffffffffU;
  return terra_bench::compact_regions(input,used,buffer);
}

terra_status bench_stage(terra_context* context,std::uint32_t session,
    const terra_imagery_region_v4* input,std::uint32_t input_count,void* buffer,std::uint32_t count,
    const terra_imagery_options_v4* options,std::uint32_t credit,std::uint32_t* metrics) {
  auto status=terra_stage_imagery_input(context,session,options,1U,1U,count,0U,credit,1U);
  if(status!=TERRA_STATUS_OK)return status;
  terra_imagery_surface_v3 surface{};
  surface.struct_size=sizeof(surface);surface.region_count=count;
  status=terra_append_imagery_surface(context,session,&surface);
  for(std::uint32_t first=0U;status==TERRA_STATUS_OK&&first<count;first+=256U) {
    const auto range=std::min(256U,count-first);
    const auto* regions=terra_bench::copy_region_output(input,input_count,buffer,first,range);
    if(!regions)status=TERRA_STATUS_INVALID_ARGUMENT;
    else status=terra_append_imagery_regions(context,session,regions,range);
  }
  if(status==TERRA_STATUS_OK)status=terra_commit_imagery_input(context,session,1U);
  if(status!=TERRA_STATUS_OK){terra_cancel_imagery_input(context,session);return status;}
  metrics[0]=0U;metrics[1]=terra_imagery_payload_bytes(context);
  std::uint32_t complete=0U;
  do {
    status=terra_step_imagery(context,session,16U,64U,0.0,
      terra_imagery_reference_work_bytes(context,session),terra_imagery_output_work_bytes(context,session),&complete);
    ++metrics[0];metrics[1]=std::max(metrics[1],terra_imagery_payload_bytes(context));
    if(status!=TERRA_STATUS_OK)return status;
  }while(!complete&&metrics[0]<100000U);
  return complete?TERRA_STATUS_OK:TERRA_STATUS_INVALID_STATE;
}
}
