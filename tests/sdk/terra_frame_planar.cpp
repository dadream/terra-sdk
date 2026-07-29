#include <terra/core/grid.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

double clip_coordinate(const terra::frame::matrix4d& matrix,
                       std::size_t row,
                       const terra::core::vector3d& point) {
  return matrix[row * 4U] * point[0] +
         matrix[row * 4U + 1U] * point[1] +
         matrix[row * 4U + 2U] * point[2] +
         matrix[row * 4U + 3U];
}

void verify_cut(std::size_t level, std::size_t expected_patches,
                std::size_t expected_requests) {
  const terra::frame::lod_cut cut =
      terra::frame::select_fixed_planar_lod(64U, level);
  require(cut.complete, "fixed planar cut is incomplete");
  require(cut.graph_level_count == level + 1U,
          "fixed planar graph depth changed");
  if (cut.patches.size() != expected_patches ||
      cut.record_requests.size() != expected_requests) {
    std::cerr << "level " << level << ": patches=" << cut.patches.size()
              << ", requests=" << cut.record_requests.size() << '\n';
  }
  require(cut.patches.size() == expected_patches,
          "fixed planar leaf count changed");
  require(cut.record_requests.size() == expected_requests,
          "fixed planar request count changed");
  require(cut.leaf_count_by_level.at(level) == expected_patches,
          "fixed planar leaves moved to the wrong level");
  require(std::all_of(cut.patches.begin(), cut.patches.end(),
                      [level](const terra::frame::lod_patch& patch) {
                        return patch.level == level && patch.visible &&
                               patch.fragment_mask != 0U;
                      }),
          "fixed planar cut contains an invalid leaf");
  require(cut.record_requests.front().kind ==
              terra::frame::lod_record_kind::root &&
              cut.record_requests.front().patch.id ==
                  terra::core::planar_root().id(),
          "fixed planar root request changed");
}

void verify_camera(const terra::core::bounds2d& bounds) {
  const float fov = static_cast<float>(30.0 * (3.14 / 180.0));
  terra::frame::planar_camera camera(bounds, 640, 360, fov);
  require(camera.is_valid() && camera.initial_distance() > 0.0,
          "planar camera is invalid");
  const terra::frame::camera_snapshot initial = camera.snapshot();
  const terra::core::vector3d center{{512.5, 512.5, 0.0}};
  const double x = clip_coordinate(initial.projection_view, 0U, center);
  const double y = clip_coordinate(initial.projection_view, 1U, center);
  const double w = clip_coordinate(initial.projection_view, 3U, center);
  require(std::isfinite(w) && w != 0.0 && std::abs(x / w) < 0.000001 &&
              std::abs(y / w) < 0.000001,
          "planar camera does not center the dataset");
  require(camera.set_target(600.0, 400.0) &&
              camera.target_x() == 600.0 && camera.target_y() == 400.0,
          "planar camera target was not accepted");
  require(!camera.set_target(-1.0, 400.0) &&
              camera.target_x() == 600.0 && camera.target_y() == 400.0,
          "planar camera accepted an out-of-bounds target");
  const terra::frame::camera_snapshot targeted = camera.snapshot();
  require(targeted.projection_view != initial.projection_view,
          "planar camera target did not change the view");
  camera.set_tilt_radians(-0.7853981633974483);
  camera.rotate_yaw_radians(0.5235987755982988);
  const terra::frame::camera_snapshot tilted = camera.snapshot();
  require(tilted.position != initial.position &&
              std::all_of(tilted.projection_view.begin(),
                          tilted.projection_view.end(),
                          [](double value) { return std::isfinite(value); }),
          "planar camera tilt/yaw did not change a finite view");
  camera.reset();
  require(camera.target_x() == 512.5 && camera.target_y() == 512.5,
          "planar camera reset did not restore the target");
  require(camera.snapshot().projection_view == initial.projection_view,
          "planar camera reset is not deterministic");
}

void verify_surface(const terra::core::bounds2d& bounds) {
  const terra::frame::lod_cut cut =
      terra::frame::select_fixed_planar_lod(64U, 0U);
  const terra::frame::lod_patch& patch = cut.patches.front();
  terra::codec::height_fragment heights;
  heights.dimension = 64U;
  const std::size_t vertex_count = 65U * 66U / 2U;
  heights.values.assign(vertex_count, 1024);

  for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
    terra::frame::patch_surface_mesh mesh;
    require(terra::frame::make_planar_patch_surface(
                patch, fragment, heights, 0.0009765625, bounds, mesh) ==
                terra::frame::surface_mesh_status::ok,
            "unable to build planar height surface");
    require(mesh.texture_tile.level == 0 &&
                mesh.texture_tile.matrix == 0 &&
                mesh.texture_tile.row == 0 &&
                mesh.texture_tile.column == 0,
            "planar surface texture key changed");
    require(mesh.positions_xyz.size() == vertex_count * 3U &&
                mesh.texture_uv.size() == vertex_count * 2U,
            "planar surface buffer size changed");
    for (std::size_t vertex = 0U; vertex < vertex_count; ++vertex) {
      const float z = mesh.positions_xyz[vertex * 3U + 2U];
      const float u = mesh.texture_uv[vertex * 2U];
      const float v = mesh.texture_uv[vertex * 2U + 1U];
      require(std::abs(z - 1.0F) < 0.000001F,
              "planar surface ignored decoded height");
      require(u >= -0.0001F && u <= 1.0001F &&
                  v >= -0.0001F && v <= 1.0001F,
              "planar surface UV is outside the single texture");
    }
  }

  const terra::core::planar_tms_selector tiled_selector(
      bounds, 256U, 1, 1, 0, 2);
  const terra::frame::lod_cut tiled_cut =
      terra::frame::select_fixed_planar_lod(64U, 6U);
  std::array<bool, 4U> selected_columns{{false, false, false, false}};
  bool selected_detail_level = false;
  for (const terra::frame::lod_patch& tiled_patch : tiled_cut.patches) {
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!tiled_patch.has_fragment(fragment)) {
        continue;
      }
      terra::frame::patch_surface_mesh mesh;
      require(terra::frame::make_planar_patch_surface(
                  tiled_patch, fragment, 64U, bounds, tiled_selector, mesh) ==
                  terra::frame::surface_mesh_status::ok,
              "unable to build planar tiled surface");
      require(mesh.texture_tile.is_valid() &&
                  mesh.texture_tile.level <= 2 &&
                  mesh.texture_tile.matrix == mesh.texture_tile.level,
              "planar tiled surface selected an invalid texture key");
      selected_detail_level = selected_detail_level ||
                              mesh.texture_tile.level > 0;
      selected_columns.at(
          static_cast<std::size_t>(mesh.texture_tile.column)) = true;
      require(std::all_of(mesh.texture_uv.begin(), mesh.texture_uv.end(),
                          [](float value) {
                            return std::isfinite(value) && value >= -0.0001F &&
                                   value <= 1.0001F;
                          }),
              "planar tiled surface UV escaped its selected tile");
    }
  }
  require(selected_detail_level,
          "planar tiled surface never selected a detail texture level");
  require(std::count(selected_columns.begin(), selected_columns.end(), true) > 1,
          "planar tiled surface never selected multiple texture columns");
}

}  // namespace

int main() {
  try {
    const terra::core::grid_diamond root = terra::core::planar_root();
    require(root.planar_child_diamond(0U, 0U).id() ==
                root.child_id(0U, 0U) &&
                root.planar_child_diamond(1U, 1U).id() ==
                    root.child_id(1U, 1U),
            "planar child diamond no longer matches the legacy child ID");
    verify_cut(0U, 1U, 1U);
    verify_cut(1U, 4U, 2U);
    verify_cut(2U, 4U, 6U);
    require(!terra::frame::select_fixed_planar_lod(0U, 0U).complete &&
                !terra::frame::select_fixed_planar_lod(
                     64U, 4U, 4U).complete,
            "invalid fixed planar cut was accepted");
    const terra::core::bounds2d bounds(
        terra::core::vector2d{{0.0, 0.0}},
        terra::core::vector2d{{1025.0, 1025.0}});
    verify_camera(bounds);
    verify_surface(bounds);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
