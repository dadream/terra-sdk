#ifndef TERRA_FRAME_HEIGHT_SESSION_HPP
#define TERRA_FRAME_HEIGHT_SESSION_HPP

#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/height_demand.hpp>

namespace terra {
namespace frame {

enum class height_session_state : std::uint32_t {
  idle, planning, working, waiting, ready, limited, unavailable, failed
};
enum class height_input_state { unknown, pending, consumed };
enum height_session_reason : std::uint32_t {
  height_no_data = 1U, height_request_failed = 2U,
  height_level_limit = 4U, height_capacity = 8U, height_invalid = 16U
};
struct height_session_request {
  std::uint32_t level = 0U;
  core::grid_point id{{0, 0, 0}};
  bool root = false;
};
struct height_session_sample {
  bool available = false;
  std::uint32_t level = 0U, data_level = 0U, fragment = 0U, reasons = 0U;
  core::grid_point id{{0, 0, 0}};
  double height_metres = 0.0, sample_spacing_metres = 0.0;
};
struct height_session_region {
  codec::height_fragment heights;
  std::array<core::vector3d, 3U> corners{{}};
  double geometry_spacing_metres = 0.0, height_scale = 1.0;
};

// Owns query reconstruction, independently of visible terrain or cache cuts.
// Each step unit scans/processes one node (at most one CBDAM decode refinement).
// Requests are a bounded frontier; completing them resumes work without polling.
// The byte limit covers decoded records, retained height arrays and the codec's
// refinement workspace. Planner/graph metadata and encoded input belong to the
// caller's separate admission; maximum_metadata_bytes is a conservative reserve.
class height_session {
 public:
  static constexpr std::size_t maximum_metadata_bytes = 512U * 1024U;
  static constexpr std::size_t maximum_requests = 8U;
  height_session();
  ~height_session();
  height_session(const height_session&) = delete;
  height_session& operator=(const height_session&) = delete;
  height_session_state begin(const height_demand_request& request,
                             double height_scale, std::size_t maximum_bytes);
  height_session_state step(std::size_t maximum_work);
  // Exact receipt identity survives completion until clear/end. A caller can
  // acknowledge consumed inputs without decoding or changing the first result.
  height_input_state input_state(const height_session_request& request) const;
  // Submission is accepted only for an outstanding exact request. The caller
  // must use can_decode before allocating a decoded record.
  bool can_decode(const height_session_request& request) const;
  bool submit(const height_session_request& request, codec::height_patch&& record);
  bool unavailable(const height_session_request& request, bool failure);
  void clear();
  height_session_state state() const;
  const height_session_sample& sample() const;
  // The completed target fragment remains owned until clear/destruction. It
  // can be copied under separate receiver credit for nearby point sampling.
  const height_session_region& region() const;
  const std::vector<height_session_request>& requests() const;
  std::size_t payload_bytes() const;
  std::size_t peak_bytes() const;
  std::size_t maximum_bytes() const;

 private:
  struct implementation;
  std::unique_ptr<implementation> implementation_;
};
}  // namespace frame
}  // namespace terra
#endif
