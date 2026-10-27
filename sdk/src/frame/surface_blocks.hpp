#ifndef TERRA_FRAME_SURFACE_BLOCKS_HPP
#define TERRA_FRAME_SURFACE_BLOCKS_HPP
#include <terra/frame/surface_model.hpp>
#include "surface_sampling.hpp"

namespace terra { namespace frame { namespace surface_detail {
inline void empty_block(surface_block& b) {
  const auto inf=std::numeric_limits<double>::infinity();
  b.minimum=b.du=b.dv={{inf,inf,inf}};b.maximum=b.du_radius=b.dv_radius={{-inf,-inf,-inf}};
  b.uv.minimum={{inf,inf}};b.uv.maximum={{-inf,-inf}};b.deviation=0.0;
}
inline double determinant(const triangle_projection_input& t) {
  return (double(t.uv[2])-t.uv[0])*(double(t.uv[5])-t.uv[1])-
      (double(t.uv[4])-t.uv[0])*(double(t.uv[3])-t.uv[1]);
}
inline std::uint32_t bucket(const float* uv,const core::bounds2d& bounds,std::uint32_t dimension) {
  std::uint32_t result=0U;
  for(std::size_t axis=0U;axis<2U;++axis) {
    const double middle=(double(uv[axis])+uv[axis+2U]+uv[axis+4U])/3.0;
    const auto scale=double(dimension)/maximum(1e-12,bounds.maximum[axis]-bounds.minimum[axis]);
    const auto v=std::floor((middle-bounds.minimum[axis])*scale);
    const auto cell=static_cast<std::uint32_t>(maximum(0.0,minimum(double(dimension-1U),v)));
    result+=axis?cell*dimension:cell;
  }
  return result;
}
inline bool add_geometry(surface_block& b,const triangle_projection_input& t,bool update_uv) {
  const auto det=determinant(t);if(!std::isfinite(det)||std::abs(det)<1e-16)return false;
  const double u1=double(t.uv[2])-t.uv[0],v1=double(t.uv[3])-t.uv[1];
  const double u2=double(t.uv[4])-t.uv[0],v2=double(t.uv[5])-t.uv[1];
  for(std::size_t axis=0U;axis<3U;++axis) {
    const double a=double(t.positions[axis+3U])-t.positions[axis],c=double(t.positions[axis+6U])-t.positions[axis];
    const double u=(a*v2-c*v1)/det,v=(c*u1-a*u2)/det;
    if(!std::isfinite(u)||!std::isfinite(v))return false;
    b.du[axis]=minimum(b.du[axis],u);b.du_radius[axis]=maximum(b.du_radius[axis],u);
    b.dv[axis]=minimum(b.dv[axis],v);b.dv_radius[axis]=maximum(b.dv_radius[axis],v);
    for(std::size_t i=0U;i<3U;++i){const double p=t.positions[axis+i*3U];b.minimum[axis]=minimum(b.minimum[axis],p);b.maximum[axis]=maximum(b.maximum[axis],p);}
  }
  if(update_uv)for(std::size_t i=0U;i<3U;++i)for(std::size_t axis=0U;axis<2U;++axis) {
    const double v=t.uv[i*2U+axis];b.uv.minimum[axis]=minimum(b.uv.minimum[axis],v);b.uv.maximum[axis]=maximum(b.uv.maximum[axis],v);
  }
  return true;
}
inline void finish_block(surface_block& b) {
  double radii[6];
  for(std::size_t axis=0U;axis<3U;++axis) {
    const auto u=b.du[axis],v=b.du_radius[axis],middle=u+(v-u)/2.0;
    b.du[axis]=middle;b.du_radius[axis]=maximum(v-middle,middle-u);radii[axis]=b.du_radius[axis];
    const auto low=b.dv[axis],high=b.dv_radius[axis],centre=low+(high-low)/2.0;
    b.dv[axis]=centre;b.dv_radius[axis]=maximum(high-centre,centre-low);radii[axis+3U]=b.dv_radius[axis];
  }
  b.deviation=norm(radii,6U);
}
} } }
#endif
