// Private test bridge: never added to the product C ABI or package.
#include <terra/frame/region_compaction.hpp>
#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace {
using terra::frame::measurement_region;
using terra::frame::region_compaction_work;
struct wire_row {std::uint32_t flags,domain;double values[21];};
static_assert(sizeof(wire_row)==176U,"Unexpected test wire layout");
std::uint32_t handles=0U;
struct fixture {
  std::shared_ptr<std::vector<measurement_region>> input;
  terra::core::payload_budget budget;
  terra::core::payload_budget::credit blocker;
  region_compaction_work work;
  fixture(const unsigned char* rows,std::uint32_t count,std::uint32_t limit,std::uint32_t blocked)
      :input(std::make_shared<std::vector<measurement_region>>(count)),budget(limit),work({input,input->data(),input->size()},budget) {
    for(std::uint32_t i=0U;i<count;++i) {
      wire_row wire;std::memcpy(&wire,rows+i*sizeof(wire),sizeof(wire));
      auto& row=(*input)[i];auto& r=row.value;row.flags=wire.flags;row.domain=wire.domain;const auto* v=wire.values;
      r.uv.minimum={{v[0],v[1]}};r.uv.maximum={{v[2],v[3]}};r.pixels_per_uv=v[4];
      std::copy_n(v+5U,9U,r.projection.begin());
      for(unsigned j=0U;j<3U;++j)r.triangle[j]={{v[14U+j*2U],v[15U+j*2U]}};
      r.numerator_bound=v[20];
    }
    if(blocked)budget.reserve(blocked==2U?limit:1U,blocker);
    ++handles;
  }
  ~fixture(){--handles;}
};
}
extern "C" {
std::uint32_t test_region_quote(std::uint32_t total,std::uint32_t projected) {
  return static_cast<std::uint32_t>(region_compaction_work::work_bytes(total,projected));
}
fixture* test_region_create(const unsigned char* rows,std::uint32_t count,std::uint32_t limit,std::uint32_t blocked) {
  return new fixture(rows,count,limit,blocked);
}
void test_region_step(fixture* task,std::uint32_t maximum_operations,double maximum_ms,unsigned char* output) {
  const auto p=task->work.step(maximum_operations,maximum_ms);
  const std::uint32_t result[]={static_cast<std::uint32_t>(p.status),static_cast<std::uint32_t>(p.operations),
    static_cast<std::uint32_t>(task->work.allocated_bytes()),static_cast<std::uint32_t>(p.required_work_bytes),
    static_cast<std::uint32_t>(p.output_count),static_cast<std::uint32_t>(p.total_operations)};
  std::memcpy(output,result,sizeof(result));
}
std::uint32_t test_region_admit(fixture* task){return task->work.admit()?1U:0U;}
std::uint32_t test_region_admit_reserved(fixture* task){return task->work.admit(task->blocker)?1U:0U;}
void test_region_unblock(fixture* task){task->blocker.clear();}
std::int32_t test_region_read(fixture* task,std::uint32_t first,std::uint32_t capacity,unsigned char* output) {
  if(capacity>256U)return -1;
  std::array<measurement_region,256U> rows;std::size_t count=0U;
  if(!task->work.read(first,rows.data(),capacity,count))return -1;
  for(std::size_t i=0U;i<count;++i) {
    wire_row w{};const auto& row=rows[i];const auto& r=row.value;
    w.flags=row.flags;w.domain=row.domain;w.values[0]=r.uv.minimum[0];w.values[1]=r.uv.minimum[1];
    w.values[2]=r.uv.maximum[0];w.values[3]=r.uv.maximum[1];w.values[4]=r.pixels_per_uv;
    std::copy(r.projection.begin(),r.projection.end(),w.values+5U);
    for(unsigned j=0U;j<3U;++j){w.values[14U+j*2U]=r.triangle[j][0];w.values[15U+j*2U]=r.triangle[j][1];}
    w.values[20]=r.numerator_bound;std::memcpy(output+i*sizeof(w),&w,sizeof(w));
  }
  return static_cast<std::int32_t>(count);
}
void test_region_cancel(fixture* task){task->work.cancel();}
void test_region_destroy(fixture* task){delete task;}
std::uint32_t test_region_handles(){return handles;}
}
