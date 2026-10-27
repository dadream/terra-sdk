#ifndef TERRA_C_API_SURFACE_MEASUREMENT_STORE_HPP
#define TERRA_C_API_SURFACE_MEASUREMENT_STORE_HPP

#include <terra/c_api/terra.h>
#include <terra/frame/surface_measurement.hpp>
#include <array>

namespace terra { namespace c_api_detail {

// Bounded generation slots, no unpriced growing handle map. Initial metadata
// and every arena require separate caller credit before allocation. Sealed
// measurement records retain only canonical numbers, never the source model.
class surface_measurement_store {
 public:
  surface_measurement_store();
  ~surface_measurement_store();
  static std::uint32_t model_bytes();
  static std::uint32_t measurement_bytes();
  std::size_t allocated_bytes()const;
  terra_status open_model(frame::surface_source source,imagery::node_key anchor,
      std::uint32_t resource,std::uint32_t plan,std::uint32_t reuse,std::uint32_t maximum,std::uint32_t& id);
  terra_status step_model(std::uint32_t id,std::uint32_t maximum,double milliseconds,
                         std::uint32_t quote,std::uint32_t grant,terra_surface_work_v1& output);
  terra_status open_measurement(std::uint32_t session,const terra_surface_projection_v1& request,
      const std::uint32_t* domains,std::uint32_t count,std::uint32_t maximum,std::uint32_t& id);
  terra_status step_measurement(std::uint32_t id,frame::imagery_controller& controller,
      std::uint32_t session,std::uint32_t maximum,double milliseconds,std::uint32_t quote,
      std::uint32_t grant,terra_surface_work_v1& output);
  terra_status summary(std::uint32_t id,terra_surface_summary_v1& output)const;
  std::shared_ptr<const frame::imagery_surface_input> input(std::uint32_t id,std::uint32_t session)const;
  bool close_model(std::uint32_t id);
  bool close_measurement(std::uint32_t id);
  void close_session(std::uint32_t session);
  void clear();
 private:
  struct model_record;struct measurement_record;
  template<class T>struct charged_delete{void operator()(T* value)const;};
  // Projection handles include the published snapshot, incoming bounds/exact
  // rows and transport/history loans. The Web oblique route can retain more
  // than 4096 simultaneously despite ample byte credit. Reserve bounded index
  // room for that overlap; each actual record/payload still needs caller credit.
  static constexpr std::size_t model_limit=4096U,measurement_limit=16384U;
  core::payload_budget budget_;
  std::array<std::unique_ptr<model_record,charged_delete<model_record>>,model_limit> models_;
  std::array<std::unique_ptr<measurement_record,charged_delete<measurement_record>>,measurement_limit> measurements_;
  std::uint32_t next_model_=1U,next_measurement_=1U;
  model_record* model(std::uint32_t id)const;
  measurement_record* measurement(std::uint32_t id)const;
};

} }
#endif
