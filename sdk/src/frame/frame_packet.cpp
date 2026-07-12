#include <terra/frame/frame_packet.hpp>

#include <algorithm>
#include <cmath>

namespace terra {
namespace frame {
namespace {

template <typename range_t>
bool finite_values(const range_t& values) {
  for (const typename range_t::value_type value : values) {
    if (!std::isfinite(value)) {
      return false;
    }
  }
  return true;
}

bool valid_camera(const camera_snapshot& camera) {
  if (!std::isfinite(camera.distance) || camera.distance < 0.0 ||
      !std::isfinite(camera.near_plane) || camera.near_plane <= 0.0 ||
      !std::isfinite(camera.far_plane) ||
      camera.far_plane <= camera.near_plane ||
      !std::isfinite(camera.tilt_radians) ||
      !finite_values(camera.position) || !finite_values(camera.projection) ||
      !finite_values(camera.view) || !finite_values(camera.projection_view)) {
    return false;
  }
  for (const plane4d& plane : camera.clip_planes) {
    if (!finite_values(plane)) {
      return false;
    }
  }
  return true;
}

bool valid_patch(const lod_patch& patch) {
  if (patch.level >= 40U || !std::isfinite(patch.priority) ||
      patch.priority < 0.0F) {
    return false;
  }
  for (core::grid_value coordinate : patch.id) {
    if (coordinate < core::grid_coordinate_min ||
        coordinate > core::grid_coordinate_max) {
      return false;
    }
  }
  return true;
}

bool contains_patch(const std::vector<lod_patch>& decisions,
                    const lod_patch& patch) {
  return std::find_if(
             decisions.begin(), decisions.end(),
             [&patch](const lod_patch& decision) {
               return decision.level == patch.level &&
                      decision.id == patch.id;
             }) != decisions.end();
}

}  // namespace

frame_packet make_frame_packet(std::uint64_t sequence,
                               const camera_snapshot& camera,
                               const lod_cut& decisions) {
  frame_packet result;
  result.sequence = sequence;
  result.camera = camera;
  result.decisions_complete = decisions.complete;
  result.patch_decisions = decisions.patches;
  return result;
}

frame_packet_status validate_frame_packet(const frame_packet& packet) {
  if (!valid_camera(packet.camera)) {
    return frame_packet_status::invalid_camera;
  }
  for (const lod_patch& patch : packet.patch_decisions) {
    if (!valid_patch(patch)) {
      return frame_packet_status::invalid_patch_decision;
    }
  }
  for (const core::wmts_tile_key& tile : packet.texture_requests) {
    if (!tile.is_valid()) {
      return frame_packet_status::invalid_texture_tile;
    }
  }
  for (const terrain_mesh_packet& mesh : packet.meshes) {
    if (!valid_patch(mesh.patch)) {
      return frame_packet_status::invalid_patch_decision;
    }
    if (!contains_patch(packet.patch_decisions, mesh.patch)) {
      return frame_packet_status::missing_patch_decision;
    }
    if (mesh.fragment > 1U) {
      return frame_packet_status::invalid_fragment;
    }
    if (mesh.positions_xyz.empty() || mesh.positions_xyz.size() % 3U != 0U ||
        !finite_values(mesh.positions_xyz)) {
      return frame_packet_status::invalid_position_layout;
    }
    const std::size_t vertex_count = mesh.positions_xyz.size() / 3U;
    if (vertex_count > 65536U) {
      return frame_packet_status::invalid_index;
    }
    if (mesh.texture_uv.size() != vertex_count * 2U ||
        !finite_values(mesh.texture_uv)) {
      return frame_packet_status::invalid_texture_layout;
    }
    if (mesh.triangle_strip_indices.size() < 3U) {
      return frame_packet_status::invalid_index;
    }
    for (std::uint16_t index : mesh.triangle_strip_indices) {
      if (index >= vertex_count) {
        return frame_packet_status::invalid_index;
      }
    }
    if (!mesh.texture_tile.is_valid()) {
      return frame_packet_status::invalid_texture_tile;
    }
  }
  return frame_packet_status::ok;
}

const char* frame_packet_status_message(frame_packet_status status) {
  switch (status) {
    case frame_packet_status::ok:
      return "ok";
    case frame_packet_status::invalid_camera:
      return "invalid frame camera";
    case frame_packet_status::invalid_patch_decision:
      return "invalid patch decision";
    case frame_packet_status::missing_patch_decision:
      return "mesh patch is absent from frame decisions";
    case frame_packet_status::invalid_fragment:
      return "invalid terrain fragment";
    case frame_packet_status::invalid_position_layout:
      return "invalid position buffer";
    case frame_packet_status::invalid_texture_layout:
      return "invalid texture coordinate buffer";
    case frame_packet_status::invalid_index:
      return "invalid triangle strip index buffer";
    case frame_packet_status::invalid_texture_tile:
      return "invalid texture tile key";
  }
  return "unknown frame packet status";
}

}  // namespace frame
}  // namespace terra
