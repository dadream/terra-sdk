#ifndef TERRA_FRAME_SURFACE_MESH_HPP
#define TERRA_FRAME_SURFACE_MESH_HPP

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/types.hpp>
#include <terra/core/wmts.hpp>
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
  core::wmts_tile_key texture_tile;
  std::vector<float> positions_xyz;
  std::vector<float> texture_uv;
};

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, double radius,
    const core::global_geodetic_wmts_selector& texture_selector,
    patch_surface_mesh& output);

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius,
    const core::global_geodetic_wmts_selector& texture_selector,
    patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, const core::bounds2d& bounds,
    patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, const core::bounds2d& bounds,
    const core::planar_tms_selector& texture_selector,
    patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output);

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds,
    const core::planar_tms_selector& texture_selector,
    patch_surface_mesh& output);

const char* surface_mesh_status_message(surface_mesh_status status);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_SURFACE_MESH_HPP
