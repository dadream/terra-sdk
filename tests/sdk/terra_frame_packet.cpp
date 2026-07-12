#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/frame_packet.hpp>
#include <terra/frame/lod.hpp>

#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

namespace {

void require_status(const terra::frame::frame_packet& packet,
                    terra::frame::frame_packet_status expected) {
  const terra::frame::frame_packet_status actual =
      terra::frame::validate_frame_packet(packet);
  if (actual != expected) {
    throw std::runtime_error(
        std::string("frame packet status mismatch: expected ") +
        terra::frame::frame_packet_status_message(expected) + ", got " +
        terra::frame::frame_packet_status_message(actual));
  }
}

}  // namespace

int main() {
  try {
    const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
    const terra::frame::globe_camera camera(
        static_cast<float>(6378000.0), 1280, 720, y_fov);
    const terra::frame::camera_snapshot snapshot = camera.snapshot();
    const terra::frame::lod_cut decisions =
        terra::frame::select_procedural_cylindrical_lod(
            6378000.0, 64U, 0.01F, snapshot);
    terra::frame::frame_packet packet =
        terra::frame::make_frame_packet(7U, snapshot, decisions);
    if (!packet.decisions_complete || packet.sequence != 7U ||
        packet.patch_decisions.size() != 8U) {
      throw std::runtime_error("frame decision packet changed");
    }

    const terra::core::global_geodetic_wmts_selector selector(1U, 17U);
    const terra::core::wmts_tile_key tile = selector.select(
        terra::core::bounds2d(terra::core::vector2d{{-180.0, -90.0}},
                              terra::core::vector2d{{0.0, 90.0}}),
        256U);
    packet.texture_requests.push_back(tile);
    terra::frame::terrain_mesh_packet mesh;
    mesh.patch = packet.patch_decisions.front();
    mesh.positions_xyz = {0.0F, 0.0F, 0.0F, 1.0F, 0.0F,
                          0.0F, 0.0F, 1.0F, 0.0F};
    mesh.texture_uv = {0.0F, 0.0F, 1.0F, 0.0F, 0.0F, 1.0F};
    mesh.triangle_strip_indices = {0U, 1U, 2U};
    mesh.texture_tile = tile;
    packet.meshes.push_back(mesh);
    require_status(packet, terra::frame::frame_packet_status::ok);

    terra::frame::frame_packet empty_packet;
    require_status(empty_packet,
                   terra::frame::frame_packet_status::invalid_camera);
    packet.meshes[0].patch.id[0] += 1;
    require_status(
        packet, terra::frame::frame_packet_status::missing_patch_decision);
    packet.meshes[0].patch = packet.patch_decisions.front();
    packet.patch_decisions[0].priority =
        std::numeric_limits<float>::quiet_NaN();
    require_status(
        packet, terra::frame::frame_packet_status::invalid_patch_decision);
    packet.patch_decisions[0] = mesh.patch;

    packet.meshes[0].fragment = 2U;
    require_status(packet,
                   terra::frame::frame_packet_status::invalid_fragment);
    packet.meshes[0].fragment = 0U;
    packet.meshes[0].triangle_strip_indices[2] = 3U;
    require_status(packet, terra::frame::frame_packet_status::invalid_index);
    packet.meshes[0].triangle_strip_indices[2] = 2U;
    packet.meshes[0].positions_xyz[0] =
        std::numeric_limits<float>::quiet_NaN();
    require_status(
        packet, terra::frame::frame_packet_status::invalid_position_layout);

    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
