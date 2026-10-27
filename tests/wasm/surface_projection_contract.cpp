// Private fixture exports only; never part of the distributed C ABI.
#include <terra/frame/surface_projection.hpp>
#include "../../sdk/src/c_api/mesh_source.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace {
using namespace terra::frame;
std::uint32_t handles=0U;
struct fixture {
  terra::core::payload_budget budget;
  terra::core::payload_budget::credit blocker;
  std::vector<std::uint16_t> faces;
  bool resident;
  surface_projection_work work;
  fixture(surface_source source,const std::uint16_t* input,std::uint32_t count,
      triangle_projection_context projection,std::uint32_t limit)
      :budget(limit),faces(count),resident(source.resident_positions()),work(std::move(source),{{},faces.data(),faces.size()},projection,budget) {
    if(count)std::copy_n(input,count,faces.begin());
    ++handles;
  }
  ~fixture(){--handles;}
};
void write_region(const measurement_region& row,unsigned char* output) {
  std::uint32_t flags[]={row.flags,row.domain};std::memcpy(output,flags,8U);
  const auto& r=row.value;double values[21];
  values[0]=r.uv.minimum[0];values[1]=r.uv.minimum[1];values[2]=r.uv.maximum[0];values[3]=r.uv.maximum[1];values[4]=r.pixels_per_uv;
  std::copy(r.projection.begin(),r.projection.end(),values+5U);
  for(unsigned i=0U;i<3U;++i){values[14U+i*2U]=r.triangle[i][0];values[15U+i*2U]=r.triangle[i][1];}
  values[20]=r.numerator_bound;std::memcpy(output+8U,values,sizeof(values));
}
}
extern "C" {
std::uint32_t test_triangle_project(const unsigned char* parameters,const unsigned char* samples,
                                   std::uint32_t flags,unsigned char* output) {
  triangle_projection_context c;triangle_projection_input input;
  std::memcpy(c.matrix.data(),parameters,128U);std::memcpy(c.origin.data(),parameters+128U,24U);
  std::memcpy(&c.scale_x,parameters+152U,8U);std::memcpy(&c.scale_y,parameters+160U,8U);
  c.clip=bool(flags&1U);c.cull=bool(flags&2U);
  std::memcpy(input.positions.data(),samples,36U);std::memcpy(input.uv.data(),samples+36U,24U);
  projected_triangle out;if(!project_imagery_triangle(c,input,out))return 0U;
  std::memcpy(output,&out.vertex_count,4U);double values[47]{};
  values[0]=out.pixels_per_uv;values[1]=out.center_distance;
  std::copy(out.bounds.begin(),out.bounds.end(),values+2U);std::copy(out.projection.begin(),out.projection.end(),values+6U);
  for(unsigned i=0U;i<out.vertex_count;++i){values[15U+i*2U]=out.polygon[i][0];values[16U+i*2U]=out.polygon[i][1];}
  std::memcpy(output+4U,values,(15U+out.vertex_count*2U)*sizeof(double));return 1U;
}
fixture* test_projection_create(const terra_context* context,std::uint32_t plan_id,std::uint32_t resource_id,
    const std::uint16_t* faces,std::uint32_t count,const double* matrix,double sx,double sy,
    std::uint32_t flags,std::uint32_t limit) {
  surface_source source;
  if(!matrix||(count&&!faces)||count>3U*1048576U||!terra::c_api_detail::borrow_surface_source(context,plan_id,resource_id,source))return nullptr;
  triangle_projection_context c;std::copy_n(matrix,16U,c.matrix.begin());c.origin=source.origin();
  c.scale_x=sx;c.scale_y=sy;c.clip=bool(flags&1U);c.cull=bool(flags&2U);
  return new fixture(std::move(source),faces,count,c,limit);
}
void test_projection_step(fixture* task,std::uint32_t maximum,double ms,unsigned char* output) {
  const auto p=task->work.step(maximum,ms);
  const std::uint32_t values[]={static_cast<std::uint32_t>(p.status),static_cast<std::uint32_t>(p.operations),
    static_cast<std::uint32_t>(p.total_operations),static_cast<std::uint32_t>(p.required_work_bytes),
    static_cast<std::uint32_t>(p.raw_count),static_cast<std::uint32_t>(p.output_count),
    static_cast<std::uint32_t>(task->work.allocated_bytes()),static_cast<std::uint32_t>(task->work.authorized_bytes()),task->resident?1U:0U};
  std::memcpy(output,values,sizeof(values));
}
std::uint32_t test_projection_block(fixture* task,std::uint32_t bytes) {
  if(!bytes){task->blocker.clear();return 1U;}return task->budget.reserve(bytes,task->blocker)?1U:0U;
}
std::uint32_t test_projection_admit(fixture* task,std::uint32_t reserved) {
  if(!reserved)return task->work.admit()?1U:0U;
  const auto bytes=task->work.step(0U).required_work_bytes;
  terra::core::payload_budget::credit credit;
  return task->budget.reserve(bytes,credit)&&task->work.admit(credit)?1U:0U;
}
std::int32_t test_projection_read(fixture* task,std::uint32_t first,std::uint32_t maximum,unsigned char* output) {
  if(maximum>256U)return -1;
  std::array<measurement_region,256> rows;std::size_t count=0U;
  if(!task->work.read(first,rows.data(),maximum,count))return -1;
  for(std::size_t i=0U;i<count;++i)write_region(rows[i],output+i*176U);
  return static_cast<std::int32_t>(count);
}
void test_projection_summary(fixture* task,unsigned char* output) {
  const auto& s=task->work.summary();const std::uint32_t visible=s.visible?1U:0U;
  std::memcpy(output,&visible,4U);
  const double values[]={s.uv.minimum[0],s.uv.minimum[1],s.uv.maximum[0],s.uv.maximum[1],s.pixels_per_uv,s.center_distance};
  std::memcpy(output+4U,values,sizeof(values));
}
void test_projection_cancel(fixture* task){task->work.cancel();}
void test_projection_destroy(fixture* task){delete task;}
std::uint32_t test_projection_handles(){return handles;}
}
