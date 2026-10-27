#ifndef TERRA_C_API_MESH_PAYLOAD_HPP
#define TERRA_C_API_MESH_PAYLOAD_HPP

#include <terra/core/payload_budget.hpp>

#include <limits>
#include <vector>

namespace terra {
namespace c_api_detail {

// Observe unique arrays, not their cache/registry memberships. Admission still
// uses the existing mesh production grant; this counter adds no memory policy.
class mesh_payload {
 public:
  using allocation = core::payload_budget::credit;
  mesh_payload() : budget_(std::numeric_limits<std::size_t>::max()) {}
  allocation owner() const { return budget_.resident_credit(); }
  std::size_t bytes() const { return budget_.resident_bytes(); }
  bool observe(allocation& target, std::size_t bytes) {
    if (!target.belongs_to(budget_)) return false;
    if (bytes <= target.bytes()) { target.shrink(bytes); return true; }
    allocation growth;
    const auto extra = bytes - target.bytes();
    if (!budget_.reserve(extra, growth)) return false;
    budget_.adopt(growth, target, extra);
    return true;
  }
 private:
  core::payload_budget budget_;
};

struct mesh_texture {
  explicit mesh_texture(const mesh_payload& payload) : allocation(payload.owner()) {}
  // Free the vector before retiring its count. Aliased core readers keep this
  // complete owner alive after the last materialized XYZ resource retires.
  mesh_payload::allocation allocation;
  std::vector<float> values;
};

}  // namespace c_api_detail
}  // namespace terra
#endif
