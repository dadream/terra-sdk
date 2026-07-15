#include <terra/frame/mesh.hpp>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::uint32_t fnv1a32(const std::vector<std::uint16_t>& values) {
  std::uint32_t hash = 2166136261U;
  for (const std::uint16_t value : values) {
    hash ^= static_cast<std::uint8_t>(value & 0xffU);
    hash *= 16777619U;
    hash ^= static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    hash *= 16777619U;
  }
  return hash;
}

}  // namespace

int main() {
  try {
    std::vector<std::uint16_t> indices;
    require(terra::frame::make_triangular_patch_strip_indices(0U, indices) ==
                terra::frame::mesh_index_status::invalid_dimension,
            "zero patch dimension was accepted");
    require(terra::frame::make_triangular_patch_strip_indices(361U, indices) ==
                terra::frame::mesh_index_status::index_limit,
            "16-bit vertex limit was not enforced");
    require(terra::frame::make_triangular_patch_strip_indices(64U, indices) ==
                terra::frame::mesh_index_status::ok,
            "64x64 patch index generation failed");
    require(indices.size() == 24573U, "strip index count changed");
    require(*std::max_element(indices.begin(), indices.end()) == 2144U,
            "strip maximum vertex changed");
    require(indices[0] == 0U && indices[1] == 1U && indices[2] == 65U,
            "first source triangle changed");
    require(indices[6] == 66U && indices[7] == 65U && indices[8] == 1U,
            "second source triangle changed");

    std::size_t nondegenerate = 0U;
    for (std::size_t index = 2U; index < indices.size(); ++index) {
      const std::uint16_t a = indices[index - 2U];
      const std::uint16_t b = indices[index - 1U];
      const std::uint16_t c = indices[index];
      if (a != b && b != c && a != c) {
        ++nondegenerate;
      }
    }
    require(nondegenerate == 4096U,
            "strip nondegenerate triangle count changed");
    const std::uint32_t index_hash = fnv1a32(indices);
    require(index_hash == 2327969341U, "strip index hash changed");
    std::cout << "Triangular patch indices passed: count=" << indices.size()
              << ", fnv1a32=" << fnv1a32(indices) << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
