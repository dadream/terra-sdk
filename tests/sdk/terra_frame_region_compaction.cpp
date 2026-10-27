#include <terra/frame/region_compaction.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using namespace terra::frame;
using terra::core::payload_budget;
using region_list=std::vector<measurement_region>;
measurement_region_view view(std::shared_ptr<const region_list> input){return {input,input->data(),input->size()};}
constexpr double infinity=std::numeric_limits<double>::infinity();
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
std::uint32_t u32(std::istream& stream) {
  unsigned char bytes[4]{};stream.read(reinterpret_cast<char*>(bytes),4);
  require(bool(stream),"Truncated oracle integer");
  return std::uint32_t(bytes[0])|(std::uint32_t(bytes[1])<<8U)|(std::uint32_t(bytes[2])<<16U)|(std::uint32_t(bytes[3])<<24U);
}
double number(std::istream& stream) {
  unsigned char bytes[8]{};stream.read(reinterpret_cast<char*>(bytes),8);require(bool(stream),"Truncated oracle number");
  std::uint64_t bits=0U;for(unsigned i=0U;i<8U;++i)bits|=std::uint64_t(bytes[i])<<(i*8U);
  double value;std::memcpy(&value,&bits,8U);return value;
}
measurement_region read_region(std::istream& stream) {
  measurement_region row;row.flags=u32(stream);row.domain=u32(stream);auto& r=row.value;
  r.uv.minimum={{number(stream),number(stream)}};r.uv.maximum={{number(stream),number(stream)}};
  r.pixels_per_uv=number(stream);for(double& v:r.projection)v=number(stream);
  for(auto& p:r.triangle)for(double& v:p)v=number(stream);
  r.numerator_bound=number(stream);return row;
}
struct fixture {std::string name;region_list input,expected;};
std::vector<fixture> fixtures(const char* file) {
  std::ifstream stream(file,std::ios::binary);char magic[8]{};stream.read(magic,8);
  require(std::memcmp(magic,"TERRARC1",8U)==0,"Invalid oracle format");
  const auto count=u32(stream);require(count==23U,"Missing frozen numeric cases");
  std::vector<fixture> result;
  for(std::uint32_t i=0U;i<count;++i) {
    fixture c;const auto length=u32(stream);require(length<256U,"Invalid oracle name");
    c.name.resize(length);stream.read(&c.name[0],length);
    const auto n=u32(stream),m=u32(stream);require(n<65536U&&m<196608U,"Invalid oracle dimensions");
    for(std::uint32_t j=0U;j<n;++j)c.input.push_back(read_region(stream));
    for(std::uint32_t j=0U;j<m;++j)c.expected.push_back(read_region(stream));
    result.push_back(std::move(c));
  }
  require(stream.peek()==std::char_traits<char>::eof(),"Unclaimed oracle bytes");return result;
}
std::array<double,21> values(const measurement_region& row) {
  std::array<double,21> out;const auto& r=row.value;
  out[0]=r.uv.minimum[0];out[1]=r.uv.minimum[1];out[2]=r.uv.maximum[0];out[3]=r.uv.maximum[1];out[4]=r.pixels_per_uv;
  std::copy(r.projection.begin(),r.projection.end(),out.begin()+5);
  for(unsigned i=0U;i<3U;++i){out[14U+i*2U]=r.triangle[i][0];out[15U+i*2U]=r.triangle[i][1];}
  out[20]=r.numerator_bound;return out;
}
void compare(const measurement_region& expected,const measurement_region& actual) {
  require(expected.flags==actual.flags&&expected.domain==actual.domain,"Output presence/provenance differs from frozen JS");
  const auto a=values(expected),b=values(actual);
  for(unsigned i=0U;i<21U;++i) {
    // A copied input must remain bit-exact. Merged coordinates also reference
    // original points exactly; only computed density can vary by libm rounding.
    if(expected.domain!=UINT32_MAX||(i!=4U&&i!=6U&&i!=10U))
      require(std::memcmp(&a[i],&b[i],sizeof(double))==0,"Output numeric identity/order differs from frozen JS");
    else require(a[i]==b[i]||(std::isfinite(a[i])&&std::isfinite(b[i])&&std::abs(a[i]-b[i])<=std::max(1e-11,std::abs(a[i])*1e-11)),"Output density differs from frozen JS");
  }
}
payload_budget* observed_budget=nullptr;
bool refund_order=true;
void confirm_live_credit(std::size_t bytes){if(observed_budget->work_bytes()<bytes)refund_order=false;}
void reset_observation(payload_budget& budget) {
  using namespace test_allocations;
  require(live_bytes==0U,"Previous task leaked work");
  peak_bytes=allocations=largest_allocation=0U;observed_budget=&budget;refund_order=true;before_free=confirm_live_credit;measuring=true;
}
void finish_observation() {
  test_allocations::measuring=false;test_allocations::before_free=nullptr;
  require(test_allocations::live_bytes==0U&&refund_order,"Credit refunded before actual work disposal");
}
void verify(const fixture& c,std::size_t quantum) {
  auto input=std::make_shared<const region_list>(c.input);
  const auto projected=std::count_if(input->begin(),input->end(),[](const measurement_region& r){return bool(r.flags&1U);});
  const auto quote=region_compaction_work::work_bytes(input->size(),projected);
  payload_budget budget(quote+64U);auto resident=budget.resident_credit();payload_budget::credit old;
  require(budget.reserve(64U,old),"Cannot fund old display");budget.adopt(old,resident,64U);
  payload_budget::credit blocker;if(quote)require(budget.reserve(1U,blocker),"Cannot create one-byte shortage");
  std::array<measurement_region,256> window;window[0].domain=42U;
  reset_observation(budget);
  {
    region_compaction_work task(view(input),budget);
    require(!task.admit(),"Task allocated before validating its input");
    require(task.step(0U).operations==0U,"Zero work budget did work");
    std::size_t copied=99U;require(!task.read(0U,window.data(),1U,copied)&&copied==0U&&window[0].domain==42U,"Pending output escaped");
    auto progress=task.step(quantum);
    while(progress.status==region_compaction_status::validating) {
      require(progress.operations<=quantum,"Validation exceeded operation budget");progress=task.step(quantum);
    }
    if(quote) {
      require(progress.status==region_compaction_status::waiting_for_capacity&&progress.required_work_bytes==quote,"Incorrect work quote");
      require(!task.admit()&&task.allocated_bytes()==0U&&test_allocations::allocations==0U,"Short grant allocated work");
      require(task.step(quantum).operations==0U,"Waiting task polled capacity");
      blocker.clear();require(task.admit(),"Exact grant was rejected");
      require(task.allocated_bytes()==quote&&test_allocations::allocations==1U&&test_allocations::live_bytes==quote,"Work differs from exact allocation quote");
      do {
        progress=task.step(quantum);require(progress.operations<=quantum,"Compaction exceeded operation budget");
        require(progress.total_operations<10000000U,"Compaction failed to converge");
      }while(progress.status==region_compaction_status::running);
    }
    require(progress.status==region_compaction_status::complete&&progress.output_count==c.expected.size(),"Frozen output count differs");
    require(task.step(quantum).operations==0U,"Completed work restarted");
    require(!task.read(0U,window.data(),257U,copied)&&copied==0U,"Unbounded output read accepted");
    for(std::size_t first=0U;first<c.expected.size();first+=256U) {
      require(task.read(first,window.data(),256U,copied),"Output range rejected");
      require(copied==std::min<std::size_t>(256U,c.expected.size()-first),"Incorrect output range count");
      for(std::size_t i=0U;i<copied;++i)compare(c.expected[first+i],window[i]);
    }
    require(task.read(c.expected.size(),nullptr,0U,copied)&&copied==0U,"Empty output range failed");
    require(test_allocations::allocations==(quote?1U:0U),"Step/read made hidden allocations");
    task.cancel();require(task.allocated_bytes()==0U&&budget.work_bytes()==0U&&budget.resident_bytes()==64U,"Cancellation refunded another owner");
    require(task.step(quantum).status==region_compaction_status::cancelled&&!task.admit(),"Cancelled work resumed");
    require(!task.read(0U,window.data(),1U,copied)&&copied==0U,"Late reader retained cancelled work");
  }
  finish_observation();
}
void verify_failures(const fixture& c) {
  const auto quote=region_compaction_work::work_bytes(c.input.size(),c.input.size());
  for(std::size_t stop:{0U,1U,17U,100U,1000U,10000U,100000U}) {
    auto input=std::make_shared<region_list>(c.input);
    std::weak_ptr<const region_list> source=input;
    payload_budget budget(quote);reset_observation(budget);
    {
      region_compaction_work task(view(input),budget);input.reset();
      require(!source.expired(),"Task did not retain input owner");
      std::uint64_t operations=0U;
      while(operations<stop) {
        const auto p=task.step(17U);operations+=p.operations;
        if(p.status==region_compaction_status::waiting_for_capacity)require(task.admit(),"Cancellation fixture grant failed");
        else if(p.status==region_compaction_status::complete)break;
        else require(p.status==region_compaction_status::validating||p.status==region_compaction_status::running,"Cancellation fixture failed");
      }
      task.cancel();require(source.expired()&&budget.work_bytes()==0U,"Cancelled work retained source/credit");task.cancel();
    }
    finish_observation();
  }
  auto input=std::make_shared<region_list>(c.input);
  payload_budget budget(quote);
  {
    region_compaction_work task(view(input),budget);
    const auto p=task.step(1000000U,1e-9);require(p.operations>0U&&p.operations<=64U,"Elapsed budget failed to stop validation");
    while(task.step(4096U).status==region_compaction_status::validating){}
    test_allocations::fail_next=true;require(!task.admit(),"Injected allocation failure accepted");
    require(task.step(1U).status==region_compaction_status::allocation_failed&&budget.work_bytes()==0U,"Failed allocation retained credit");
  }
  for(unsigned fault=0U;fault<5U;++fault) {
    auto invalid=std::make_shared<region_list>(c.input);
    if(fault==0U)(*invalid)[0].value.pixels_per_uv=std::numeric_limits<double>::quiet_NaN();
    if(fault==1U)(*invalid)[0].value.projection[0]=infinity;
    if(fault==2U)(*invalid)[0].flags=1U;
    if(fault==3U)(*invalid)[0].value.uv.minimum[0]=infinity;
    if(fault==4U)(*invalid)[0].flags=8U;
    region_compaction_work task(view(invalid),budget);
    require(task.step(1000000U).status==region_compaction_status::invalid_input&&!task.admit(),"Invalid input was admitted");
  }
  {
    region_compaction_work task({input,nullptr,input->size()},budget);
    require(task.step(1U).status==region_compaction_status::invalid_input&&!task.admit(),"Invalid immutable view was admitted");
  }
  require(region_compaction_work::work_bytes(2U,3U)==std::numeric_limits<std::size_t>::max()&&
    region_compaction_work::work_bytes(1048577U,1U)==std::numeric_limits<std::size_t>::max(),"Invalid shape was quoted");
}
void verify_interleaving(const fixture& a,const fixture& b) {
  auto first=std::make_shared<const region_list>(a.input),second=std::make_shared<const region_list>(b.input);
  const auto qa=region_compaction_work::work_bytes(first->size(),first->size()),qb=region_compaction_work::work_bytes(second->size(),second->size());
  payload_budget budget(qa+qb);reset_observation(budget);
  {
    region_compaction_work left(view(first),budget),right(view(second),budget);
    auto run=[](region_compaction_work& work,std::size_t n) {
      auto p=work.step(n);if(p.status==region_compaction_status::waiting_for_capacity){require(work.admit(),"Peer prevented exact admission");p=work.step(n);}
      require(p.total_operations<10000000U,"Interleaved work did not converge");return p;
    };
    auto x=run(left,1U),y=run(right,7U);
    while(x.status!=region_compaction_status::complete||y.status!=region_compaction_status::complete){x=run(left,1U);y=run(right,7U);}
    require(budget.work_bytes()==qa+qb,"Interleaved owners lost credit");left.cancel();
    require(budget.work_bytes()==qb,"Cancelling one owner refunded its peer");
    std::array<measurement_region,256> window;std::size_t count=0U;
    for(std::size_t offset=0U;offset<b.expected.size();offset+=256U) {
      require(right.read(offset,window.data(),256U,count),"Peer output was invalidated");
      for(std::size_t i=0U;i<count;++i)compare(b.expected[offset+i],window[i]);
    }
    right.cancel();require(budget.work_bytes()==0U,"Interleaved work leaked credit");
  }
  finish_observation();
}
void verify_precredited_input(const fixture& c) {
  auto input=std::make_shared<const region_list>(c.input);
  const auto quote=region_compaction_work::work_bytes(input->size(),input->size());
  payload_budget budget(quote*2U),foreign_budget(quote);
  payload_budget::credit authorized,foreign,oversize,temporary;
  auto resident=budget.resident_credit();
  require(foreign_budget.reserve(quote,foreign)&&budget.reserve(quote,temporary),"Cannot fund grant fixture");
  budget.adopt(temporary,resident,quote);
  region_compaction_work task(view(input),budget);
  while(task.step(4096U).status==region_compaction_status::validating){}
  require(!task.admit(foreign)&&foreign.bytes()==quote,"Foreign work credit was consumed");
  require(!task.admit(resident)&&resident.bytes()==quote,"Resident credit was consumed as work");
  resident.clear();require(budget.reserve(quote+1U,oversize),"Cannot fund oversized grant");
  require(!task.admit(oversize)&&oversize.bytes()==quote+1U,"Mismatched grant was changed");oversize.clear();
  require(budget.reserve(quote,authorized),"Cannot reserve input/work joint grant");
  reset_observation(budget);
  require(task.admit(authorized)&&!authorized.attached()&&task.allocated_bytes()==quote,"Precredited work was charged twice");
  require(test_allocations::allocations==1U&&budget.work_bytes()==quote,"Transferred grant lost exact accounting");
  task.cancel();require(budget.work_bytes()==0U,"Transferred credit leaked");finish_observation();
  // An allocation failure cannot silently consume the producer's reservation.
  region_compaction_work failed(view(input),budget);
  while(failed.step(4096U).status==region_compaction_status::validating){}
  require(budget.reserve(quote,authorized),"Cannot reserve failed grant");test_allocations::fail_next=true;
  require(!failed.admit(authorized)&&authorized.bytes()==quote&&failed.allocated_bytes()==0U,"Failed allocation consumed upstream credit");
  authorized.clear();require(budget.work_bytes()==0U,"Caller could not release failed grant");
}
} // namespace

int main(int argc,char** argv) {
  try {
    require(argc==2,"A frozen JS oracle path is required");
    const auto cases=fixtures(argv[1]);
    for(const auto& c:cases)for(std::size_t quantum:{1U,7U,64U,4096U}) {
      try{verify(c,quantum);}catch(const std::exception& e){std::cerr<<c.name<<" quantum="<<quantum<<": "<<e.what()<<'\n';return 1;}
    }
    verify_failures(cases[2]);
    verify_interleaving(cases[0],cases[2]);
    verify_precredited_input(cases[0]);
    std::cout<<"Native persistent compaction: "<<cases.size()<<" frozen cases, four quanta, exact work credit, no step/read allocation, cancellation and failure ownership passed\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
