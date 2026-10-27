#ifndef TERRA_FRAME_SURFACE_MESH_HPP
#define TERRA_FRAME_SURFACE_MESH_HPP

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/types.hpp>
#include <terra/imagery/model.hpp>
#include <terra/frame/lod.hpp>

#include <cstdint>
#include <vector>

namespace terra {
namespace frame {

enum class surface_mesh_status {
  ok = 0,
  invalid_argument,
  invalid_fragment,
  invalid_height,
  invalid_texture,
  resource_limit
};

struct patch_surface_mesh {
  lod_patch patch;
  std::uint8_t fragment = 0U;
  core::vector3d origin{{0.0, 0.0, 0.0}};
  imagery::node_key texture_node;
  std::vector<float> positions_xyz;
  std::vector<float> texture_uv;
};

// A regular cylindrical CBDAM fragment has one of eight exact UV layouts.
// Identity includes dimension; heights, camera and geographic position do not.
// Irregular lattice sampling must keep its own UV resource instead.
struct texture_grid_pattern {
  std::uint32_t dimension = 0U;
  std::uint32_t orientation = 0U;
  bool sample(std::uint32_t first_vertex, std::uint32_t vertex_count,
              float* output) const;
};

bool describe_cylindrical_texture_pattern(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    texture_grid_pattern& pattern);

// Metadata-only preparation. Does not allocate position/UV payloads.
surface_mesh_status describe_patch_surface(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    bool cylindrical, double radius, const core::bounds2d& bounds,
    patch_surface_mesh& output);

constexpr std::uint32_t maximum_surface_sample_vertices = 1024U;
// Exact full-mesh positions from an immutable height input, with no payload
// allocation. Writes 3 * vertex_count floats relative to the described origin.
// The requested height slice is validated before any output is written.
surface_mesh_status sample_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    bool cylindrical, double radius, const core::bounds2d& bounds,
    std::uint32_t first_vertex, std::uint32_t vertex_count, float* output);

// Exact full-mesh UV arithmetic, without heights or position/UV allocation.
// Writes 2 * vertex_count floats in triangular row order; invalid input leaves
// output untouched. Zero count accepts null output at any valid start position.
surface_mesh_status sample_patch_texture_coordinates(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    bool cylindrical, const core::bounds2d& bounds,
    std::uint32_t first_vertex, std::uint32_t vertex_count, float* output);

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, double radius,
    patch_surface_mesh& output);

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius,
    patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, const core::bounds2d& bounds,
    patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output);

// Position production for owners of a separate immutable UV resource. These
// use the same vertex arithmetic as full surfaces and allocate no UV payload.
surface_mesh_status make_cylindrical_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius, patch_surface_mesh& output);
surface_mesh_status make_planar_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output);

// Same Float32 vertex arithmetic as a full mesh, evaluated on its three edges.
surface_mesh_status make_cylindrical_patch_boundary(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius, patch_surface_mesh& output);
surface_mesh_status make_planar_patch_boundary(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output);

const char* surface_mesh_status_message(surface_mesh_status status);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_SURFACE_MESH_HPP
