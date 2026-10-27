#ifndef TERRA_TEST_MESH_OUTPUT_HPP
#define TERRA_TEST_MESH_OUTPUT_HPP

#include <terra/c_api/terra.h>
#include <stdexcept>
#include <vector>

// Test-only reconstruction for the existing independent frame hashes. The SDK
// exports immutable local mesh views; no concatenated payload is allocated there.
struct mesh_output {
  std::vector<terra_draw_range_v1> draws;
  std::vector<float> positions;
  std::vector<float> texture_uv;
};

inline mesh_output read_mesh_output(const terra_context* context) {
  std::size_t count = 0U;
  const auto sized = terra_get_mesh_resources(context, nullptr, 0U, &count);
  if (sized != TERRA_STATUS_OK && sized != TERRA_STATUS_BUFFER_TOO_SMALL)
    throw std::runtime_error("mesh descriptor sizing failed");
  std::vector<terra_mesh_resource_v3> resources(count);
  if (terra_get_mesh_resources(context, resources.data(), count, &count) != TERRA_STATUS_OK)
    throw std::runtime_error("mesh descriptor read failed");
  mesh_output result;
  for (const auto& resource : resources) {
    const float* positions = terra_get_mesh_position_view(context, resource.resource_id);
    const float* uv = terra_get_mesh_texture_view(context, resource.resource_id);
    if (!positions || !uv || resource.position_float_count != resource.draw.vertex_count * 3U ||
        resource.texture_float_count != resource.draw.vertex_count * 2U ||
        resource.draw.first_vertex * 3U != result.positions.size())
      throw std::runtime_error("invalid immutable mesh view");
    result.draws.push_back(resource.draw);
    result.positions.insert(result.positions.end(), positions, positions + resource.position_float_count);
    result.texture_uv.insert(result.texture_uv.end(), uv, uv + resource.texture_float_count);
  }
  return result;
}

#endif
