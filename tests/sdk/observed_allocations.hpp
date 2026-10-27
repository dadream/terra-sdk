#ifndef TERRA_TEST_OBSERVED_ALLOCATIONS_HPP
#define TERRA_TEST_OBSERVED_ALLOCATIONS_HPP

#include <cstddef>

namespace test_allocations {
extern bool measuring;
extern std::size_t live_bytes, peak_bytes, allocations, largest_allocation;
extern bool fail_next;
extern void (*before_free)(std::size_t);
}

#endif
