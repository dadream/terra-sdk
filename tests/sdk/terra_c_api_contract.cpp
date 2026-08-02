#include <terra/c_api/terra.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void require_status(terra_status actual, terra_status expected,
                    const char* operation) {
  if (actual != expected) {
    throw std::runtime_error(std::string(operation) + " returned status " +
                             std::to_string(actual) + ", expected " +
                             std::to_string(expected));
  }
}

std::vector<std::uint8_t> read_binary(const char* path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("unable to open patch fixture");
  }
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "patch fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read patch fixture");
  return result;
}

terra_manifest_v1 globe_manifest() {
  terra_manifest_v1 manifest{};
  manifest.struct_size = sizeof(manifest);
  manifest.api_version = TERRA_C_API_VERSION;
  manifest.format_version = 1U;
  manifest.patch_dimension = 64U;
  manifest.transform = TERRA_TRANSFORM_CYLINDRICAL;
  manifest.height_scale_factor = 0.001953125;
  manifest.minimum_u = -180.0;
  manifest.minimum_v = -90.0;
  manifest.maximum_u = 180.0;
  manifest.maximum_v = 90.0;
  manifest.radius = 6378000.0;
  manifest.texture_matrix_level_offset = 0U;
  manifest.texture_maximum_level = 8U;
  return manifest;
}

terra_viewport_v1 default_viewport() {
  terra_viewport_v1 viewport{};
  viewport.struct_size = sizeof(viewport);
  viewport.width = 1280U;
  viewport.height = 720U;
  viewport.vertical_fov_radians = 30.0 * (3.14 / 180.0);
  return viewport;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr << "usage: terra_c_api_contract ROOT0 DETAIL0 ROOT3 DETAIL3 CHILD_DETAIL\n";
    return 2;
  }
  try {
    require(terra_abi_version() == TERRA_C_API_VERSION,
            "ABI version changed");
    require(terra_sizeof_manifest_v1() == sizeof(terra_manifest_v1) &&
                terra_sizeof_viewport_v1() == sizeof(terra_viewport_v1) &&
                terra_sizeof_camera_v1() == sizeof(terra_camera_v1) &&
                terra_sizeof_patch_key_v1() == sizeof(terra_patch_key_v1) &&
                terra_sizeof_texture_key_v1() ==
                    sizeof(terra_texture_key_v1) &&
                terra_sizeof_request_v1() == sizeof(terra_request_v1) &&
                terra_sizeof_patch_decision_v1() ==
                    sizeof(terra_patch_decision_v1) &&
                terra_sizeof_draw_range_v1() ==
                    sizeof(terra_draw_range_v1) &&
                terra_sizeof_frame_v1() == sizeof(terra_frame_v1) &&
                terra_sizeof_stats_v1() == sizeof(terra_stats_v1),
            "ABI size query changed");

    terra_context* context = terra_create();
    require(context != nullptr, "terra_create failed");

    require_status(terra_set_globe_target(context, 0.0, 0.0),
                   TERRA_STATUS_INVALID_STATE,
                   "globe target before manifest");

    require_status(terra_update(context, 0.0025F),
                   TERRA_STATUS_INVALID_STATE,
                   "update before configuration");
    std::size_t error_size = 0U;
    require_status(terra_get_last_error(context, nullptr, 0U, &error_size),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "last error sizing");
    std::vector<char> error(error_size);
    require_status(terra_get_last_error(context, error.data(), error.size(),
                                        &error_size),
                   TERRA_STATUS_OK, "last error read");
    require(std::string(error.data()).find("manifest and viewport") !=
                std::string::npos,
            "last error detail changed");

    terra_manifest_v1 legacy_manifest = globe_manifest();
    legacy_manifest.struct_size =
        offsetof(terra_manifest_v1, texture_matrix_level_offset);
    legacy_manifest.texture_matrix_level_offset = 0xffffffffU;
    legacy_manifest.texture_maximum_level = 0xffffffffU;
    require_status(terra_load_manifest(context, &legacy_manifest),
                   TERRA_STATUS_OK, "load base-size v1 manifest");
    terra_viewport_v1 legacy_viewport = default_viewport();
    require_status(terra_set_viewport(context, &legacy_viewport),
                   TERRA_STATUS_OK, "set legacy viewport");
    require_status(terra_update(context, 0.01F), TERRA_STATUS_OK,
                   "update legacy frame");
    terra_frame_v1 legacy_frame{};
    legacy_frame.struct_size = offsetof(terra_frame_v1, draw_count);
    legacy_frame.draw_count = 0x11111111U;
    legacy_frame.vertex_count = 0x22222222U;
    legacy_frame.position_float_count = 0x33333333U;
    legacy_frame.texture_float_count = 0x44444444U;
    require_status(terra_get_frame(context, &legacy_frame), TERRA_STATUS_OK,
                   "get base-size v1 frame");
    require(legacy_frame.sequence == 1U &&
                legacy_frame.draw_count == 0x11111111U &&
                legacy_frame.vertex_count == 0x22222222U &&
                legacy_frame.position_float_count == 0x33333333U &&
                legacy_frame.texture_float_count == 0x44444444U,
            "v1 tail compatibility changed");

    terra_manifest_v1 manifest = globe_manifest();
    require_status(terra_load_manifest(context, &manifest), TERRA_STATUS_OK,
                   "load manifest");
    terra_viewport_v1 viewport = default_viewport();
    require_status(terra_set_viewport(context, &viewport), TERRA_STATUS_OK,
                   "set viewport");
    require_status(terra_update(context, 0.005F), TERRA_STATUS_OK,
                   "initial update");

    terra_frame_v1 frame{};
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get frame");
    require(frame.sequence == 1U && frame.decisions_complete == 1U &&
                frame.patch_count == 8U && frame.request_count == 20U &&
                frame.loaded_patch_count == 0U && frame.draw_count == 0U &&
                frame.expected_draw_count > 0U &&
                frame.omitted_draw_count == frame.expected_draw_count &&
                frame.coverage_draw_count == 0U &&
                frame.coverage_complete == 0U,
            "initial frame counts changed");
    require(std::isfinite(frame.camera_position[0]) &&
                std::isfinite(frame.camera_position[1]) &&
                std::isfinite(frame.camera_position[2]),
            "camera position is invalid");

    std::size_t index_count = 0U;
    require_status(terra_get_index_buffer(context, nullptr, 0U,
                                          &index_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "index sizing");
    require(index_count == 24573U, "index sizing count changed");
    std::vector<std::uint16_t> indices(index_count);
    require_status(terra_get_index_buffer(context, indices.data(),
                                          indices.size(), &index_count),
                   TERRA_STATUS_OK, "get index buffer");
    require(*std::max_element(indices.begin(), indices.end()) == 2144U,
            "index vertex range changed");
    std::size_t nondegenerate = 0U;
    for (std::size_t index = 2U; index < indices.size(); ++index) {
      const std::uint16_t a = indices[index - 2U];
      const std::uint16_t b = indices[index - 1U];
      const std::uint16_t c = indices[index];
      if (a != b && b != c && a != c) {
        ++nondegenerate;
      }
    }
    require(nondegenerate == 4096U,
            "index triangle topology changed");

    std::size_t patch_count = 0U;
    require_status(terra_get_frame_patches(context, nullptr, 0U,
                                           &patch_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "patch sizing");
    require(patch_count == 8U, "patch sizing count changed");
    std::vector<terra_patch_decision_v1> patches(patch_count);
    require_status(terra_get_frame_patches(context, patches.data(),
                                           patches.size(), &patch_count),
                   TERRA_STATUS_OK, "get patches");
    require(patches.front().key.level == 0U &&
                patches.front().key.i == 0 &&
                patches.front().key.j == 134217728 &&
                patches.front().key.k == 134217728 &&
                patches.front().visible == 1U &&
                patches.back().key.level == 0U &&
                patches.back().key.i == 0 &&
                patches.back().key.j == -134217728 &&
                patches.back().key.k == -134217728 &&
                patches.back().visible == 1U,
            "frame patch IDs changed");

    require_status(terra_update(context, 0.0025F), TERRA_STATUS_OK,
                   "select hierarchy verification cut");

    std::size_t request_count = 0U;
    require_status(terra_get_requests(context, nullptr, 0U, &request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "request sizing");
    require(request_count == 38U, "record request count changed");
    std::vector<terra_request_v1> requests(request_count);
    require_status(terra_get_requests(context, requests.data(),
                                      requests.size(), &request_count),
                   TERRA_STATUS_OK, "get requests");
    std::size_t root_requests = 0U;
    std::size_t detail_requests = 0U;
    const terra_request_v1* root0 = nullptr;
    const terra_request_v1* root0_detail = nullptr;
    const terra_request_v1* root3 = nullptr;
    const terra_request_v1* root3_detail = nullptr;
    const terra_request_v1* child_detail = nullptr;
    for (const terra_request_v1& request : requests) {
      root_requests += request.kind == TERRA_REQUEST_ROOT ? 1U : 0U;
      detail_requests += request.kind == TERRA_REQUEST_DETAIL ? 1U : 0U;
      if (request.key.level == 0U && request.key.i == 0 &&
          request.key.j == 134217728 && request.key.k == 134217728) {
        if (request.kind == TERRA_REQUEST_ROOT) {
          root0 = &request;
        } else if (request.kind == TERRA_REQUEST_DETAIL) {
          root0_detail = &request;
        }
      } else if (request.key.level == 0U &&
                 request.key.i == -134217728 &&
                 request.key.j == 134217728 && request.key.k == 0) {
        if (request.kind == TERRA_REQUEST_ROOT) {
          root3 = &request;
        } else if (request.kind == TERRA_REQUEST_DETAIL) {
          root3_detail = &request;
        }
      } else if (request.kind == TERRA_REQUEST_DETAIL &&
                 request.key.level == 1U &&
                 request.key.i == -134217728 &&
                 request.key.j == 134217728 &&
                 request.key.k == 134217728) {
        child_detail = &request;
      }
    }
    require(root_requests == 8U && detail_requests == 30U &&
                root0 != nullptr && root0_detail != nullptr &&
                root3 != nullptr && root3_detail != nullptr &&
                child_detail != nullptr,
            "root/detail request contract changed");

    const std::vector<std::uint8_t> root_record = read_binary(argv[1]);
    require_status(terra_submit_patch(
                       context, &root0->key,
                       root_record.data(), root_record.size()),
                   TERRA_STATUS_OK, "submit root through compatibility API");

    const std::vector<std::uint8_t> detail0_record = read_binary(argv[2]);
    const std::vector<std::uint8_t> root3_record = read_binary(argv[3]);
    const std::vector<std::uint8_t> detail3_record = read_binary(argv[4]);
    const std::vector<std::uint8_t> child_record = read_binary(argv[5]);
    require_status(terra_submit_patch(
                       context, &root0_detail->key,
                       detail0_record.data(), detail0_record.size()),
                   TERRA_STATUS_OK,
                   "submit detail through compatibility API");
    require_status(terra_submit_record(
                       context, root3->kind, &root3->key,
                       root3_record.data(), root3_record.size()),
                   TERRA_STATUS_OK, "submit root three record");
    require_status(terra_submit_record(
                       context, root3_detail->kind, &root3_detail->key,
                       detail3_record.data(), detail3_record.size()),
                   TERRA_STATUS_OK, "submit root three detail");
    require_status(terra_submit_record(
                       context, child_detail->kind, &child_detail->key,
                       child_record.data(), child_record.size()),
                   TERRA_STATUS_OK, "submit shared child detail");
    require_status(terra_update(context, 0.0025F), TERRA_STATUS_OK,
                   "update after hierarchy chain");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get drawable frame");
    require(frame.sequence == 3U && frame.patch_count == 16U &&
                frame.request_count == 33U &&
                frame.loaded_patch_count == 5U && frame.draw_count > 0U,
            "drawable hierarchy state changed");

    std::size_t draw_count = 0U;
    require_status(terra_get_draw_ranges(context, nullptr, 0U, &draw_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "draw range sizing");
    std::vector<terra_draw_range_v1> draws(draw_count);
    require_status(terra_get_draw_ranges(
                       context, draws.data(), draws.size(), &draw_count),
                   TERRA_STATUS_OK, "get draw ranges");
    std::size_t position_count = 0U;
    require_status(terra_get_position_buffer(
                       context, nullptr, 0U, &position_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "position sizing");
    std::vector<float> positions(position_count);
    require_status(terra_get_position_buffer(
                       context, positions.data(), positions.size(),
                       &position_count),
                   TERRA_STATUS_OK, "get positions");
    std::size_t texture_count = 0U;
    require_status(terra_get_texture_uv_buffer(
                       context, nullptr, 0U, &texture_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "texture sizing");
    std::vector<float> texture_uv(texture_count);
    require_status(terra_get_texture_uv_buffer(
                       context, texture_uv.data(), texture_uv.size(),
                       &texture_count),
                   TERRA_STATUS_OK, "get texture coordinates");
    const std::size_t coverage_draw_count =
        static_cast<std::size_t>(std::count_if(
            draws.begin(), draws.end(), [](const terra_draw_range_v1& draw) {
              return draw.flags == TERRA_DRAW_FLAG_COVERAGE;
            }));
    require(draw_count == frame.draw_count &&
                coverage_draw_count == frame.coverage_draw_count &&
                frame.draw_count >= frame.coverage_draw_count &&
                frame.expected_draw_count ==
                    frame.draw_count - frame.coverage_draw_count +
                        frame.omitted_draw_count &&
                position_count == frame.position_float_count &&
                texture_count == frame.texture_float_count &&
                position_count == frame.vertex_count * 3U &&
                texture_count == frame.vertex_count * 2U,
            "frame draw buffer counts disagree");
    for (const terra_draw_range_v1& draw : draws) {
      require(draw.struct_size == sizeof(draw) && draw.fragment < 2U &&
                  draw.vertex_count == 2145U &&
                  draw.first_vertex + draw.vertex_count <=
                      frame.vertex_count &&
                  draw.first_index == 0U &&
                  draw.index_count == index_count &&
                  draw.texture.level <= 8U &&
                  draw.texture.matrix ==
                      static_cast<std::int32_t>(draw.texture.level) &&
                  draw.texture.row >= 0 && draw.texture.column >= 0 &&
                  (draw.flags == TERRA_DRAW_FLAG_NONE ||
                   draw.flags == TERRA_DRAW_FLAG_COVERAGE) &&
                  std::isfinite(draw.origin[0]) &&
                  std::isfinite(draw.origin[1]) &&
                  std::isfinite(draw.origin[2]),
              "draw range contract changed");
    }
    require(std::all_of(positions.begin(), positions.end(),
                        [](float value) { return std::isfinite(value); }),
            "position buffer contains a non-finite value");
    require(std::all_of(texture_uv.begin(), texture_uv.end(),
                        [](float value) {
                          return std::isfinite(value) &&
                                 value >= -0.0001F && value <= 1.0001F;
                        }),
            "texture buffer contains an invalid coordinate");

    require_status(terra_fail_record(
                       context, requests.back().kind,
                       &requests.back().key),
                   TERRA_STATUS_OK, "fail terrain record");
    const std::uint8_t malformed[] = {0U};
    require_status(terra_submit_record(
                       context, requests.back().kind,
                       &requests.back().key, malformed, sizeof(malformed)),
                   TERRA_STATUS_DECODE_ERROR, "malformed terrain record");

    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_status(terra_get_stats(context, &stats), TERRA_STATUS_OK,
                   "get stats");
    require(stats.update_count == 3U && stats.loaded_patch_count == 5U &&
                stats.failed_patch_count == 1U &&
                stats.decoded_value_count == 20738U &&
                stats.current_patch_count == 16U &&
                stats.current_request_count == 33U &&
                stats.last_sequence == 3U,
            "ABI statistics changed");

    terra_camera_v1 camera{};
    camera.struct_size = sizeof(camera);
    camera.distance = 20000000.0;
    camera.tilt_radians = 0.7853981633974483;
    camera.yaw_radians = 0.5235987755982988;
    require_status(terra_set_globe_target(context, 181.0, 0.0),
                   TERRA_STATUS_INVALID_ARGUMENT, "invalid globe target");
    require_status(terra_set_globe_target(context, 116.4074, 39.9042),
                   TERRA_STATUS_OK, "set globe target");
    require_status(terra_set_camera(context, &camera), TERRA_STATUS_OK,
                   "set camera");
    require_status(terra_update(context, 0.005F), TERRA_STATUS_OK,
                   "camera update");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get camera frame");
    require(frame.sequence == 4U && frame.decisions_complete == 1U,
            "camera frame state changed");

    terra_destroy(context);
    void* memory = terra_alloc(64U);
    require(memory != nullptr, "terra_alloc failed");
    terra_free(memory);
    std::cout << "Terra C ABI contract passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
