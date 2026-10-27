#include <terra/frame/mesh.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <set>
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

using triangle = std::array<std::uint16_t, 3>;

triangle oriented(triangle value) {
  // Cyclic rotations are equal; reversing an edge must remain distinguishable.
  std::rotate(value.begin(), std::min_element(value.begin(), value.end()), value.end());
  return value;
}

void verify_topology(std::uint32_t dimension) {
  std::vector<std::uint16_t> indices;
  require(terra::frame::make_triangular_patch_strip_indices(dimension, indices) ==
              terra::frame::mesh_index_status::ok, "valid patch dimension rejected");
  const auto vertex_count = (dimension + 1U) * (dimension + 2U) / 2U;
  // Independent CBDAM triangle-list oracle in lattice coordinates. This checks
  // diagonals, every boundary, duplicates and winding, not just a new hash/count.
  const auto vertex = [dimension](std::uint32_t x, std::uint32_t y) {
    return static_cast<std::uint16_t>(y * (2U * dimension + 3U - y) / 2U + x);
  };
  std::set<triangle> expected;
  for (std::uint32_t y = 0U; y < dimension; ++y) {
    for (std::uint32_t x = 0U; x + y < dimension; ++x) {
      expected.insert(oriented({{vertex(x, y), vertex(x + 1U, y), vertex(x, y + 1U)}}));
      if (x + y + 1U < dimension) {
        expected.insert(oriented({{vertex(x + 1U, y + 1U), vertex(x, y + 1U), vertex(x + 1U, y)}}));
      }
    }
  }
  require(expected.size() == dimension * dimension, "invalid triangle-list oracle");
  require(indices.size() <= dimension * dimension + 5U * dimension,
          "strip connectors scale with triangle count instead of row count");
  for (const auto index : indices) require(index < vertex_count, "strip index outside vertex buffer");
  for (std::size_t i = 2U; i < indices.size(); ++i) {
    triangle face{{indices[i - 2U], indices[i - 1U], indices[i]}};
    if (face[0] == face[1] || face[1] == face[2] || face[0] == face[2]) continue;
    if (i % 2U != 0U) std::swap(face[0], face[1]);
    require(expected.erase(oriented(face)) == 1U,
            "strip introduced a reversed, duplicate or non-CBDAM triangle");
  }
  require(expected.empty(), "strip lost terrain triangles or boundary coverage");
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
    require(terra::frame::make_triangular_patch_strip_indices(std::numeric_limits<std::uint32_t>::max(), indices) ==
                terra::frame::mesh_index_status::index_limit && indices.empty(),
            "oversized dimension produced an index buffer");
    for (const auto dimension : {1U, 2U, 3U, 4U, 7U, 16U, 63U, 64U, 65U, 128U, 255U, 360U}) {
      verify_topology(dimension);
    }
    require(terra::frame::make_triangular_patch_strip_indices(64U, indices) ==
                terra::frame::mesh_index_status::ok,
            "64x64 patch index generation failed");
    require(indices.size() == 4413U, "strip index count changed");
    require(*std::max_element(indices.begin(), indices.end()) == 2144U,
            "strip maximum vertex changed");

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
    require(index_hash == 3331821334U, "strip index hash changed");
    std::cout << "Triangular patch indices passed: count=" << indices.size()
              << ", fnv1a32=" << fnv1a32(indices) << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
