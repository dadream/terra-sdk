#ifndef TERRA_FRAME_SURFACE_MODEL_HPP
#define TERRA_FRAME_SURFACE_MODEL_HPP

#include <terra/core/payload_budget.hpp>
#include <terra/frame/surface_source.hpp>

namespace terra { namespace frame {
namespace surface_detail {struct layout_storage;struct model_storage;}

struct surface_uv_block {
  core::bounds2d uv;
  std::uint32_t first=0U,count=0U;
  int winding=0;
};
struct surface_block : surface_uv_block {
  core::vector3d minimum{{}},maximum{{}},du{{}},dv{{}},du_radius{{}},dv_radius{{}};
  double deviation=0.0;
};

// Intrusive immutable loans. Copying does not allocate or create a second charge.
// Last release frees the arena before returning its credit. One executor owns
// all operations, including final loan release.
class surface_layout {
 public:
  surface_layout()=default;
  surface_layout(const surface_layout& other);
  surface_layout(surface_layout&& other) noexcept;
  surface_layout& operator=(const surface_layout& other);
  surface_layout& operator=(surface_layout&& other) noexcept;
  ~surface_layout();
  explicit operator bool() const{return storage_!=nullptr;}
  std::uint32_t face_count() const;
  std::uint32_t grouped_face_count() const;
  std::uint32_t block_count() const;
  std::uint32_t hull_count() const;
  const std::uint16_t* faces() const;
  const std::uint32_t* order() const;
  const core::vector2d* hull() const;
  const core::bounds2d& bounds() const;
  const surface_uv_block& block(std::uint32_t index) const;
  std::size_t payload_bytes() const;
  bool compatible(const surface_source& source) const;
 private:
  friend class surface_model_work;
  surface_detail::layout_storage* storage_=nullptr;
  void reset();
};

class surface_model {
 public:
  surface_model()=default;
  surface_model(const surface_model& other);
  surface_model(surface_model&& other) noexcept;
  surface_model& operator=(const surface_model& other);
  surface_model& operator=(surface_model&& other) noexcept;
  ~surface_model();
  explicit operator bool() const{return storage_!=nullptr;}
  const surface_layout& layout() const;
  const surface_source& source() const;
  const surface_block& block(std::uint32_t index) const;
  std::size_t payload_bytes() const;
 private:
  friend class surface_model_work;
  surface_detail::model_storage* storage_=nullptr;
  void reset();
};

enum class surface_model_status {waiting_for_capacity,building,complete,cancelled,invalid_input,allocation_failed,internal_error};
struct surface_model_progress {
  surface_model_status status=surface_model_status::waiting_for_capacity;
  std::size_t operations=0U,required_work_bytes=0U;
  std::uint64_t total_operations=0U;
};

// Full CBDAM topology/UV and geometry summaries, with no complete XYZ/UV copy.
// Supply a compatible layout to reuse its immutable topology/hull/grouping.
class surface_model_work {
 public:
  surface_model_work(surface_source source,core::payload_budget budget,surface_layout layout={});
  ~surface_model_work();
  surface_model_work(const surface_model_work&)=delete;
  surface_model_work& operator=(const surface_model_work&)=delete;
  surface_model_progress step(std::size_t maximum_operations,double maximum_milliseconds=0.0);
  bool admit();
  bool admit(core::payload_budget::credit& authorized);
  surface_model take_model();
  std::size_t allocated_bytes() const;
  void cancel();
 private:
  struct state;struct state_deleter{void operator()(state*)const;};
  surface_source source_;
  core::payload_budget budget_;
  surface_layout layout_;
  surface_model model_;
  core::payload_budget::credit state_credit_,layout_credit_,model_credit_;
  std::unique_ptr<state,state_deleter> state_;
  surface_model_status status_=surface_model_status::waiting_for_capacity;
  std::uint64_t total_operations_=0U;
  surface_model_progress progress(std::size_t operations) const;
};
} }
#endif
