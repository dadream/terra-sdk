#ifndef TERRA_FRAME_FRAME_PACKET_HPP
#define TERRA_FRAME_FRAME_PACKET_HPP

#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>

#include <cstdint>
#include <vector>

namespace terra {
namespace frame {

struct terrain_mesh_packet {
  lod_patch patch;
  std::uint8_t fragment = 0U;
  std::vector<float> positions_xyz;
  std::vector<float> texture_uv;
  std::vector<std::uint16_t> triangle_strip_indices;
  core::wmts_tile_key texture_tile;
};

struct frame_packet {
  std::uint64_t sequence = 0U;
  camera_snapshot camera;
  bool decisions_complete = false;
  std::vector<lod_patch> patch_decisions;
  std::vector<core::wmts_tile_key> texture_requests;
  std::vector<terrain_mesh_packet> meshes;
};

enum class frame_packet_status {
  ok = 0,
  invalid_camera,
  invalid_patch_decision,
  missing_patch_decision,
  invalid_fragment,
  invalid_position_layout,
  invalid_texture_layout,
  invalid_index,
  invalid_texture_tile
};

frame_packet make_frame_packet(std::uint64_t sequence,
                               const camera_snapshot& camera,
                               const lod_cut& decisions);

frame_packet_status validate_frame_packet(const frame_packet& packet);

const char* frame_packet_status_message(frame_packet_status status);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_FRAME_PACKET_HPP
