#include "observed_allocations.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdlib>
#include <limits>
#include <new>

// Observe actual new/delete payload, including vector/map capacity, without
// allocating a tracking container or counting the caller's unrelated fixtures.
namespace test_allocations {
bool measuring = false;
bool fail_next = false;
void (*before_free)(std::size_t) = nullptr;
std::size_t live_bytes = 0U, peak_bytes = 0U, allocations = 0U, largest_allocation = 0U;
struct alignas(std::max_align_t) allocation_header {std::size_t bytes; bool counted;};
}
using namespace test_allocations;

void* operator new(std::size_t size) {
  if(fail_next){fail_next=false;throw std::bad_alloc();}
  if (size > std::numeric_limits<std::size_t>::max() - sizeof(allocation_header)) throw std::bad_alloc();
  auto* header = static_cast<allocation_header*>(std::malloc(sizeof(allocation_header) + size));
  if (!header) throw std::bad_alloc();
  header->bytes = size; header->counted = measuring;
  if (measuring) {
    live_bytes += size; peak_bytes = std::max(peak_bytes, live_bytes); ++allocations;
    largest_allocation = std::max(largest_allocation, size);
  }
  return header + 1;
}
void operator delete(void* value) noexcept {
  if (!value) return;
  auto* header = static_cast<allocation_header*>(value) - 1;
  if (header->counted) { if(before_free)before_free(header->bytes); live_bytes -= header->bytes; }
  std::free(header);
}
void operator delete(void* value, std::size_t) noexcept { ::operator delete(value); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete[](void* value) noexcept { ::operator delete(value); }
void operator delete[](void* value, std::size_t) noexcept { ::operator delete(value); }
// Keep nothrow allocation observation explicit across standard libraries and
// sanitizer interceptors; do not rely on it forwarding to the throwing form.
void* operator new(std::size_t size,const std::nothrow_t&) noexcept {
  try{return ::operator new(size);}catch(...){return nullptr;}
}
void operator delete(void* value,const std::nothrow_t&) noexcept {::operator delete(value);}
void* operator new[](std::size_t size,const std::nothrow_t&) noexcept {
  try{return ::operator new[](size);}catch(...){return nullptr;}
}
void operator delete[](void* value,const std::nothrow_t&) noexcept {::operator delete[](value);}
