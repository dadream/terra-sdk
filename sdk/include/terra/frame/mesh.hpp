#ifndef TERRA_FRAME_MESH_HPP
#define TERRA_FRAME_MESH_HPP

#include <cstdint>
#include <vector>

namespace terra {
namespace frame {

enum class mesh_index_status {
  ok = 0,
  invalid_dimension,
  index_limit,
  resource_limit
};

mesh_index_status make_triangular_patch_strip_indices(
    std::uint32_t patch_dimension, std::vector<std::uint16_t>& output);

const char* mesh_index_status_message(mesh_index_status status);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_MESH_HPP
