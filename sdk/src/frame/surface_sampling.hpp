#ifndef TERRA_FRAME_SURFACE_SAMPLING_HPP
#define TERRA_FRAME_SURFACE_SAMPLING_HPP

#include <terra/frame/surface_source.hpp>
#include <terra/frame/triangle_projection.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <new>

#if defined(__EMSCRIPTEN__)
extern "C" double terra_monotonic_milliseconds();
#endif

namespace terra { namespace frame { namespace surface_detail {
inline double clock_ms() {
#if defined(__EMSCRIPTEN__)
  return terra_monotonic_milliseconds();
#else
  return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
inline double minimum(double a,double b) {
  if(std::isnan(a)||std::isnan(b))return std::numeric_limits<double>::quiet_NaN();
  if(a==0.0&&b==0.0)return std::signbit(a)||std::signbit(b)?-0.0:0.0;
  return a<b?a:b;
}
inline double maximum(double a,double b) {
  if(std::isnan(a)||std::isnan(b))return std::numeric_limits<double>::quiet_NaN();
  if(a==0.0&&b==0.0)return !std::signbit(a)||!std::signbit(b)?0.0:-0.0;
  return a>b?a:b;
}
// Capture a self-copy before placement new ends the source object's lifetime.
template<class T> inline void construct(T* destination,T value){::new(static_cast<void*>(destination)) T(value);}
inline double norm(const double* values,std::size_t count) {
  double scale=0.0;for(std::size_t i=0U;i<count;++i)scale=maximum(scale,std::abs(values[i]));
  if(!scale||!std::isfinite(scale))return scale;
  double sum=0.0,correction=0.0;
  for(std::size_t i=0U;i<count;++i){const auto x=values[i]/scale;const auto y=x*x-correction;const auto next=sum+y;correction=(next-sum)-y;sum=next;}
  return std::sqrt(sum)*scale;
}
struct sample_cache {
  struct page {std::uint32_t first=UINT32_MAX;bool xyz_valid=false;float xyz[96],uv[64];} pages[3];
  const page* fetch(const surface_source& source,std::uint32_t id,bool positions) {
    if(id>=source.vertex_count())return nullptr;
    const auto first=id/32U*32U;auto& p=pages[(first/32U)%3U];
    if(p.first!=first||(positions&&!p.xyz_valid)) {
      const auto count=std::min(32U,source.vertex_count()-first);
      const auto status=positions?source.read(first,count,p.xyz,p.uv):source.read_uv(first,count,p.uv);
      if(status!=surface_mesh_status::ok)return nullptr;
      p.first=first;p.xyz_valid=positions;
    }
    return &p;
  }
  bool uv(const surface_source& source,std::uint32_t id,core::vector2d& out) {
    const auto* p=fetch(source,id,false);if(!p)return false;const auto n=(id-p->first)*2U;out={{p->uv[n],p->uv[n+1U]}};return true;
  }
  bool triangle(const surface_source& source,const std::uint16_t* indices,triangle_projection_input& out) {
    for(std::size_t i=0U;i<3U;++i){const auto* p=fetch(source,indices[i],true);if(!p)return false;const auto n=indices[i]-p->first;
      std::copy_n(p->xyz+n*3U,3U,out.positions.begin()+i*3U);std::copy_n(p->uv+n*2U,2U,out.uv.begin()+i*2U);}
    return true;
  }
};
} } }
#endif
