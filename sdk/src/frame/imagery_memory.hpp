#ifndef TERRA_FRAME_IMAGERY_MEMORY_HPP
#define TERRA_FRAME_IMAGERY_MEMORY_HPP

#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <type_traits>

namespace terra {
namespace frame {
namespace imagery_memory {

// Requested allocation bytes, not allocator overhead or process/Wasm capacity.
// An allocation keeps its original account across a move, reset or snapshot
// retirement. Only these explicit allocators participate; no global new hook.
struct account {
  std::size_t bytes = 0U, peak = 0U, references = 0U, outputs = 0U, inputs = 0U;
  std::uint64_t next_input_id = 1U;
  void acquire(std::size_t size) { bytes += size; peak = std::max(peak, bytes); }
  void release(std::size_t size) { assert(bytes >= size); bytes -= size; }
};

inline std::shared_ptr<account>& current_account() {
  static thread_local std::shared_ptr<account> value;
  return value;
}

// Synchronous native entry points nest safely, including source callbacks
// which enter a different controller. Continuations retain no active scope.
class scope {
 public:
  explicit scope(std::shared_ptr<account> owner) : previous_(current_account()) {
    current_account() = std::move(owner);
  }
  ~scope() { current_account() = std::move(previous_); }
  scope(const scope&) = delete;
  scope& operator=(const scope&) = delete;
 private:
  std::shared_ptr<account> previous_;
};

template<class T, bool Reference = false> struct allocator {
  using value_type = T;
  template<class U> struct rebind { using other = allocator<U, Reference>; };
  using propagate_on_container_move_assignment = std::true_type;
  using propagate_on_container_copy_assignment = std::true_type;
  using propagate_on_container_swap = std::true_type;
  std::shared_ptr<account> owner;
  allocator() : owner(current_account()) {}
  // A moved-from work vector is reused for the next child. Copy the binding
  // even on a container move so its next allocation keeps the same owner.
  allocator(const allocator&) = default;
  allocator& operator=(const allocator&) = default;
  template<class U> allocator(const allocator<U, Reference>& other) : owner(other.owner) {}
  T* allocate(std::size_t count) {
    T* result = std::allocator<T>().allocate(count);
    if (owner) {
      owner->acquire(count * sizeof(T));
      if (Reference) owner->references += count * sizeof(T);
    }
    return result;
  }
  void deallocate(T* pointer, std::size_t count) {
    std::allocator<T>().deallocate(pointer, count);
    if (owner) {
      owner->release(count * sizeof(T));
      if (Reference) { assert(owner->references >= count * sizeof(T)); owner->references -= count * sizeof(T); }
    }
  }
  template<class U> bool operator==(const allocator<U, Reference>& other) const { return owner == other.owner; }
  template<class U> bool operator!=(const allocator<U, Reference>& other) const { return !(*this == other); }
};

// Input handles include their shared control allocation in the input account.
// The producer quotes an envelope and allocation must fit it before touching
// memory; a library with a larger control block cannot silently exceed credit.
template<class T, std::size_t Maximum> struct input_allocator : allocator<T> {
  template<class U> struct rebind { using other = input_allocator<U, Maximum>; };
  input_allocator() = default;
  template<class U> input_allocator(const input_allocator<U, Maximum>& other)
      : allocator<T>(static_cast<const allocator<U>&>(other)) {}
  T* allocate(std::size_t count) {
    static_assert(sizeof(T) <= Maximum, "Shared input control block exceeds its quoted envelope");
    // allocate_shared's implementation allocation must obey the compile-time
    // envelope. This is an unsupported allocator layout, not resource pressure;
    // ordinary pressure is rejected by the caller before this allocation.
    if (count > Maximum / sizeof(T)) std::abort();
    T* result = allocator<T>::allocate(count);
    if (this->owner) this->owner->inputs += count * sizeof(T);
    return result;
  }
  void deallocate(T* pointer, std::size_t count) {
    allocator<T>::deallocate(pointer, count);
    if (this->owner) { assert(this->owner->inputs >= count * sizeof(T)); this->owner->inputs -= count * sizeof(T); }
  }
};

// Public input/output arrays use ordinary std::vector. Their exact capacity
// joins the owner when transferred, and stays charged until actual destruction.
class charge {
 public:
  explicit charge(std::size_t bytes = 0U, bool output = false, bool input = false)
      : owner_(current_account()), output_(output), input_(input) { resize(bytes); }
  ~charge() { resize(0U); }
  charge(const charge&) = delete;
  charge& operator=(const charge&) = delete;
  charge(charge&& other) noexcept :owner_(std::move(other.owner_)),output_(other.output_),input_(other.input_),bytes_(other.bytes_) {
    other.bytes_=0U;
  }
  charge& operator=(charge&& other) noexcept {
    if(this!=&other){resize(0U);owner_=std::move(other.owner_);output_=other.output_;input_=other.input_;bytes_=other.bytes_;other.bytes_=0U;}
    return *this;
  }
  std::size_t bytes() const { return bytes_; }
  void resize(std::size_t bytes) {
    if (owner_) {
      if (bytes > bytes_) owner_->acquire(bytes - bytes_);
      else owner_->release(bytes_ - bytes);
      if (output_) {
        if (bytes > bytes_) owner_->outputs += bytes - bytes_;
        else { assert(owner_->outputs >= bytes_ - bytes); owner_->outputs -= bytes_ - bytes; }
      }
      if (input_) {
        if (bytes > bytes_) owner_->inputs += bytes - bytes_;
        else { assert(owner_->inputs >= bytes_ - bytes); owner_->inputs -= bytes_ - bytes; }
      }
    }
    bytes_ = bytes;
  }
 private:
  std::shared_ptr<account> owner_;
  bool output_ = false;
  bool input_ = false;
  std::size_t bytes_ = 0U;
};

}  // namespace imagery_memory
}  // namespace frame
}  // namespace terra

#endif
