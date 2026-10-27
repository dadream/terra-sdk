#include <terra/frame/mesh.hpp>

#include <cstddef>
#include <limits>
#include <new>

namespace terra {
namespace frame {
mesh_index_status make_triangular_patch_strip_indices(
    std::uint32_t patch_dimension, std::vector<std::uint16_t>& output) {
  output.clear();
  if (patch_dimension == 0U) {
    return mesh_index_status::invalid_dimension;
  }
  const std::uint64_t vertex_count =
      (static_cast<std::uint64_t>(patch_dimension) + 1U) *
      (static_cast<std::uint64_t>(patch_dimension) + 2U) / 2U;
  if (vertex_count >
      static_cast<std::uint64_t>(
          std::numeric_limits<std::uint16_t>::max()) + 1U) {
    return mesh_index_status::index_limit;
  }
  // Each row is a strip of 2 * width + 1 indices. Three degenerate
  // connectors between rows preserve the clockwise CBDAM triangle winding.
  const std::uint64_t index_count =
      static_cast<std::uint64_t>(patch_dimension) * (patch_dimension + 5U) - 3U;
  if (index_count > std::numeric_limits<std::size_t>::max()) {
    return mesh_index_status::resource_limit;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    output.reserve(static_cast<std::size_t>(index_count));
    std::uint32_t current = 0U;
    for (std::uint32_t y = 0U; y < patch_dimension; ++y) {
      const std::uint32_t width = patch_dimension - y;
      const std::uint32_t next_row = current + width + 1U;
      const auto first = static_cast<std::uint16_t>(current + width);
      if (!output.empty()) {
        output.push_back(output.back());
        output.push_back(first);
        output.push_back(first);
      }
      // Traversing from right to left gives the same diagonal and orientation
      // as the desktop triangle list without a general-purpose stripifier.
      output.push_back(first);
      for (std::uint32_t x = width; x > 0U; --x) {
        output.push_back(static_cast<std::uint16_t>(next_row + x - 1U));
        output.push_back(static_cast<std::uint16_t>(current + x - 1U));
      }
      current = next_row;
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output.clear();
    return mesh_index_status::resource_limit;
  }
#endif
  if (output.size() != static_cast<std::size_t>(index_count)) {
    output.clear();
    return mesh_index_status::resource_limit;
  }
  return mesh_index_status::ok;
}

const char* mesh_index_status_message(mesh_index_status status) {
  switch (status) {
    case mesh_index_status::ok:
      return "ok";
    case mesh_index_status::invalid_dimension:
      return "invalid patch dimension";
    case mesh_index_status::index_limit:
      return "patch exceeds the 16-bit index limit";
    case mesh_index_status::resource_limit:
      return "unable to allocate patch indices";
  }
  return "unknown mesh index status";
}

}  // namespace frame
}  // namespace terra
