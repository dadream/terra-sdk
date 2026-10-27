#include <terra/frame/region_compaction.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <new>
#include <utility>

#if defined(__EMSCRIPTEN__)
extern "C" double terra_monotonic_milliseconds();
#endif

namespace terra {
namespace frame {
namespace {

constexpr std::uint32_t maximum_regions = 1048576U;
constexpr std::uint32_t none = UINT32_MAX;
constexpr double infinity = std::numeric_limits<double>::infinity();
double monotonic_milliseconds() {
#if defined(__EMSCRIPTEN__)
  return terra_monotonic_milliseconds();
#else
  return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
double minimum(double a,double b) {
  if(std::isnan(a)||std::isnan(b))return std::numeric_limits<double>::quiet_NaN();
  if(a==0.0&&b==0.0)return std::signbit(a)||std::signbit(b)?-0.0:0.0;
  return a<b?a:b;
}
double maximum(double a,double b) {
  if(std::isnan(a)||std::isnan(b))return std::numeric_limits<double>::quiet_NaN();
  if(a==0.0&&b==0.0)return !std::signbit(a)||!std::signbit(b)?0.0:-0.0;
  return a>b?a:b;
}
double spectral(double a,double b,double c,double d) {
  const double aa=a*a+b*b,bb=c*c+d*d,ab=a*c+b*d;
  return std::sqrt(maximum(0.0,(aa+bb+std::hypot(aa-bb,2.0*ab))/2.0));
}
std::uint32_t mix(std::uint32_t x) {
  x=(x^(x>>16U))*0x7feb352dU;x=(x^(x>>15U))*0x846ca68bU;return x^(x>>16U);
}
std::uint32_t number_hash(double value) {
  if(std::isnan(value))return 0x7fc00000U;
  if(value==0.0)value=0.0;
  std::uint64_t bits;std::memcpy(&bits,&value,sizeof(bits));
  return mix(static_cast<std::uint32_t>(bits)^(static_cast<std::uint32_t>(bits>>32U)*0x9e3779b1U));
}
// A unique/sort copy may target its source slot. Read before reusing storage.
template<class T> void store(T* destination,T value){::new(static_cast<void*>(destination)) T(value);}
double cross(const core::vector2d& a,const core::vector2d& b,const core::vector2d& c) {
  return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
}
std::uint32_t signature(const imagery_region& row) {
  std::uint32_t hash=2166136261U,sum=0U,xor_value=0U;
  for(double v:row.projection)hash=(hash^number_hash(v))*16777619U;
  for(const auto& p:row.triangle) {
    const auto token=((number_hash(p[0])^0x9e3779b9U)*16777619U)^number_hash(p[1]);sum+=token;xor_value^=token;
  }
  return mix(((hash^sum)*16777619U)^xor_value);
}
bool equal(const imagery_region& a,const imagery_region& b) {
  if(a.projection!=b.projection)return false;
  unsigned matched=0U;
  for(const auto& p:a.triangle) {
    bool found=false;
    for(unsigned i=0U;i<3U;++i)if(!(matched&(1U<<i))&&p==b.triangle[i]){matched|=1U<<i;found=true;break;}
    if(!found)return false;
  }
  return true;
}
bool valid(const measurement_region& row) {
  return valid_measurement_region(row)&&(!(row.flags&1U)||(row.flags&2U));
}

struct descriptor {
  std::uint32_t source,points[3];
  double density;
};
struct layout {
  std::uint32_t *table=nullptr,*generation=nullptr,*source=nullptr,*order=nullptr,
    *temporary=nullptr,*points=nullptr,*hull=nullptr,*pending=nullptr;
  double* moments=nullptr;
  descriptor* output=nullptr;
  std::size_t bytes;
  std::uint32_t slots=4U,pending_capacity=0U,output_capacity=0U;
  template<class T> T* range(void* base,std::size_t count) {
    bytes=(bytes+alignof(T)-1U)/alignof(T)*alignof(T);
    const auto offset=bytes;bytes+=sizeof(T)*count;
    return base?reinterpret_cast<T*>(static_cast<unsigned char*>(base)+offset):nullptr;
  }
  layout(void* base,std::size_t first,std::uint32_t total,std::uint32_t count):bytes(first) {
    while(slots<std::uint64_t(count)*2U)slots*=2U;
    table=range<std::uint32_t>(base,slots);generation=range<std::uint32_t>(base,slots);
    source=range<std::uint32_t>(base,count);order=range<std::uint32_t>(base,count);
    temporary=range<std::uint32_t>(base,std::size_t(count)*3U);
    moments=range<double>(base,std::size_t(count)*5U);
    points=range<std::uint32_t>(base,std::size_t(count)*3U);
    hull=range<std::uint32_t>(base,std::size_t(count)*6U+2U);
    unsigned depth=0U;for(std::uint32_t n=1U;n<count;n*=2U)++depth;
    pending_capacity=(depth+2U)*2U;pending=range<std::uint32_t>(base,pending_capacity);
    output_capacity=total+count*2U;output=range<descriptor>(base,output_capacity);
    bytes=(bytes+7U)/8U*8U;
  }
};

} // namespace

struct region_compaction_work::state {
  enum class phase {initialize,collect,probe,moments,next_group,group_scan,witness,
    point_next,point_probe,sort,sort_copy,point_unique,hull,area,emit_hull,
    emit_original,split,done,error};
  enum class comparison {points,u,v};
  layout memory;
  phase current=phase::initialize,after_sort=phase::done;
  comparison compare=comparison::points;
  std::uint32_t index=0U,unique=0U,slot=0U,mask=0U,epoch=1U,stack=0U,outputs=0U;
  std::uint32_t first=0U,length=0U,end=0U,j=0U,point_size=0U,distinct=0U;
  std::uint32_t hull_size=0U,half=0U,half_start=0U,fan=0U;
  std::uint32_t witnesses[4]{none,none,none,none};
  double upper=0.0,lower=infinity,covered=0.0,lo_u=infinity,hi_u=-infinity,lo_v=infinity,hi_v=-infinity;
  double lo_sum=infinity,hi_sum=-infinity,lo_difference=infinity,hi_difference=-infinity,magnitude=0.0;
  double minimum_w=infinity,maximum_w=0.0,maximum_n=0.0,deviation=0.0,reference[4]{},area_sum=0.0;
  bool raw=false;
  std::uint32_t *sort_values=nullptr,*sort_source=nullptr,*sort_destination=nullptr;
  std::uint32_t sort_first=0U,sort_count=0U,source_first=0U,destination_first=0U,
    width=1U,left=0U,a=0U,b=0U,out=0U,middle=0U,merge_end=0U;

  state(std::uint32_t total,std::uint32_t projected):memory(this,sizeof(state),total,projected){mask=memory.slots-1U;}
  const imagery_region& at(const measurement_region_view& input,std::uint32_t value)const{return input[memory.source[value]].value;}
  const core::vector2d& point(const measurement_region_view& input,std::uint32_t code)const{return at(input,code/3U).triangle[code%3U];}
  void emit_source(std::uint32_t source) {
    if(outputs>=memory.output_capacity){current=phase::error;return;}
    store(memory.output+outputs++,descriptor{source,{0U,0U,0U},0.0});
  }
  void failed_merge() {
    if(length<=4U){index=first;current=phase::emit_original;}
    else begin_sort(memory.order,first,length,hi_v-lo_v>hi_u-lo_u?comparison::v:comparison::u,phase::split);
  }
  void begin_sort(std::uint32_t* values,std::uint32_t begin,std::uint32_t count,comparison kind,phase next) {
    sort_values=sort_source=values;sort_destination=memory.temporary;
    sort_first=source_first=begin;destination_first=0U;sort_count=count;
    width=1U;left=0U;compare=kind;after_sort=next;
    start_merge();current=count>1U?phase::sort:next;
  }
  void start_merge(){a=left;b=middle=std::min(sort_count,left+width);out=left;merge_end=std::min(sort_count,left+width*2U);}
  double ordering(const measurement_region_view& input,std::uint32_t x,std::uint32_t y)const {
    if(compare!=comparison::points){const auto axis=compare==comparison::u?3U:4U;return memory.moments[x*5U+axis]-memory.moments[y*5U+axis];}
    const auto& p=point(input,x);const auto& q=point(input,y);const double dx=p[0]-q[0];
    return dx==0.0||std::isnan(dx)?p[1]-q[1]:dx;
  }
  void one(const measurement_region_view& input) {
    switch(current) {
    case phase::initialize:
      if(index<memory.slots){store(memory.generation+index++,0U);return;}
      index=0U;current=phase::collect;return;
    case phase::collect:
      if(index==input.size()){index=j=0U;current=phase::moments;return;}
      if(!(input[index].flags&1U)){emit_source(index++);return;}
      slot=signature(input[index].value)&mask;current=phase::probe;return;
    case phase::probe:
      if(memory.generation[slot]==1U) {
        if(equal(at(input,memory.table[slot]-1U),input[index].value)){++index;current=phase::collect;}
        else slot=(slot+1U)&mask;
      }else{
        store(memory.generation+slot,1U);store(memory.table+slot,unique+1U);
        store(memory.source+unique,index++);store(memory.order+unique,unique);++unique;current=phase::collect;
      }
      return;
    case phase::moments: {
      if(index==unique){store(memory.pending+stack++,0U);store(memory.pending+stack++,unique);current=phase::next_group;return;}
      if(j==0U){minimum_w=infinity;maximum_w=maximum_n=deviation=0.0;}
      const auto& r=at(input,index);const auto& c=r.projection;const auto& p=r.triangle[j];
      const double x=c[0]+c[1]*p[0]+c[2]*p[1],y=c[3]+c[4]*p[0]+c[5]*p[1],w=c[6]+c[7]*p[0]+c[8]*p[1];
      const double aa=c[1]*w-x*c[7],bb=c[2]*w-x*c[8],dd=c[4]*w-y*c[7],ee=c[5]*w-y*c[8];
      if(j==0U){reference[0]=aa;reference[1]=bb;reference[2]=dd;reference[3]=ee;}
      maximum_n=maximum(maximum_n,spectral(aa,bb,dd,ee));
      deviation=maximum(deviation,spectral(aa-reference[0],bb-reference[1],dd-reference[2],ee-reference[3]));
      minimum_w=minimum(minimum_w,w);maximum_w=maximum(maximum_w,w);
      if(++j==3U) {
        const double low=maximum(0.0,spectral(reference[0],reference[1],reference[2],reference[3])-deviation);
        store(memory.moments+index*5U,minimum(r.pixels_per_uv,minimum_w>0.0?maximum_n/(minimum_w*minimum_w):infinity));
        store(memory.moments+index*5U+1U,maximum_w>0.0?low/(maximum_w*maximum_w):0.0);
        store(memory.moments+index*5U+2U,std::abs(cross(r.triangle[0],r.triangle[1],r.triangle[2]))/2.0);
        store(memory.moments+index*5U+3U,r.uv.minimum[0]+r.uv.maximum[0]);
        store(memory.moments+index*5U+4U,r.uv.minimum[1]+r.uv.maximum[1]);++index;j=0U;
      }
      return;
    }
    case phase::next_group:
      if(!stack){current=phase::done;return;}
      length=memory.pending[--stack];first=memory.pending[--stack];end=first+length;index=first;
      upper=covered=0.0;lower=lo_u=lo_v=infinity;hi_u=hi_v=-infinity;current=phase::group_scan;return;
    case phase::group_scan:
      if(index==end) {
        if(length<=2U||!(upper<=lower*1.25)){failed_merge();return;}
        lo_sum=lo_difference=infinity;hi_sum=hi_difference=-infinity;magnitude=0.0;
        std::fill_n(witnesses,4U,none);index=first;j=0U;current=phase::witness;return;
      }else{
        const auto id=memory.order[index++];const auto& uv=at(input,id).uv;
        upper=maximum(upper,memory.moments[id*5U]);lower=minimum(lower,memory.moments[id*5U+1U]);covered+=memory.moments[id*5U+2U];
        lo_u=minimum(lo_u,uv.minimum[0]);hi_u=maximum(hi_u,uv.maximum[0]);lo_v=minimum(lo_v,uv.minimum[1]);hi_v=maximum(hi_v,uv.maximum[1]);return;
      }
    case phase::witness:
      if(index==end) {
        if(std::all_of(witnesses,witnesses+4U,[](std::uint32_t v){return v!=none;})) {
          const auto& p=point(input,witnesses[0]);const auto& q=point(input,witnesses[1]);
          const auto& r=point(input,witnesses[2]);const auto& s=point(input,witnesses[3]);
          const double x=std::abs(cross(p,q,r))/2.0,y=std::abs(cross(p,q,s))/2.0,z=std::abs(cross(p,r,s))/2.0;
          const double rounding=256.0*std::numeric_limits<double>::epsilon()*maximum(1.0,magnitude*magnitude)*double(length)*double(length);
          if(minimum(minimum(x+y,x+z),y+z)>covered+maximum(1e-14,covered*1e-8)+rounding){failed_merge();return;}
        }
        index=first;j=point_size=0U;raw=false;++epoch;current=phase::point_next;return;
      }else{
        const auto code=memory.order[index]*3U+j;const auto& p=point(input,code);const double sum=p[0]+p[1],difference=p[0]-p[1];
        if(sum<lo_sum){lo_sum=sum;witnesses[0]=code;}if(sum>hi_sum){hi_sum=sum;witnesses[1]=code;}
        if(difference<lo_difference){lo_difference=difference;witnesses[2]=code;}if(difference>hi_difference){hi_difference=difference;witnesses[3]=code;}
        magnitude=maximum(maximum(magnitude,std::abs(p[0])),std::abs(p[1]));if(++j==3U){j=0U;++index;}return;
      }
    case phase::point_next:
      if(index==end){begin_sort(memory.points,0U,point_size,comparison::points,phase::point_unique);index=distinct=0U;return;}
      if(raw){store(memory.points+point_size++,memory.order[index]*3U+j);if(++j==3U){j=0U;++index;}return;}
      {const auto& p=point(input,memory.order[index]*3U+j);slot=(((number_hash(p[0])^0x9e3779b9U)*16777619U)^number_hash(p[1]))&mask;current=phase::point_probe;return;}
    case phase::point_probe: {
      const auto code=memory.order[index]*3U+j;
      if(memory.generation[slot]==epoch) {
        if(point(input,code)!=point(input,memory.table[slot]-1U)){slot=(slot+1U)&mask;return;}
      }else{
        store(memory.generation+slot,epoch);store(memory.table+slot,code+1U);store(memory.points+point_size++,code);
        if(point_size>=memory.slots/2U)raw=true;
      }
      if(++j==3U){j=0U;++index;}current=phase::point_next;return;
    }
    case phase::sort:
      if(out==merge_end) {
        left+=width*2U;
        if(left>=sort_count) {
          std::swap(sort_source,sort_destination);std::swap(source_first,destination_first);width*=2U;left=0U;
          if(width>=sort_count){out=0U;current=sort_source==sort_values?after_sort:phase::sort_copy;return;}
        }
        start_merge();return;
      }else{
        const auto value=b==merge_end||(a<middle&&!(ordering(input,sort_source[source_first+a],sort_source[source_first+b])>0.0))
          ?sort_source[source_first+a++]:sort_source[source_first+b++];
        store(sort_destination+destination_first+out++,value);return;
      }
    case phase::sort_copy:
      if(out==sort_count){current=after_sort;return;}
      store(sort_values+sort_first+out,sort_source[source_first+out]);++out;return;
    case phase::point_unique:
      if(index==point_size){hull_size=half=half_start=index=0U;current=phase::hull;return;}
      if(!distinct||point(input,memory.points[index])!=point(input,memory.points[distinct-1U]))store(memory.points+distinct++,memory.points[index]);
      ++index;return;
    case phase::hull:
      if(index==distinct) {
        if(hull_size>half_start)--hull_size;
        if(++half==2U){index=0U;area_sum=0.0;current=phase::area;return;}
        half_start=hull_size;index=0U;return;
      }else{
        const auto code=memory.points[half?distinct-1U-index:index];
        if(hull_size>=half_start+2U&&cross(point(input,memory.hull[hull_size-2U]),point(input,memory.hull[hull_size-1U]),point(input,code))<=0.0)--hull_size;
        else{store(memory.hull+hull_size++,code);++index;}
        return;
      }
    case phase::area:
      if(index==hull_size) {
        if(hull_size>=3U&&std::abs(std::abs(area_sum)/2.0-covered)<=maximum(1e-14,covered*1e-8)){fan=1U;current=phase::emit_hull;}
        else failed_merge();
        return;
      }else{
        const auto& p=point(input,memory.hull[index]);const auto& q=point(input,memory.hull[(index+1U)%hull_size]);
        area_sum+=p[0]*q[1]-p[1]*q[0];++index;return;
      }
    case phase::emit_hull:
      if(fan+1U==hull_size){current=phase::next_group;return;}
      if(outputs>=memory.output_capacity){current=phase::error;return;}
      store(memory.output+outputs++,descriptor{none,{memory.hull[0],memory.hull[fan],memory.hull[fan+1U]},upper});++fan;return;
    case phase::emit_original:
      if(index==end){current=phase::next_group;return;}
      emit_source(memory.source[memory.order[index++]]);return;
    case phase::split:
      if(stack+4U>memory.pending_capacity){current=phase::error;return;}
      store(memory.pending+stack++,first);store(memory.pending+stack++,length/2U);
      store(memory.pending+stack++,first+length/2U);store(memory.pending+stack++,length-length/2U);current=phase::next_group;return;
    case phase::done:case phase::error:return;
    }
  }
};

region_compaction_work::region_compaction_work(measurement_region_view input,core::payload_budget budget)
    :input_(std::move(input)),budget_(std::move(budget)) {
  if(!input_.valid()||input_.size()>maximum_regions)status_=region_compaction_status::invalid_input;
  else input_count_=input_.size();
}
region_compaction_work::~region_compaction_work(){cancel();}
void region_compaction_work::state_deleter::operator()(state* p)const{if(p){p->~state();::operator delete(p);}}
std::size_t region_compaction_work::work_bytes(std::size_t total,std::size_t projected) {
  if(total>maximum_regions||projected>total)return std::numeric_limits<std::size_t>::max();
  return projected?layout(nullptr,sizeof(state),static_cast<std::uint32_t>(total),static_cast<std::uint32_t>(projected)).bytes:0U;
}
region_compaction_progress region_compaction_work::progress(std::size_t operations)const {
  region_compaction_progress p;p.status=status_;p.operations=operations;p.total_operations=total_operations_;
  if(status_==region_compaction_status::waiting_for_capacity)p.required_work_bytes=work_bytes(input_count_,projective_count_);
  if(status_==region_compaction_status::complete)p.output_count=state_?state_->outputs:input_count_;
  return p;
}
region_compaction_progress region_compaction_work::step(std::size_t maximum_operations,double milliseconds) {
  if(!std::isfinite(milliseconds)||milliseconds<0.0)return progress(0U);
  if(!maximum_operations||(status_!=region_compaction_status::validating&&status_!=region_compaction_status::running))return progress(0U);
  const double started=milliseconds>0.0?monotonic_milliseconds():0.0;std::size_t operations=0U;
  while(operations<maximum_operations) {
    if(status_==region_compaction_status::validating) {
      if(validated_==input_count_){status_=projective_count_?region_compaction_status::waiting_for_capacity:region_compaction_status::complete;break;}
      if(!valid((input_)[validated_])){status_=region_compaction_status::invalid_input;++operations;break;}
      if((input_)[validated_++].flags&1U)++projective_count_;
    }else if(status_==region_compaction_status::running) {
      state_->one(input_);
      if(state_->current==state::phase::done)status_=region_compaction_status::complete;
      if(state_->current==state::phase::error)status_=region_compaction_status::internal_error;
    }else break;
    ++operations;
    if(milliseconds>0.0&&operations%64U==0U&&monotonic_milliseconds()-started>=milliseconds)break;
  }
  total_operations_+=operations;return progress(operations);
}
bool region_compaction_work::admit() {
  if(status_!=region_compaction_status::waiting_for_capacity)return false;
  core::payload_budget::credit authorized;
  if(!budget_.reserve(work_bytes(input_count_,projective_count_),authorized))return false;
  return admit(authorized);
}
bool region_compaction_work::admit(core::payload_budget::credit& authorized) {
  if(status_!=region_compaction_status::waiting_for_capacity)return false;
  const auto bytes=work_bytes(input_count_,projective_count_);
  if(!authorized.is_work_credit()||!authorized.belongs_to(budget_)||authorized.bytes()!=bytes)return false;
  void* allocation=::operator new(bytes,std::nothrow);
  if(!allocation){status_=region_compaction_status::allocation_failed;return false;}
  state_.reset(::new(allocation) state(static_cast<std::uint32_t>(input_count_),static_cast<std::uint32_t>(projective_count_)));
  credit_=std::move(authorized);
  status_=region_compaction_status::running;return true;
}
std::size_t region_compaction_work::allocated_bytes()const{return credit_.bytes();}
bool region_compaction_work::read(std::size_t first,measurement_region* output,std::size_t capacity,std::size_t& count)const {
  count=0U;
  if(status_!=region_compaction_status::complete||capacity>256U||(capacity&&!output))return false;
  const auto size=state_?std::size_t(state_->outputs):input_count_;
  if(first>size)return false;
  count=std::min(capacity,size-first);
  for(std::size_t i=0U;i<count;++i) {
    if(!state_){output[i]=(input_)[first+i];continue;}
    const auto& d=state_->memory.output[first+i];
    if(d.source!=none){output[i]=(input_)[d.source];continue;}
    const auto& a=state_->point(input_,d.points[0]);const auto& b=state_->point(input_,d.points[1]);const auto& c=state_->point(input_,d.points[2]);
    auto& r=output[i];r=measurement_region();r.flags=3U;
    r.value.uv.minimum={{minimum(minimum(a[0],b[0]),c[0]),minimum(minimum(a[1],b[1]),c[1])}};
    r.value.uv.maximum={{maximum(maximum(a[0],b[0]),c[0]),maximum(maximum(a[1],b[1]),c[1])}};
    r.value.pixels_per_uv=d.density;r.value.projection={{0.0,d.density,0.0,0.0,0.0,d.density,1.0,0.0,0.0}};
    r.value.triangle={{a,b,c}};
  }
  return true;
}
void region_compaction_work::cancel() {
  status_=region_compaction_status::cancelled;state_.reset();credit_.clear();input_=measurement_region_view();
}

} // namespace frame
} // namespace terra
