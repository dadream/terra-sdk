#include <terra/frame/surface_model.hpp>
#include "surface_blocks.hpp"

#include <algorithm>
#include <cmath>
#include <new>
#include <utility>

namespace terra { namespace frame {
namespace surface_detail {
struct layout_storage {
  std::size_t references=1U,bytes=0U;
  core::payload_budget::credit allocation;
  surface_uv_identity identity;
  core::bounds2d bounds;
  std::uint32_t dimension=0U,faces_count=0U,grouped=0U,blocks_count=0U,hull_count=0U;
  surface_uv_block blocks[16];
  std::uint16_t* faces=nullptr;
  std::uint32_t* order=nullptr;
  core::vector2d* hull=nullptr;
};
struct model_storage {
  std::size_t references=1U;
  core::payload_budget::credit allocation;
  surface_layout layout;
  surface_source source;
  surface_block blocks[16];
};
struct ranges {
  void* base;std::size_t bytes;
  template<class T> T* add(std::size_t count) {
    bytes=(bytes+alignof(T)-1U)/alignof(T)*alignof(T);const auto first=bytes;bytes+=count*sizeof(T);
    return base?reinterpret_cast<T*>(static_cast<unsigned char*>(base)+first):nullptr;
  }
};
std::size_t layout_bytes(std::uint32_t d,layout_storage* p=nullptr) {
  ranges r{p,sizeof(layout_storage)};
  auto* faces=r.add<std::uint16_t>(std::size_t(d)*d*3U);
  auto* order=r.add<std::uint32_t>(std::size_t(d)*d);
  auto* hull=r.add<core::vector2d>(d*3U);
  if(p){p->faces=faces;p->order=order;p->hull=hull;p->bytes=r.bytes;}
  return r.bytes;
}
}
using namespace surface_detail;

surface_layout::surface_layout(const surface_layout& x):storage_(x.storage_){if(storage_)++storage_->references;}
surface_layout::surface_layout(surface_layout&& x)noexcept:storage_(x.storage_){x.storage_=nullptr;}
surface_layout& surface_layout::operator=(const surface_layout& x){surface_layout copy(x);std::swap(storage_,copy.storage_);return *this;}
surface_layout& surface_layout::operator=(surface_layout&& x)noexcept{if(this!=&x){reset();storage_=x.storage_;x.storage_=nullptr;}return *this;}
surface_layout::~surface_layout(){reset();}
void surface_layout::reset(){if(storage_&&!--storage_->references){auto credit=std::move(storage_->allocation);storage_->~layout_storage();::operator delete(storage_);credit.clear();}storage_=nullptr;}
std::uint32_t surface_layout::face_count()const{return storage_?storage_->faces_count:0U;}
std::uint32_t surface_layout::grouped_face_count()const{return storage_?storage_->grouped:0U;}
std::uint32_t surface_layout::block_count()const{return storage_?storage_->blocks_count:0U;}
std::uint32_t surface_layout::hull_count()const{return storage_?storage_->hull_count:0U;}
const std::uint16_t* surface_layout::faces()const{return storage_?storage_->faces:nullptr;}
const std::uint32_t* surface_layout::order()const{return storage_?storage_->order:nullptr;}
const core::vector2d* surface_layout::hull()const{return storage_?storage_->hull:nullptr;}
const core::bounds2d& surface_layout::bounds()const{return storage_->bounds;}
const surface_uv_block& surface_layout::block(std::uint32_t i)const{return storage_->blocks[i];}
std::size_t surface_layout::payload_bytes()const{return storage_?storage_->bytes:0U;}
bool surface_layout::compatible(const surface_source& source)const{return storage_&&source.valid()&&storage_->identity.compatible(source.uv_identity());}

surface_model::surface_model(const surface_model& x):storage_(x.storage_){if(storage_)++storage_->references;}
surface_model::surface_model(surface_model&& x)noexcept:storage_(x.storage_){x.storage_=nullptr;}
surface_model& surface_model::operator=(const surface_model& x){surface_model copy(x);std::swap(storage_,copy.storage_);return *this;}
surface_model& surface_model::operator=(surface_model&& x)noexcept{if(this!=&x){reset();storage_=x.storage_;x.storage_=nullptr;}return *this;}
surface_model::~surface_model(){reset();}
void surface_model::reset(){if(storage_&&!--storage_->references){auto credit=std::move(storage_->allocation);storage_->~model_storage();::operator delete(storage_);credit.clear();}storage_=nullptr;}
const surface_layout& surface_model::layout()const{return storage_->layout;}
const surface_source& surface_model::source()const{return storage_->source;}
const surface_block& surface_model::block(std::uint32_t i)const{return storage_->blocks[i];}
std::size_t surface_model::payload_bytes()const{return storage_?sizeof(model_storage):0U;}

struct surface_model_work::state {
  enum class phase {bounds,topology,prefix,order,boundary,sort,sort_copy,unique,hull,hull_copy,model_init,geometry,finalize,done,error};
  phase current=phase::bounds;
  sample_cache cache;
  surface_uv_block bins[16];
  std::uint32_t counts[16]{},writes[16]{},bin_to_block[16]{};
  std::uint32_t dimension=0U,index=0U,row=0U,column=0U,vertex=0U,half=0U,block=0U;
  core::vector2d *points=nullptr;
  std::uint32_t *sort_a=nullptr,*sort_b=nullptr,*codes=nullptr,*hull=nullptr;
  std::uint32_t width=1U,left=0U,a=0U,b=0U,out=0U,middle=0U,end=0U,boundary_count=0U,unique_count=0U;
  std::uint32_t hull_size=0U,hull_half=0U,half_start=0U;
  bool original_sort=true;
  static std::size_t bytes(std::uint32_t d,void* base=nullptr,state* s=nullptr) {
    ranges r{base,sizeof(state)};auto* p=r.add<core::vector2d>(d*3U);
    auto* x=r.add<std::uint32_t>(d*3U);auto* y=r.add<std::uint32_t>(d*3U);auto* h=r.add<std::uint32_t>(d*6U);
    if(s){s->points=p;s->sort_a=x;s->sort_b=y;s->codes=x;s->hull=h;}return r.bytes;
  }
  explicit state(std::uint32_t d):dimension(d),column(d),boundary_count(d*3U) {
    bytes(d,this,this);
    for(auto& bin:bins){const auto inf=std::numeric_limits<double>::infinity();bin.uv.minimum={{inf,inf}};bin.uv.maximum={{-inf,-inf}};}
  }
  bool uv_triangle(const surface_source& source,const std::uint16_t* ids,float* values) {
    for(unsigned i=0U;i<3U;++i){core::vector2d p;if(!cache.uv(source,ids[i],p))return false;
      if(!std::isfinite(p[0])||!std::isfinite(p[1]))return false;
      values[i*2U]=float(p[0]);values[i*2U+1U]=float(p[1]);}
    return true;
  }
  void begin_merge(){a=left;b=middle=std::min(boundary_count,left+width);out=left;end=std::min(boundary_count,left+width*2U);}
  double ordering(std::uint32_t x,std::uint32_t y)const {const auto dx=points[x][0]-points[y][0];return dx==0.0?points[x][1]-points[y][1]:dx;}
  double cross(std::uint32_t x,std::uint32_t y,std::uint32_t z)const{return (points[y][0]-points[x][0])*(points[z][1]-points[x][1])-(points[y][1]-points[x][1])*(points[z][0]-points[x][0]);}
  void one(const surface_source& source,layout_storage& layout,model_storage& model) {
    const auto n=dimension*dimension;
    switch(current) {
    case phase::bounds: {
      if(index==source.vertex_count()){index=0U;current=phase::topology;return;}
      core::vector2d p;if(!cache.uv(source,index++,p)||!std::isfinite(p[0])||!std::isfinite(p[1])){current=phase::error;return;}
      if(index==1U)layout.bounds.minimum=layout.bounds.maximum=p;
      else for(unsigned axis=0U;axis<2U;++axis){layout.bounds.minimum[axis]=minimum(layout.bounds.minimum[axis],p[axis]);layout.bounds.maximum[axis]=maximum(layout.bounds.maximum[axis],p[axis]);}
      return;
    }
    case phase::topology: {
      if(index==n){index=0U;current=phase::prefix;return;}
      const auto width=dimension-row,next=vertex+width+1U;
      const std::uint16_t ids[]={std::uint16_t(half?vertex+column-1U:vertex+column),std::uint16_t(next+column-1U),std::uint16_t(half?next+column-2U:vertex+column-1U)};
      for(unsigned i=0U;i<3U;++i)construct(layout.faces+index*3U+i,ids[i]);
      float uv[6];if(!uv_triangle(source,ids,uv)){current=phase::error;return;}
      const double det=(double(uv[2])-uv[0])*(double(uv[5])-uv[1])-(double(uv[4])-uv[0])*(double(uv[3])-uv[1]);
      if(std::abs(det)>=1e-16) {
        const auto key=bucket(uv,layout.bounds,4U);auto& bin=bins[key];const auto sign=det>0.0?1:-1;
        if(!counts[key])bin.winding=sign;else if(bin.winding!=sign)bin.winding=0;++counts[key];
        for(unsigned i=0U;i<3U;++i)for(unsigned axis=0U;axis<2U;++axis){const double v=uv[i*2U+axis];bin.uv.minimum[axis]=minimum(bin.uv.minimum[axis],v);bin.uv.maximum[axis]=maximum(bin.uv.maximum[axis],v);}
      }
      ++index;
      if(half){half=0U;--column;}else if(column>1U)half=1U;else{++row;vertex=next;column=dimension-row;}
      return;
    }
    case phase::prefix:
      if(index==16U){index=0U;current=phase::order;return;}
      if(counts[index]){auto& bin=layout.blocks[layout.blocks_count];bin=bins[index];bin.first=layout.grouped;bin.count=counts[index];writes[index]=layout.grouped;layout.grouped+=counts[index];bin_to_block[index]=layout.blocks_count++;}++index;return;
    case phase::order: {
      if(index==n){index=0U;row=0U;vertex=0U;current=phase::boundary;return;}
      float uv[6];if(!uv_triangle(source,layout.faces+index*3U,uv)){current=phase::error;return;}
      const double det=(double(uv[2])-uv[0])*(double(uv[5])-uv[1])-(double(uv[4])-uv[0])*(double(uv[3])-uv[1]);
      if(std::abs(det)>=1e-16)construct(layout.order+writes[bucket(uv,layout.bounds,4U)]++,index);
      ++index;return;
    }
    case phase::boundary: {
      if(index==boundary_count){width=1U;left=0U;begin_merge();current=phase::sort;return;}
      std::uint32_t id;
      if(index<=dimension)id=index;
      else {
        const auto local=index-dimension-1U,y=local/2U+1U;
        const auto first=y*(dimension+1U)-y*(y-1U)/2U;
        id=first+(local%2U?dimension-y:0U);
      }
      core::vector2d p;if(!cache.uv(source,id,p)){current=phase::error;return;}
      construct(points+index,p);construct(codes+index,index);++index;return;
    }
    case phase::sort:
      if(out==end) {
        left+=width*2U;
        if(left>=boundary_count){std::swap(sort_a,sort_b);original_sort=!original_sort;width*=2U;left=0U;
          if(width>=boundary_count){index=0U;current=original_sort?phase::unique:phase::sort_copy;return;}}
        begin_merge();return;
      }else{
        const auto value=b==end||(a<middle&&!(ordering(sort_a[a],sort_a[b])>0.0))?sort_a[a++]:sort_a[b++];
        construct(sort_b+out++,value);return;
      }
    case phase::sort_copy:
      if(index==boundary_count){index=0U;current=phase::unique;return;}
      construct(codes+index,sort_a[index]);++index;return;
    case phase::unique:
      if(index==boundary_count){index=0U;current=phase::hull;return;}
      if(!unique_count||points[codes[index]]!=points[codes[unique_count-1U]])construct(codes+unique_count++,codes[index]);
      ++index;return;
    case phase::hull:
      if(index==unique_count){if(hull_size>half_start)--hull_size;
        if(++hull_half==2U){index=0U;current=phase::hull_copy;return;}half_start=hull_size;index=0U;return;}
      {const auto code=codes[hull_half?unique_count-1U-index:index];
        if(hull_size>=half_start+2U&&cross(hull[hull_size-2U],hull[hull_size-1U],code)<=0.0)--hull_size;
        else{construct(hull+hull_size++,code);++index;}return;}
    case phase::hull_copy:
      if(index==hull_size){layout.hull_count=hull_size;index=0U;current=phase::model_init;return;}
      construct(layout.hull+index,points[hull[index]]);++index;return;
    case phase::model_init:
      if(index==layout.blocks_count){index=block=0U;current=phase::geometry;return;}
      empty_block(model.blocks[index]);static_cast<surface_uv_block&>(model.blocks[index])=layout.blocks[index];++index;return;
    case phase::geometry: {
      if(index==layout.grouped){index=0U;current=phase::finalize;return;}
      while(block+1U<layout.blocks_count&&index>=layout.blocks[block].first+layout.blocks[block].count)++block;
      triangle_projection_input input;
      if(!cache.triangle(source,layout.faces+layout.order[index++]*3U,input)||!add_geometry(model.blocks[block],input,false)){current=phase::error;return;}
      return;
    }
    case phase::finalize:
      if(index==layout.blocks_count){current=phase::done;return;}
      finish_block(model.blocks[index++]);return;
    case phase::done:case phase::error:return;
    }
  }
};

surface_model_work::surface_model_work(surface_source source,core::payload_budget budget,surface_layout layout)
    :source_(std::move(source)),budget_(std::move(budget)),layout_(std::move(layout)) {
  if(!source_.valid()||(layout_&&!layout_.compatible(source_)))status_=surface_model_status::invalid_input;
}
surface_model_work::~surface_model_work(){cancel();}
void surface_model_work::state_deleter::operator()(state* p)const{if(p){p->~state();::operator delete(p);}}
surface_model_progress surface_model_work::progress(std::size_t operations)const {
  surface_model_progress p;p.status=status_;p.operations=operations;p.total_operations=total_operations_;
  if(status_==surface_model_status::waiting_for_capacity)p.required_work_bytes=state::bytes(source_.dimension())+sizeof(model_storage)+(layout_?0U:layout_bytes(source_.dimension()));
  return p;
}
bool surface_model_work::admit(){const auto bytes=progress(0U).required_work_bytes;if(!bytes)return false;core::payload_budget::credit credit;if(!budget_.reserve(bytes,credit))return false;return admit(credit);}
bool surface_model_work::admit(core::payload_budget::credit& credit) {
  const auto bytes=progress(0U).required_work_bytes;
  if(!bytes||!credit.is_work_credit()||!credit.belongs_to(budget_)||credit.bytes()!=bytes)return false;
  const auto scratch_bytes=state::bytes(source_.dimension()),uv_bytes=layout_?0U:layout_bytes(source_.dimension());
  void* s=::operator new(scratch_bytes,std::nothrow);void* m=s?::operator new(sizeof(model_storage),std::nothrow):nullptr;
  void* uv=m&&uv_bytes?::operator new(uv_bytes,std::nothrow):nullptr;
  if(!s||!m||(uv_bytes&&!uv)){::operator delete(uv);::operator delete(m);::operator delete(s);status_=surface_model_status::allocation_failed;return false;}
  state_.reset(::new(s) state(source_.dimension()));
  model_.storage_=::new(m) model_storage;model_.storage_->allocation=budget_.resident_credit();model_.storage_->source=source_;
  if(uv_bytes){layout_.storage_=::new(uv) layout_storage;layout_.storage_->allocation=budget_.resident_credit();layout_.storage_->identity=source_.uv_identity();
    layout_.storage_->dimension=source_.dimension();layout_.storage_->faces_count=source_.dimension()*source_.dimension();layout_bytes(source_.dimension(),layout_.storage_);
    budget_.split_work(credit,uv_bytes,layout_credit_);
  }else state_->current=state::phase::model_init;
  model_.storage_->layout=layout_;
  budget_.split_work(credit,sizeof(model_storage),model_credit_);state_credit_=std::move(credit);
  status_=surface_model_status::building;return true;
}
surface_model_progress surface_model_work::step(std::size_t maximum_operations,double window) {
  if(!maximum_operations||!std::isfinite(window)||window<0.0||status_!=surface_model_status::building)return progress(0U);
  const auto started=window>0.0?clock_ms():0.0;std::size_t operations=0U;
  while(operations<maximum_operations&&status_==surface_model_status::building) {
    state_->one(source_,*layout_.storage_,*model_.storage_);++operations;
    if(state_->current==state::phase::error)status_=surface_model_status::internal_error;
    if(state_->current==state::phase::done) {
      if(layout_credit_.attached())budget_.adopt(layout_credit_,layout_.storage_->allocation,layout_credit_.bytes());
      budget_.adopt(model_credit_,model_.storage_->allocation,model_credit_.bytes());status_=surface_model_status::complete;
    }
    if(window>0.0&&operations%64U==0U&&clock_ms()-started>=window)break;
  }
  total_operations_+=operations;return progress(operations);
}
surface_model surface_model_work::take_model() {
  if(status_!=surface_model_status::complete)return {};
  auto result=std::move(model_);state_.reset();state_credit_.clear();layout_=surface_layout();source_=surface_source();return result;
}
std::size_t surface_model_work::allocated_bytes()const{return (state_?state::bytes(source_.dimension()):0U)+model_.payload_bytes()+(layout_credit_.attached()?layout_.payload_bytes():0U);}
void surface_model_work::cancel() {
  status_=surface_model_status::cancelled;state_.reset();state_credit_.clear();model_.reset();model_credit_.clear();layout_.reset();layout_credit_.clear();source_=surface_source();
}
} }
