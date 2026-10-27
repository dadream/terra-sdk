#ifndef TERRA_FRAME_SURFACE_MEASUREMENT_CURSOR_HPP
#define TERRA_FRAME_SURFACE_MEASUREMENT_CURSOR_HPP
#include <terra/frame/surface_projection.hpp>
#include "surface_block_projection.hpp"
#include <type_traits>

namespace terra { namespace frame { namespace surface_detail {
enum class measurement_event {progress,scalar,projective,complete,capacity,invalid};
class measurement_cursor {
  struct domain {surface_block block;unsigned root=0U,depth=0U,child=0U,grandchild=0U;};
  struct leaf {std::uint16_t id;bool scalar,shallow,cull;double density;};
  enum class phase {validate,validate_pairs,pick,split_wait,split_scan,split_distribute,split_copy,split_publish,density,exact_range,exact,fan,scalar,done,error};
  const surface_model& model_;
  const surface_measurement_options& options_;
  block_projection_context context_;
  core::payload_budget budget_;
  core::payload_budget::credit extra_credit_;
  void* extra_=nullptr;
  std::uint32_t *order_=nullptr,*temporary_=nullptr;
  domain* descendants_=nullptr;
  unsigned descendants_count_=0U;
  std::uint16_t pending_[32]{};unsigned pending_count_=0U,current_id_=0U;
  domain current_;
  leaf schedule_[256]{};unsigned schedule_count_=0U,schedule_index_=0U;
  phase phase_=phase::validate;
  bool filling_=false,forced_=false;
  bool resolved_[256]{};
  std::size_t unresolved_=0U;
  unsigned validate_i_=0U,validate_j_=0U,index_=0U,point_=0U,fan_=0U;
  int current_facing_=0;
  box_projection box_;
  projected_triangle projected_;
  double density_=0.0;
  surface_projection_summary summary_;
  domain children_[4];std::uint32_t child_counts_[4]{},writes_[4]{};
  struct range {std::uint32_t first,count;};
  range ranges_[32];unsigned range_count_=0U;range range_{};
  static unsigned code(const domain& d){return d.root*21U+(d.depth==0U?0U:d.depth==1U?1U+d.child*5U:2U+d.child*5U+d.grandchild);}
  static unsigned depth(unsigned code){return code%21U==0U?0U:(code%21U-1U)%5U==0U?1U:2U;}
  static bool contains(unsigned a,unsigned b) {
    if(a/21U!=b/21U)return false;
    if(a%21U==0U)return true;
    return depth(a)==1U?(a%21U-1U)/5U==(b%21U-1U)/5U:a==b;
  }
  domain get(unsigned id) const {
    if(id>=16U)return descendants_[id-16U];
    domain d;d.block=model_.block(id);d.root=id;return d;
  }
  const std::uint32_t* faces(const domain& d) const {return (d.depth?order_:model_.layout().order())+d.block.first;}
  // 0 absent, 1 selected/inside a selected ancestor, 2 must resolve descendants.
  unsigned interest(const domain& d) {
    if(!options_.domains.count)return 1U;
    const auto c=code(d);unsigned result=0U;
    for(std::size_t i=0U;i<options_.domains.count;++i){
      const auto target=options_.domains.codes[i];
      if(target==c&&!resolved_[i]){resolved_[i]=true;--unresolved_;}
      if(contains(target,c))return 1U;
      if(contains(c,target))result=2U;
    }
    return result;
  }
  void include_bounds(const core::bounds2d& b) {
    if(!summary_.visible){summary_.uv=b;summary_.visible=true;return;}
    for(unsigned i=0U;i<2U;++i){summary_.uv.minimum[i]=minimum(summary_.uv.minimum[i],b.minimum[i]);summary_.uv.maximum[i]=maximum(summary_.uv.maximum[i],b.maximum[i]);}
  }
  bool append_leaf(bool scalar,bool shallow,bool cull,double density) {
    if(schedule_count_==256U){phase_=phase::error;return false;}
    schedule_[schedule_count_++]={std::uint16_t(current_id_),scalar,shallow,cull,density};return true;
  }
  void begin_exact(bool shallow) {
    index_=0U;density_=0.0;range_count_=0U;
    if(shallow){range_={0U,current_.block.count};phase_=phase::exact;}
    else{ranges_[range_count_++]={0U,current_.block.count};phase_=phase::exact_range;}
  }
  void begin_scalar(){phase_=phase::scalar;}
  measurement_event emit_scalar(measurement_region* out) {
    if(out){*out=measurement_region();out->domain=code(current_);out->value.uv=current_.block.uv;out->value.pixels_per_uv=density_;}
    phase_=phase::pick;return measurement_event::scalar;
  }
  measurement_event emit_projective(measurement_region* out) {
    if(out){*out=measurement_region();out->flags=3U;auto& r=out->value;
      r.pixels_per_uv=projected_.pixels_per_uv;r.projection=projected_.projection;
      r.triangle={{projected_.polygon[0],projected_.polygon[fan_],projected_.polygon[fan_+1U]}};
      r.uv.minimum=r.uv.maximum=r.triangle[0];
      for(unsigned i=1U;i<3U;++i)for(unsigned axis=0U;axis<2U;++axis){r.uv.minimum[axis]=minimum(r.uv.minimum[axis],r.triangle[i][axis]);r.uv.maximum[axis]=maximum(r.uv.maximum[axis],r.triangle[i][axis]);}}
    if(++fan_+1U==projected_.vertex_count)phase_=phase::exact;
    return measurement_event::projective;
  }
  bool split_triangle(sample_cache& cache,triangle_projection_input& t) {
    return cache.triangle(model_.source(),model_.layout().faces()+faces(current_)[index_]*3U,t);
  }
 public:
  measurement_cursor(const surface_model& model,const surface_measurement_options& options,
      const triangle_projection_context& projection,core::payload_budget budget)
      :model_(model),options_(options),context_(projection),budget_(std::move(budget)),unresolved_(options.domains.count) {}
  ~measurement_cursor(){
    static_assert(std::is_trivially_destructible<domain>::value,"Domain lifetime needs explicit disposal");
    ::operator delete(extra_);extra_credit_.clear();
  }
  static std::size_t extra_bytes(std::uint32_t n){return std::size_t(n)*8U+sizeof(domain)*320U;}
  std::size_t required_bytes()const{return phase_==phase::split_wait&&!extra_?extra_bytes(model_.layout().grouped_face_count()):0U;}
  std::size_t allocated_bytes()const{return extra_credit_.bytes();}
  bool admit(core::payload_budget::credit& credit) {
    const auto bytes=required_bytes();if(!bytes||!credit.is_work_credit()||!credit.belongs_to(budget_)||credit.bytes()!=bytes)return false;
    auto* p=::operator new(bytes,std::nothrow);if(!p)return false;
    extra_=p;order_=static_cast<std::uint32_t*>(p);temporary_=order_+model_.layout().grouped_face_count();
    descendants_=reinterpret_cast<domain*>(temporary_+model_.layout().grouped_face_count());
    extra_credit_=std::move(credit);return true;
  }
  const surface_projection_summary& summary()const{return summary_;}
  void fill(){filling_=true;phase_=phase::pick;schedule_index_=0U;}
  measurement_event next(measurement_region* output,sample_cache& cache) {
    switch(phase_) {
    case phase::validate:
      if(validate_i_==options_.domains.count){validate_i_=0U;validate_j_=1U;phase_=phase::validate_pairs;return measurement_event::progress;}
      if(options_.domains.codes[validate_i_++]/21U>=model_.layout().block_count()){phase_=phase::error;return measurement_event::invalid;}
      return measurement_event::progress;
    case phase::validate_pairs:
      if(validate_i_+1U>=options_.domains.count){
        pending_count_=0U;
        if(!model_.layout().block_count()&&model_.layout().face_count()) {
          summary_.visible=true;summary_.pixels_per_uv=std::numeric_limits<double>::infinity();summary_.center_distance=0.0;
        }
        for(unsigned i=model_.layout().block_count();i>0U;--i)pending_[pending_count_++]=std::uint16_t(i-1U);
        phase_=phase::pick;return measurement_event::progress;
      }
      if(contains(options_.domains.codes[validate_i_],options_.domains.codes[validate_j_])||contains(options_.domains.codes[validate_j_],options_.domains.codes[validate_i_])){phase_=phase::error;return measurement_event::invalid;}
      if(++validate_j_==options_.domains.count){++validate_i_;validate_j_=validate_i_+1U;}return measurement_event::progress;
    case phase::pick: {
      if(filling_) {
        if(schedule_index_==schedule_count_){phase_=phase::done;return measurement_event::complete;}
        const auto& leaf=schedule_[schedule_index_++];current_id_=leaf.id;current_=get(current_id_);density_=leaf.density;
        box_.shallow=leaf.shallow;current_facing_=leaf.cull?0:-1;
        if(leaf.scalar)begin_scalar();else begin_exact(leaf.shallow);return measurement_event::progress;
      }
      if(!pending_count_){phase_=unresolved_?phase::error:phase::done;return unresolved_?measurement_event::invalid:measurement_event::complete;}
      current_id_=pending_[--pending_count_];current_=get(current_id_);
      const auto wanted=interest(current_);if(!wanted)return measurement_event::progress;
      forced_=wanted==2U;
      if(!forced_) {
        current_facing_=facing(current_.block,context_);if(current_facing_>0)return measurement_event::progress;
        if(!project_box(current_.block,context_,box_)){phase_=phase::error;return measurement_event::invalid;}
        if(!box_.count)return measurement_event::progress;
      }
      if(forced_||(!options_.bounds_only&&!box_.shallow&&current_.depth<2U&&current_.block.count>64U)){phase_=phase::split_wait;return extra_?measurement_event::progress:measurement_event::capacity;}
      if(!options_.bounds_only&&(!box_.shallow||options_.tight)) {
        if(!box_.shallow&&!append_leaf(false,false,current_facing_==0,0.0))return measurement_event::invalid;
        begin_exact(box_.shallow);return measurement_event::progress;
      }
      summary_.refinable=summary_.refinable||(!options_.tight&&current_.block.count>0U);include_bounds(current_.block.uv);
      density_=0.0;point_=0U;
      if(!(box_.minimum_w>1e-9)){
        density_=summary_.pixels_per_uv=std::numeric_limits<double>::infinity();
        if(!append_leaf(true,box_.shallow,false,density_))return measurement_event::invalid;
        begin_scalar();
      }
      else phase_=phase::density;
      return measurement_event::progress;
    }
    case phase::split_wait:
      if(!extra_)return measurement_event::capacity;
      for(unsigned i=0U;i<4U;++i){children_[i]=domain();empty_block(children_[i].block);child_counts_[i]=0U;}
      index_=0U;phase_=phase::split_scan;return measurement_event::progress;
    case phase::split_scan: {
      if(index_==current_.block.count) {
        unsigned count=0U;for(auto c:child_counts_)if(c)++count;
        if(count<2U){if(forced_){phase_=phase::error;return measurement_event::invalid;}
          if(!append_leaf(false,false,current_facing_==0,0.0))return measurement_event::invalid;
          begin_exact(false);return measurement_event::progress;
        }
        unsigned first=current_.block.first;for(unsigned i=0U;i<4U;++i){children_[i].block.first=writes_[i]=first;children_[i].block.count=child_counts_[i];first+=child_counts_[i];}
        index_=0U;phase_=phase::split_distribute;return measurement_event::progress;
      }
      triangle_projection_input t;if(!split_triangle(cache,t)){phase_=phase::error;return measurement_event::invalid;}
      const auto key=bucket(t.uv.data(),current_.block.uv,2U);auto& b=children_[key].block;const auto sign=determinant(t)>0.0?1:-1;
      if(!child_counts_[key])b.winding=sign;else if(b.winding!=sign)b.winding=0;
      if(!add_geometry(b,t,true)){phase_=phase::error;return measurement_event::invalid;}++child_counts_[key];++index_;return measurement_event::progress;
    }
    case phase::split_distribute: {
      if(index_==current_.block.count){index_=0U;phase_=phase::split_copy;return measurement_event::progress;}
      const auto id=faces(current_)[index_++];const auto* indices=model_.layout().faces()+id*3U;float uv[6];
      for(unsigned i=0U;i<3U;++i){core::vector2d p;if(!cache.uv(model_.source(),indices[i],p)){phase_=phase::error;return measurement_event::invalid;}uv[i*2U]=float(p[0]);uv[i*2U+1U]=float(p[1]);}
      construct(temporary_+writes_[bucket(uv,current_.block.uv,2U)]++,id);return measurement_event::progress;
    }
    case phase::split_copy:
      if(index_==current_.block.count){phase_=phase::split_publish;return measurement_event::progress;}
      construct(order_+current_.block.first+index_,temporary_[current_.block.first+index_]);++index_;return measurement_event::progress;
    case phase::split_publish: {
      std::uint16_t ids[4];unsigned count=0U;
      for(unsigned i=0U;i<4U;++i)if(child_counts_[i]) {
        if(descendants_count_==320U){phase_=phase::error;return measurement_event::invalid;}
        auto& child=children_[i];finish_block(child.block);child.root=current_.root;child.depth=current_.depth+1U;
        child.child=current_.depth?current_.child:count;child.grandchild=current_.depth?count:0U;
        construct(descendants_+descendants_count_,child);ids[count++]=std::uint16_t(16U+descendants_count_++);
      }
      if(pending_count_+count>32U){phase_=phase::error;return measurement_event::invalid;}
      while(count)pending_[pending_count_++]=ids[--count];
      phase_=phase::pick;return measurement_event::progress;
    }
    case phase::density:
      if(point_==box_.count) {
        summary_.pixels_per_uv=maximum(summary_.pixels_per_uv,density_);if(!append_leaf(true,box_.shallow,false,density_))return measurement_event::invalid;
        begin_scalar();return measurement_event::progress;
      }else{
        const auto& p=box_.points[point_++];summary_.center_distance=minimum(summary_.center_distance,std::hypot(p[0]/p[3],p[1]/p[3]));
        density_=maximum(density_,block_density(current_.block,context_,p,box_.minimum_w));
        if(std::isnan(density_)){phase_=phase::error;return measurement_event::invalid;}return measurement_event::progress;
      }
    case phase::exact_range:
      if(!range_count_) {
        if(box_.shallow&&density_>0.0){if(!filling_&&!append_leaf(true,true,false,density_))return measurement_event::invalid;begin_scalar();}
        else phase_=phase::pick;
        return measurement_event::progress;
      }
      range_=ranges_[--range_count_];index_=0U;
      if(range_.count>64U){const auto half=range_.count/2U;ranges_[range_count_++]={range_.first,half};ranges_[range_count_++]={range_.first+half,range_.count-half};}
      else phase_=phase::exact;
      return measurement_event::progress;
    case phase::exact: {
      if(index_==range_.count){phase_=phase::exact_range;return measurement_event::progress;}
      const auto id=faces(current_)[range_.first+index_++];triangle_projection_input input;
      if(!cache.triangle(model_.source(),model_.layout().faces()+id*3U,input)){phase_=phase::error;return measurement_event::invalid;}
      auto p=context_.projection;p.clip=!box_.shallow;p.cull=current_facing_==0;
      if(!project_imagery_triangle(p,input,projected_)){phase_=phase::error;return measurement_event::invalid;}
      if(projected_.vertex_count>=3U) {
        if(!filling_)summary_.center_distance=minimum(summary_.center_distance,projected_.center_distance);
        if(projected_.bounds[2]>projected_.bounds[0]&&projected_.bounds[3]>projected_.bounds[1]) {
          if(std::isnan(projected_.pixels_per_uv)){phase_=phase::error;return measurement_event::invalid;}
          if(!filling_){core::bounds2d uv({{projected_.bounds[0],projected_.bounds[1]}},{{projected_.bounds[2],projected_.bounds[3]}});include_bounds(uv);summary_.pixels_per_uv=maximum(summary_.pixels_per_uv,projected_.pixels_per_uv);}
          if(box_.shallow)density_=maximum(density_,projected_.pixels_per_uv);
          else{fan_=1U;phase_=phase::fan;}
        }
      }
      return measurement_event::progress;
    }
    case phase::fan:return emit_projective(output);
    case phase::scalar:return emit_scalar(output);
    case phase::done:return measurement_event::complete;
    case phase::error:return measurement_event::invalid;
    }
    return measurement_event::invalid;
  }
};
} } }
#endif
