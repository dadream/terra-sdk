#ifndef TERRA_BENCH_COMPACT_REGIONS_HPP
#define TERRA_BENCH_COMPACT_REGIONS_HPP

#include <terra/c_api/terra.h>
#include <cstdint>

namespace terra_bench {
using region = terra_imagery_region_v4;
std::uint32_t region_work_bytes(std::uint32_t count);
region* copy_region_output(const region* input, std::uint32_t input_count,
    void* buffer, std::uint32_t first, std::uint32_t count);
std::uint32_t compact_regions(const region* input, std::uint32_t count, void* buffer);
}

#endif
