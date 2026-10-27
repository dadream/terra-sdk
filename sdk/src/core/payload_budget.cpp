#include <terra/core/payload_budget.hpp>

#include <algorithm>
#include <cassert>
#include <utility>

namespace terra {
namespace core {

struct payload_budget::state {
  std::size_t maximum = 0U, resident = 0U, work = 0U, peak = 0U;
};

payload_budget::credit::credit(credit&& other) noexcept { *this = std::move(other); }
payload_budget::credit& payload_budget::credit::operator=(credit&& other) noexcept {
  if (this != &other) {
    clear(); owner_ = std::move(other.owner_); bytes_ = other.bytes_; resident_ = other.resident_;
    other.bytes_ = 0U;
  }
  return *this;
}
payload_budget::credit::~credit() { clear(); }
bool payload_budget::credit::belongs_to(const payload_budget& budget) const { return owner_ == budget.state_; }
void payload_budget::credit::clear() { shrink(0U); owner_.reset(); }
void payload_budget::credit::shrink(std::size_t value) {
  assert(value <= bytes_);
  if (owner_) (resident_ ? owner_->resident : owner_->work) -= bytes_ - value;
  bytes_ = value;
}

payload_budget::payload_budget(std::size_t maximum) : state_(std::make_shared<state>()) { state_->maximum = maximum; }
payload_budget::credit payload_budget::resident_credit() const {
  credit result; result.owner_ = state_; result.resident_ = true; return result;
}
std::size_t payload_budget::resident_bytes() const { return state_->resident; }
std::size_t payload_budget::work_bytes() const { return state_->work; }
std::size_t payload_budget::peak_bytes() const { return state_->peak; }
std::size_t payload_budget::maximum_bytes() const { return state_->maximum; }
bool payload_budget::reserve(std::size_t value, credit& output) {
  if (output.attached()) return false;
  const auto occupied = state_->resident + state_->work;
  if (occupied > state_->maximum || value > state_->maximum - occupied) return false;
  output.owner_ = state_; output.bytes_ = value; output.resident_ = false;
  state_->work += value; state_->peak = std::max(state_->peak, occupied + value);
  return true;
}
bool payload_budget::split_work(credit& source, std::size_t bytes, credit& output) {
  if (!source.is_work_credit() || !source.belongs_to(*this) ||
      output.attached() || bytes > source.bytes_) return false;
  output.owner_ = source.owner_; output.bytes_ = bytes; output.resident_ = false;
  source.bytes_ -= bytes;
  if (!source.bytes_) source.owner_.reset();
  return true;
}
void payload_budget::adopt(credit& source, credit& destination, std::size_t value) {
  assert(source.belongs_to(*this) && !source.resident_ && source.bytes_ >= value);
  assert(destination.belongs_to(*this) && destination.resident_);
  source.shrink(source.bytes_ - value);
  destination.bytes_ += value; state_->resident += value;
}

}  // namespace core
}  // namespace terra
