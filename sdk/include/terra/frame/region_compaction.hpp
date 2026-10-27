#ifndef TERRA_FRAME_REGION_COMPACTION_HPP
#define TERRA_FRAME_REGION_COMPACTION_HPP

#include <terra/core/payload_budget.hpp>
#include <terra/frame/imagery.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>

namespace terra {
namespace frame {

// Immutable semantic rows, independent of their allocator/container. A supplied
// owner is retained; without one the caller must outlive the compaction task.
// In either case rows cannot change while the view is in use.
struct measurement_region_view {
  std::shared_ptr<const void> owner;
  const measurement_region* rows = nullptr;
  std::size_t count = 0U;
  bool valid() const { return !count || rows; }
  std::size_t size() const { return count; }
  const measurement_region& operator[](std::size_t index) const { return rows[index]; }
};

enum class region_compaction_status {
  validating, waiting_for_capacity, running, complete, cancelled,
  invalid_input, allocation_failed, internal_error
};

struct region_compaction_progress {
  region_compaction_status status = region_compaction_status::validating;
  std::size_t operations = 0U;
  std::uint64_t total_operations = 0U;
  std::size_t required_work_bytes = 0U, output_count = 0U;
};

// One persistent producer. The caller owns/charges the immutable input; this
// reader keeps any supplied shared owner until cancellation/destruction. One admitted
// buffer holds all variable work, including the private state and descriptors.
// There is no global cache and no full-sized materialized output allocation.
// The task and its shared budget belong to one executor; step/read/cancel must
// not run concurrently. Returned rows are independent caller-owned copies.
class region_compaction_work {
 public:
  region_compaction_work(measurement_region_view input,
                         core::payload_budget budget);
  ~region_compaction_work();
  region_compaction_work(const region_compaction_work&) = delete;
  region_compaction_work& operator=(const region_compaction_work&) = delete;

  // Quote for a validated input. Zero projective rows need no workspace.
  // SIZE_MAX means an unsupported shape; this never allocates.
  static std::size_t work_bytes(std::size_t input_count,
                                std::size_t projective_count);
  // A zero time window uses only the operation limit; a positive finite window
  // checks elapsed time after each64 internal actions. Negative/nonfinite
  // windows make no progress. This is cooperative work, not a hard deadline.
  region_compaction_progress step(std::size_t maximum_operations,
                                  double maximum_milliseconds = 0.0);
  // Explicit admission, not an automatic retry on every step. A refusal leaves
  // the waiting cursor and input untouched; call again on capacity change.
  bool admit();
  // A producer can reserve input and workspace together before either is
  // allocated. Transfer one exact work credit from this same budget; failed
  // admission leaves that caller-owned credit unchanged.
  bool admit(core::payload_budget::credit& authorized);
  std::size_t allocated_bytes() const;
  // Output elements must be constructed by their caller. At most256 are copied;
  // invalid/pending reads write no elements. No allocation or ownership refund.
  bool read(std::size_t first, measurement_region* output,
            std::size_t capacity, std::size_t& count) const;
  void cancel();

 private:
  struct state;
  struct state_deleter { void operator()(state*) const; };
  measurement_region_view input_;
  core::payload_budget budget_;
  core::payload_budget::credit credit_;
  std::unique_ptr<state, state_deleter> state_;
  region_compaction_status status_ = region_compaction_status::validating;
  std::size_t input_count_ = 0U, validated_ = 0U, projective_count_ = 0U;
  std::uint64_t total_operations_ = 0U;
  region_compaction_progress progress(std::size_t operations) const;
};

} // namespace frame
} // namespace terra

#endif
