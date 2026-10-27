#include "compact_regions.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace terra_bench {
namespace {

struct output_row {
  std::uint32_t source,points[3];
  double density;
};
static_assert(sizeof(output_row)==24U,"Unexpected compact output descriptor layout");

struct workspace {
  std::uint32_t *table=nullptr, *generation=nullptr, *source=nullptr, *order=nullptr,
    *temporary=nullptr, *points=nullptr, *hull=nullptr, *pending=nullptr;
  double* moments=nullptr;
  output_row* output=nullptr;
  region* wire=nullptr;
  std::size_t bytes=0U;
  std::uint32_t slots=4U, mask=0U;

  template<class T> T* range(void* buffer, std::size_t count) {
    bytes=(bytes+alignof(T)-1U)/alignof(T)*alignof(T);
    const auto first=bytes; bytes+=sizeof(T)*count;
    return buffer ? reinterpret_cast<T*>(static_cast<unsigned char*>(buffer)+first) : nullptr;
  }

  workspace(std::uint32_t count, void* buffer) {
    while(slots<std::uint64_t(count)*2U)slots*=2U;
    mask=slots-1U;
    table=range<std::uint32_t>(buffer,slots);
    generation=range<std::uint32_t>(buffer,slots);
    source=range<std::uint32_t>(buffer,count);
    order=range<std::uint32_t>(buffer,count);
    temporary=range<std::uint32_t>(buffer,std::size_t(count)*3U);
    moments=range<double>(buffer,std::size_t(count)*5U);
    points=range<std::uint32_t>(buffer,std::size_t(count)*3U);
    hull=range<std::uint32_t>(buffer,std::size_t(count)*6U+2U);
    std::uint32_t depth=0U;for(std::uint32_t n=1U;n<count;n*=2U)++depth;
    pending=range<std::uint32_t>(buffer,std::size_t(depth+2U)*2U);
    // A filled convex hull normally reduces rows. Tiny-area tolerance can
    // admit a hull with up to3N vertices, so N output rows is not a safe quote.
    output=range<output_row>(buffer,std::size_t(count)*3U);
    wire=range<region>(buffer,std::min<std::size_t>(std::size_t(count)*3U,256U));
  }
};

std::uint32_t mix(std::uint32_t value) {
  value=(value^(value>>16U))*0x7feb352dU;
  value=(value^(value>>15U))*0x846ca68bU;
  return value^(value>>16U);
}
std::uint32_t number_hash(double value) {
  if(std::isnan(value))return 0x7fc00000U;
  if(value==0.0)value=0.0;
  std::uint64_t bits;std::memcpy(&bits,&value,sizeof(bits));
  return mix(static_cast<std::uint32_t>(bits)^(static_cast<std::uint32_t>(bits>>32U)*0x9e3779b1U));
}
bool same(double a,double b){return a==b || (std::isnan(a)&&std::isnan(b));}
std::uint32_t signature(const region& value) {
  std::uint32_t hash=2166136261U,sum=0U,xor_value=0U;
  for(double v:value.projection)hash=(hash^number_hash(v))*16777619U;
  for(std::size_t i=0U;i<3U;++i) {
    const auto token=((number_hash(value.triangle_uv[i*2U])^0x9e3779b9U)*16777619U)^number_hash(value.triangle_uv[i*2U+1U]);
    sum+=token;xor_value^=token;
  }
  return mix(((hash^sum)*16777619U)^xor_value);
}
bool equal(const region& a,const region& b) {
  for(std::size_t i=0U;i<9U;++i)if(!same(a.projection[i],b.projection[i]))return false;
  std::uint32_t matched=0U;
  for(std::size_t i=0U;i<3U;++i) {
    bool found=false;
    for(std::size_t j=0U;j<3U;++j)if(!(matched&(1U<<j)) &&
        same(a.triangle_uv[i*2U],b.triangle_uv[j*2U])&&same(a.triangle_uv[i*2U+1U],b.triangle_uv[j*2U+1U])) {
      matched|=1U<<j;found=true;break;
    }
    if(!found)return false;
  }
  return true;
}
double spectral(double a,double b,double c,double d) {
  const double aa=a*a+b*b,bb=c*c+d*d,ab=a*c+b*d;
  return std::sqrt(std::max(0.0,(aa+bb+std::hypot(aa-bb,2.0*ab))/2.0));
}
double cross(const double* a,const double* b,const double* c) {
  return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
}

template<class Compare> void stable_sort(std::uint32_t* values,std::uint32_t first,
    std::uint32_t count,std::uint32_t* temporary,Compare compare) {
  auto* source=values;auto* destination=temporary;
  std::uint32_t source_first=first,destination_first=0U;
  for(std::uint32_t width=1U;width<count;width*=2U) {
    for(std::uint32_t left=0U;left<count;left+=width*2U) {
      const auto middle=std::min(count,left+width),end=std::min(count,left+width*2U);
      auto a=left,b=middle;
      for(auto out=left;out<end;++out)destination[destination_first+out]=b==end ||
        (a<middle&&!(compare(source[source_first+a],source[source_first+b])>0.0))
        ?source[source_first+a++]:source[source_first+b++];
    }
    std::swap(source,destination);std::swap(source_first,destination_first);
  }
  if(source!=values)std::copy_n(source+source_first,count,values+first);
}

} // namespace

std::uint32_t region_work_bytes(std::uint32_t count) {
  if(count>1048576U)return 0xffffffffU;
  const workspace shape(count,nullptr);
  return shape.bytes<0xffffffffU ? static_cast<std::uint32_t>(shape.bytes):0xffffffffU;
}
region* copy_region_output(const region* input,std::uint32_t input_count,
    void* buffer,std::uint32_t first,std::uint32_t count) {
  if(count>256U||std::uint64_t(first)+count>std::uint64_t(input_count)*3U)return nullptr;
  workspace state(input_count,buffer);
  for(std::uint32_t i=0U;i<count;++i) {
    const auto& descriptor=state.output[first+i];auto& out=state.wire[i];
    if(descriptor.source!=0xffffffffU){out=input[descriptor.source];continue;}
    const auto point=[&](std::uint32_t code){return input[state.source[code/3U]].triangle_uv+(code%3U)*2U;};
    const auto *a=point(descriptor.points[0]),*b=point(descriptor.points[1]),*c=point(descriptor.points[2]);
    out={};
    out.minimum_u=std::min({a[0],b[0],c[0]});out.maximum_u=std::max({a[0],b[0],c[0]});
    out.minimum_v=std::min({a[1],b[1],c[1]});out.maximum_v=std::max({a[1],b[1],c[1]});
    out.pixels_per_uv=descriptor.density;out.projection[1]=out.projection[5]=descriptor.density;out.projection[6]=1.0;
    std::copy_n(a,2U,out.triangle_uv);std::copy_n(b,2U,out.triangle_uv+2U);std::copy_n(c,2U,out.triangle_uv+4U);
    out.numerator_bound=-1.0;out.flags=3U;out.domain=UINT32_MAX;
  }
  return state.wire;
}

std::uint32_t compact_regions(const region* input,std::uint32_t count,void* buffer) {
  workspace state(count,buffer);
  std::fill_n(state.generation,state.slots,0U);
  std::uint32_t unique=0U;
  for(std::uint32_t i=0U;i<count;++i) {
    auto slot=signature(input[i])&state.mask;
    while(state.generation[slot]==1U&&!equal(input[state.source[state.table[slot]-1U]],input[i]))slot=(slot+1U)&state.mask;
    if(state.generation[slot]!=1U) {
      state.generation[slot]=1U;state.table[slot]=unique+1U;
      state.source[unique]=i;state.order[unique]=unique;++unique;
    }
  }
  const auto at=[&](std::uint32_t index)->const region&{return input[state.source[index]];};
  const auto point=[&](std::uint32_t code){return at(code/3U).triangle_uv+(code%3U)*2U;};
  for(std::uint32_t i=0U;i<unique;++i) {
    const auto& value=at(i);const auto* c=value.projection;
    double minimum_w=INFINITY,maximum_w=0.0,maximum_n=0.0,deviation=0.0,reference[4]{};
    for(std::size_t j=0U;j<3U;++j) {
      const double u=value.triangle_uv[j*2U],v=value.triangle_uv[j*2U+1U];
      const double x=c[0]+c[1]*u+c[2]*v,y=c[3]+c[4]*u+c[5]*v,w=c[6]+c[7]*u+c[8]*v;
      const double a=c[1]*w-x*c[7],b=c[2]*w-x*c[8],d=c[4]*w-y*c[7],e=c[5]*w-y*c[8];
      if(j==0U){reference[0]=a;reference[1]=b;reference[2]=d;reference[3]=e;}
      maximum_n=std::max(maximum_n,spectral(a,b,d,e));
      deviation=std::max(deviation,spectral(a-reference[0],b-reference[1],d-reference[2],e-reference[3]));
      minimum_w=std::min(minimum_w,w);maximum_w=std::max(maximum_w,w);
    }
    const double lower_n=std::max(0.0,spectral(reference[0],reference[1],reference[2],reference[3])-deviation);
    state.moments[i*5U]=std::min(value.pixels_per_uv,minimum_w>0.0?maximum_n/(minimum_w*minimum_w):INFINITY);
    state.moments[i*5U+1U]=maximum_w>0.0?lower_n/(maximum_w*maximum_w):0.0;
    state.moments[i*5U+2U]=std::abs(cross(value.triangle_uv,value.triangle_uv+2U,value.triangle_uv+4U))/2.0;
    state.moments[i*5U+3U]=value.minimum_u+value.maximum_u;
    state.moments[i*5U+4U]=value.minimum_v+value.maximum_v;
  }
  std::uint32_t stack=0U,epoch=1U,output_count=0U;
  state.pending[stack++]=0U;state.pending[stack++]=unique;
  while(stack) {
    const auto length=state.pending[--stack],first=state.pending[--stack],end=first+length;
    if(!length)continue;
    double upper=0.0,lower=INFINITY,covered=0.0,lo_u=INFINITY,hi_u=-INFINITY,lo_v=INFINITY,hi_v=-INFINITY;
    for(auto i=first;i<end;++i) {
      const auto index=state.order[i];const auto& value=at(index);
      upper=std::max(upper,state.moments[index*5U]);lower=std::min(lower,state.moments[index*5U+1U]);
      covered+=state.moments[index*5U+2U];lo_u=std::min(lo_u,value.minimum_u);hi_u=std::max(hi_u,value.maximum_u);
      lo_v=std::min(lo_v,value.minimum_v);hi_v=std::max(hi_v,value.maximum_v);
    }
    bool merged=false,may_cover=true;
    if(length>2U&&upper<=lower*1.25) {
      const double *a=nullptr,*b=nullptr,*c=nullptr,*d=nullptr;
      double lo_sum=INFINITY,hi_sum=-INFINITY,lo_difference=INFINITY,hi_difference=-INFINITY,magnitude=0.0;
      for(auto i=first;i<end;++i)for(std::uint32_t j=0U;j<3U;++j) {
        const auto* p=point(state.order[i]*3U+j);const double sum=p[0]+p[1],difference=p[0]-p[1];
        if(sum<lo_sum){lo_sum=sum;a=p;}if(sum>hi_sum){hi_sum=sum;b=p;}
        if(difference<lo_difference){lo_difference=difference;c=p;}if(difference>hi_difference){hi_difference=difference;d=p;}
        magnitude=std::max({magnitude,std::abs(p[0]),std::abs(p[1])});
      }
      if(a&&b&&c&&d) {
        const double x=std::abs(cross(a,b,c))/2.0,y=std::abs(cross(a,b,d))/2.0,z=std::abs(cross(a,c,d))/2.0;
        const double rounding=256.0*std::numeric_limits<double>::epsilon()*std::max(1.0,magnitude*magnitude)*double(length)*double(length);
        may_cover=!(std::min({x+y,x+z,y+z})>covered+std::max(1e-14,covered*1e-8)+rounding);
      }
      if(may_cover) {
        std::uint32_t size=0U;bool raw=false;++epoch;
        for(auto i=first;i<end;++i)for(std::uint32_t j=0U;j<3U;++j) {
          const auto code=state.order[i]*3U+j;const auto* p=point(code);
          if(raw)state.points[size++]=code;
          else {
            auto slot=(((number_hash(p[0])^0x9e3779b9U)*16777619U)^number_hash(p[1]))&state.mask;
            while(state.generation[slot]==epoch) {
              const auto* q=point(state.table[slot]-1U);
              if(same(p[0],q[0])&&same(p[1],q[1]))break;
              slot=(slot+1U)&state.mask;
            }
            if(state.generation[slot]!=epoch) {
              state.generation[slot]=epoch;state.table[slot]=code+1U;state.points[size++]=code;
              if(size>=state.slots/2U)raw=true;
            }
          }
        }
        stable_sort(state.points,0U,size,state.temporary,[&](std::uint32_t a,std::uint32_t b){
          const auto* p=point(a);const auto* q=point(b);const double dx=p[0]-q[0];return dx!=0.0?dx:p[1]-q[1];});
        std::uint32_t distinct=0U;
        for(std::uint32_t i=0U;i<size;++i) {
          const auto* p=point(state.points[i]);const auto* previous=distinct?point(state.points[distinct-1U]):nullptr;
          if(!previous||!same(p[0],previous[0])||!same(p[1],previous[1]))state.points[distinct++]=state.points[i];
        }
        std::uint32_t hull_size=0U;
        for(std::uint32_t half=0U;half<2U;++half) {
          const auto start=hull_size;
          for(std::uint32_t i=0U;i<distinct;++i) {
            const auto code=state.points[half?distinct-1U-i:i];const auto* p=point(code);
            while(hull_size>=start+2U&&cross(point(state.hull[hull_size-2U]),point(state.hull[hull_size-1U]),p)<=0.0)--hull_size;
            state.hull[hull_size++]=code;
          }
          if(hull_size>start)--hull_size;
        }
        double area=0.0;
        for(std::uint32_t i=0U;i<hull_size;++i) {
          const auto* a=point(state.hull[i]);const auto* b=point(state.hull[(i+1U)%hull_size]);area+=a[0]*b[1]-a[1]*b[0];
        }
        if(hull_size>=3U&&std::abs(std::abs(area)/2.0-covered)<=std::max(1e-14,covered*1e-8)) {
          for(std::uint32_t i=1U;i+1U<hull_size;++i) {
            auto& out=state.output[output_count++];out={};out.source=0xffffffffU;
            out.points[0]=state.hull[0];out.points[1]=state.hull[i];out.points[2]=state.hull[i+1U];out.density=upper;
          }
          merged=true;
        }
      }
    }
    if(!merged) {
      if(length<=4U)for(auto i=first;i<end;++i) {
        auto& out=state.output[output_count++];out={};out.source=state.source[state.order[i]];
      }
      else {
        const auto centre=hi_v-lo_v>hi_u-lo_u?4U:3U;
        stable_sort(state.order,first,length,state.temporary,[&](std::uint32_t a,std::uint32_t b){return state.moments[a*5U+centre]-state.moments[b*5U+centre];});
        const auto middle=length/2U;
        state.pending[stack++]=first;state.pending[stack++]=middle;
        state.pending[stack++]=first+middle;state.pending[stack++]=length-middle;
      }
    }
  }
  return output_count;
}

} // namespace terra_bench
