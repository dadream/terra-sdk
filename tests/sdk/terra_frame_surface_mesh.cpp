#include <terra/core/coordinate_transform.hpp>
#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace {

constexpr double radius = 6378000.0;
constexpr std::uint32_t patch_dimension = 64U;

void expect(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

terra::frame::camera_snapshot default_camera() {
  const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
  return terra::frame::globe_camera(
      static_cast<float>(radius), 1280, 720, y_fov).snapshot();
}

void verify_request_contract(const terra::frame::lod_cut& cut,
                             std::size_t root_count,
                             std::size_t detail_count) {
  std::size_t actual_roots = 0U;
  std::size_t actual_details = 0U;
  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    expect(request.patch.fragment_mask != 0U,
           "record request lost its fragment contract");
    if (request.kind == terra::frame::lod_record_kind::root) {
      ++actual_roots;
      expect(request.patch.level == 0U,
             "root record request must use a root patch");
    } else if (request.kind == terra::frame::lod_record_kind::detail) {
      ++actual_details;
    } else {
      throw std::runtime_error("unknown record request kind");
    }
  }
  expect(actual_roots == root_count, "root record request count changed");
  expect(actual_details == detail_count,
         "detail record request count changed");
}

void verify_surface(const terra::frame::lod_patch& patch,
                    std::uint8_t fragment,
                    const terra::core::global_geodetic_wmts_selector&
                        selector) {
  terra::frame::patch_surface_mesh mesh;
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, fragment, patch_dimension, radius, selector, mesh) ==
             terra::frame::surface_mesh_status::ok,
         "unable to build cylindrical patch surface");
  const std::size_t vertex_count =
      (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
  expect(mesh.patch.id == patch.id && mesh.fragment == fragment,
         "surface identity changed");
  expect(mesh.positions_xyz.size() == vertex_count * 3U,
         "surface position layout changed");
  expect(mesh.texture_uv.size() == vertex_count * 2U,
         "surface texture layout changed");
  expect(mesh.texture_tile.is_valid() && mesh.texture_tile.level == 1,
         "root fragment selected the wrong texture level");

  for (std::size_t vertex = 0U; vertex < vertex_count; ++vertex) {
    const std::size_t position = vertex * 3U;
    const std::size_t texture = vertex * 2U;
    const double x = mesh.origin[0] + mesh.positions_xyz[position];
    const double y = mesh.origin[1] + mesh.positions_xyz[position + 1U];
    const double z = mesh.origin[2] + mesh.positions_xyz[position + 2U];
    const double length = std::sqrt(x * x + y * y + z * z);
    expect(std::isfinite(length) && std::abs(length - radius) < 2.0,
           "surface vertex left the zero-height sphere");
    const float u = mesh.texture_uv[texture];
    const float v = mesh.texture_uv[texture + 1U];
    expect(std::isfinite(u) && std::isfinite(v) && u >= -0.0001F &&
               u <= 1.0001F && v >= -0.0001F && v <= 1.0001F,
           "surface texture coordinate is outside its tile");
  }
}

void verify_height_surface(
    const terra::frame::lod_patch& patch,
    const terra::core::global_geodetic_wmts_selector& selector) {
  terra::codec::height_fragment heights;
  heights.dimension = patch_dimension;
  const std::size_t vertex_count =
      (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
  heights.values.assign(vertex_count, 64);

  terra::frame::patch_surface_mesh mesh;
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, 0U, heights, 0.015625, radius, selector, mesh) ==
             terra::frame::surface_mesh_status::ok,
         "unable to build elevated cylindrical patch surface");
  for (std::size_t vertex = 0U; vertex < vertex_count; ++vertex) {
    const std::size_t position = vertex * 3U;
    const double x = mesh.origin[0] + mesh.positions_xyz[position];
    const double y = mesh.origin[1] + mesh.positions_xyz[position + 1U];
    const double z = mesh.origin[2] + mesh.positions_xyz[position + 2U];
    const double length = std::sqrt(x * x + y * y + z * z);
    expect(std::isfinite(length) && std::abs(length - (radius + 1.0)) < 2.0,
           "surface vertex ignored the decoded height");
  }

  heights.values.pop_back();
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, 0U, heights, 0.015625, radius, selector, mesh) ==
             terra::frame::surface_mesh_status::invalid_height,
         "surface accepted a malformed height fragment");
}

}  // namespace

int main() {
  const terra::frame::camera_snapshot camera = default_camera();
  const terra::core::global_geodetic_wmts_selector selector(0, 2);
  const terra::frame::lod_cut root_cut =
      terra::frame::select_procedural_cylindrical_lod(
          radius, patch_dimension, 0.01F, camera);
  expect(root_cut.complete && root_cut.patches.size() == 8U,
         "root LOD cut changed");
  verify_request_contract(root_cut, 8U, 0U);

  std::size_t surface_count = 0U;
  for (const terra::frame::lod_patch& patch : root_cut.patches) {
    expect(patch.fragment_mask != 0U, "root patch lost both fragments");
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (patch.has_fragment(fragment)) {
        verify_surface(patch, fragment, selector);
        ++surface_count;
      }
    }
  }
  expect(surface_count == 16U, "root surface fragment count changed");
  verify_height_surface(root_cut.patches.front(), selector);

  const terra::frame::lod_cut refined_cut =
      terra::frame::select_procedural_cylindrical_lod(
          radius, patch_dimension, 0.005F, camera);
  expect(refined_cut.complete && refined_cut.patches.size() == 28U,
         "refined LOD cut changed");
  verify_request_contract(refined_cut, 8U, 12U);

  terra::frame::patch_surface_mesh rejected;
  expect(terra::frame::make_cylindrical_patch_surface(
             root_cut.patches.front(), 0U, 257U, radius, selector,
             rejected) == terra::frame::surface_mesh_status::invalid_argument,
         "surface allocation limit changed");
  return 0;
}
