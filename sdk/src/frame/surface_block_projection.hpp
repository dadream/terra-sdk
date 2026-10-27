#ifndef TERRA_FRAME_SURFACE_BLOCK_PROJECTION_HPP
#define TERRA_FRAME_SURFACE_BLOCK_PROJECTION_HPP
#include "surface_blocks.hpp"

namespace terra { namespace frame { namespace surface_detail {
using clip_point=std::array<double,4>;
inline clip_point transform(const matrix4d& m,const core::vector3d& p) {
  clip_point q;for(unsigned i=0U;i<4U;++i)q[i]=m[i*4U]*p[0]+m[i*4U+1U]*p[1]+m[i*4U+2U]*p[2]+m[i*4U+3U];return q;
}
inline double plane(const clip_point& p,unsigned i){return p[3]+(i%2U?-p[i/2U]:p[i/2U]);}
struct block_projection_context {
  triangle_projection_context projection;
  std::array<double,4> facing;
  core::vector3d world[8];bool world_valid[8]{};
  explicit block_projection_context(const triangle_projection_context& p):projection(p) {
    const auto& m=p.matrix;
    for(unsigned omit=0U;omit<4U;++omit) {
      unsigned columns[3],n=0U;for(unsigned i=0U;i<4U;++i)if(i!=omit)columns[n++]=i;
      double a[3],b[3],c[3];for(unsigned i=0U;i<3U;++i){a[i]=m[columns[i]];b[i]=m[4U+columns[i]];c[i]=m[12U+columns[i]];}
      facing[omit]=(omit%2U?-1.0:1.0)*(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]));
    }
    // Preserve the existing inverse's transposed elimination and Float32 result.
    double rows[4][8];
    for(unsigned row=0U;row<4U;++row)for(unsigned col=0U;col<4U;++col){rows[row][col]=m[col*4U+row];rows[row][col+4U]=row==col?1.0:0.0;}
    for(unsigned col=0U;col<4U;++col) {
      unsigned pivot=col;for(unsigned row=col+1U;row<4U;++row)if(std::abs(rows[row][col])>std::abs(rows[pivot][col]))pivot=row;
      if(!(std::abs(rows[pivot][col])>1e-12))return;
      for(unsigned i=0U;i<8U;++i)std::swap(rows[col][i],rows[pivot][i]);
      const auto scale=rows[col][col];for(double& value:rows[col])value/=scale;
      for(unsigned row=0U;row<4U;++row)if(row!=col){const auto factor=rows[row][col];for(unsigned i=0U;i<8U;++i)rows[row][i]-=factor*rows[col][i];}
    }
    matrix4d inverse;
    for(unsigned row=0U;row<4U;++row)for(unsigned col=0U;col<4U;++col)inverse[col*4U+row]=float(rows[row][col+4U]);
    for(unsigned i=0U;i<8U;++i) {
      const auto q=transform(inverse,{{i&1U?1.0:-1.0,i&2U?1.0:-1.0,i&4U?1.0:-1.0}});
      world_valid[i]=true;for(unsigned axis=0U;axis<3U;++axis){world[i][axis]=q[axis]/q[3];world_valid[i]=world_valid[i]&&std::isfinite(world[i][axis]);}
    }
  }
};
inline int facing(const surface_block& b,const block_projection_context& context) {
  if(!b.winding)return 0;
  const auto& c=context.facing;const auto& o=context.projection.origin;
  double value=0.0,radius=0.0,magnitude=0.0;
  for(unsigned i=0U;i<3U;++i) {
    const auto j=(i+1U)%3U,k=(i+2U)%3U;
    const auto n=b.du[j]*b.dv[k]-b.du[k]*b.dv[j];
    const auto nr=std::abs(b.du[j])*b.dv_radius[k]+std::abs(b.dv[k])*b.du_radius[j]+b.du_radius[j]*b.dv_radius[k]+
      std::abs(b.du[k])*b.dv_radius[j]+std::abs(b.dv[j])*b.du_radius[k]+b.du_radius[k]*b.dv_radius[j];
    const auto p=c[i]-c[3]*(o[i]+(b.minimum[i]+b.maximum[i])/2.0),pr=std::abs(c[3])*(b.maximum[i]-b.minimum[i])/2.0;
    value+=n*p;magnitude+=std::abs(n*p);radius+=std::abs(n)*pr+std::abs(p)*nr+nr*pr;
  }
  value*=b.winding;const auto limit=radius+1e-6*(magnitude+radius);return value>limit?1:value<-limit?-1:0;
}
template<class Point,class Distance> bool segment(const Point& a,const Point& b,Distance distance,Point& first,Point& last) {
  double lo=0.0,hi=1.0;
  for(unsigned p=0U;p<6U;++p) {
    const auto x=distance(a,p),y=distance(b,p);if(x<0.0&&y<0.0)return false;
    if(x<0.0)lo=maximum(lo,x/(x-y));
    if(y<0.0)hi=minimum(hi,x/(x-y));
    if(lo>hi)return false;
  }
  for(std::size_t i=0U;i<a.size();++i){first[i]=a[i]+(b[i]-a[i])*lo;last[i]=a[i]+(b[i]-a[i])*hi;}return true;
}
struct box_projection {
  clip_point points[48];unsigned count=0U;
  bool complete=false,shallow=false;
  double minimum_w=std::numeric_limits<double>::infinity(),maximum_w=-std::numeric_limits<double>::infinity();
};
inline bool project_box(const surface_block& b,const block_projection_context& c,box_projection& result) {
  constexpr unsigned edges[12][2]={{0,1},{2,3},{4,5},{6,7},{0,2},{1,3},{4,6},{5,7},{0,4},{1,5},{2,6},{3,7}};
  result.count=0U;result.complete=result.shallow=false;result.minimum_w=std::numeric_limits<double>::infinity();result.maximum_w=-result.minimum_w;
  core::vector3d lo,hi;for(unsigned i=0U;i<3U;++i){lo[i]=b.minimum[i]+c.projection.origin[i];hi[i]=b.maximum[i]+c.projection.origin[i];}
  clip_point corners[8];
  for(unsigned i=0U;i<8U;++i){corners[i]=transform(c.projection.matrix,{{i&1U?hi[0]:lo[0],i&2U?hi[1]:lo[1],i&4U?hi[2]:lo[2]}});
    for(double v:corners[i])if(!std::isfinite(v))return false;}
  result.complete=true;
  for(unsigned p=0U;p<6U;++p){bool outside=true;for(const auto& point:corners){const auto d=plane(point,p);outside=outside&&d<0.0;result.complete=result.complete&&d>=0.0;}if(outside)return true;}
  if(result.complete){std::copy_n(corners,8U,result.points);result.count=8U;}
  else {
    for(const auto& edge:edges){clip_point first,last;if(segment(corners[edge[0]],corners[edge[1]],plane,first,last)){result.points[result.count++]=first;result.points[result.count++]=last;}}
    const auto distance=[&](const core::vector3d& p,unsigned axis){return axis%2U?hi[axis/2U]-p[axis/2U]:p[axis/2U]-lo[axis/2U];};
    for(const auto& edge:edges)if(c.world_valid[edge[0]]&&c.world_valid[edge[1]]) {
      core::vector3d first,last;
      if(segment(c.world[edge[0]],c.world[edge[1]],distance,first,last)){result.points[result.count++]=transform(c.projection.matrix,first);result.points[result.count++]=transform(c.projection.matrix,last);}
    }
  }
  for(unsigned i=0U;i<result.count;++i){result.minimum_w=minimum(result.minimum_w,result.points[i][3]);result.maximum_w=maximum(result.maximum_w,result.points[i][3]);}
  result.shallow=result.complete&&result.minimum_w>0.0&&result.maximum_w<=result.minimum_w*1.2;return true;
}
inline double dot(const core::vector3d& a,const core::vector3d& b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
inline double spectral(double a,double b,double c,double d){const auto aa=a*a+b*b,bb=c*c+d*d,ab=a*c+b*d;return std::sqrt(maximum(0.0,(aa+bb+std::hypot(aa-bb,2.0*ab))/2.0));}
inline double row_spectral(const core::vector3d& a,const core::vector3d& b){const auto aa=dot(a,a),bb=dot(b,b),ab=dot(a,b);return std::sqrt(maximum(0.0,(aa+bb+std::hypot(aa-bb,2.0*ab))/2.0));}
inline double radius(const core::vector3d& row,const core::vector3d& r){return std::abs(row[0])*r[0]+std::abs(row[1])*r[1]+std::abs(row[2])*r[2];}
inline double block_density(const surface_block& b,const block_projection_context& c,const clip_point& p,double minimum_w) {
  const auto& m=c.projection.matrix;const auto nx=p[0]/p[3],ny=p[1]/p[3];core::vector3d x,y;
  for(unsigned i=0U;i<3U;++i){x[i]=c.projection.scale_x*(m[i]-nx*m[12U+i]);y[i]=c.projection.scale_y*(m[4U+i]-ny*m[12U+i]);}
  const auto derivative=spectral(dot(x,b.du),dot(x,b.dv),dot(y,b.du),dot(y,b.dv));
  const double r[]={radius(x,b.du_radius),radius(x,b.dv_radius),radius(y,b.du_radius),radius(y,b.dv_radius)};
  return (derivative+minimum(row_spectral(x,y)*b.deviation,norm(r,4U)))/minimum_w;
}
} } }
#endif
