#include <terra/c_api/terra.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void require_ok(terra_status status, const char* operation) {
  if (status != TERRA_STATUS_OK) {
    throw std::runtime_error(std::string(operation) + " failed: " +
                             std::to_string(status));
  }
}

std::vector<std::uint8_t> read_binary(const char* path) {
  std::ifstream input(path, std::ios::binary);
  require(static_cast<bool>(input), "unable to open planar fixture");
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "planar fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read planar fixture");
  return result;
}

std::uint32_t fnv1a32(const void* data, std::size_t size) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  std::uint32_t hash = 2166136261U;
  for (std::size_t index = 0U; index < size; ++index) {
    hash ^= bytes[index];
    hash *= 16777619U;
  }
  return hash;
}

template <typename value_t>
std::vector<value_t> copy_vector(
    terra_context* context,
    terra_status (*getter)(const terra_context*, value_t*, std::size_t,
                           std::size_t*),
    const char* operation) {
  std::size_t count = 0U;
  require(getter(context, nullptr, 0U, &count) ==
              TERRA_STATUS_BUFFER_TOO_SMALL,
          "vector sizing did not report buffer-too-small");
  std::vector<value_t> result(count);
  require_ok(getter(context, result.data(), result.size(), &count), operation);
  require(count == result.size(), "vector count changed while copying");
  return result;
}

terra_manifest_v1 planar_manifest() {
  terra_manifest_v1 manifest{};
  manifest.struct_size = sizeof(manifest);
  manifest.api_version = TERRA_C_API_VERSION;
  manifest.format_version = 1U;
  manifest.patch_dimension = 64U;
  manifest.transform = TERRA_TRANSFORM_PLANAR;
  manifest.height_scale_factor = 0.0000976563;
  manifest.minimum_u = 0.0;
  manifest.minimum_v = 0.0;
  manifest.maximum_u = 1025.0;
  manifest.maximum_v = 1025.0;
  manifest.radius = 0.0;
  manifest.texture_matrix_level_offset = 0U;
  manifest.texture_maximum_level = 0U;
  manifest.texture_tile_size = 256U;
  manifest.texture_level_zero_columns = 1U;
  manifest.texture_level_zero_rows = 1U;
  manifest.texture_minimum_level = 0U;
  manifest.texture_minimum_u = 0.0;
  manifest.texture_minimum_v = 0.0;
  manifest.texture_maximum_u = 1025.0;
  manifest.texture_maximum_v = 1025.0;
  return manifest;
}

const terra_request_v1* find_request(
    const std::vector<terra_request_v1>& requests, std::uint32_t kind) {
  const auto found = std::find_if(
      requests.begin(), requests.end(),
      [kind](const terra_request_v1& request) {
        return request.kind == kind && request.key.level == 0U &&
               request.key.i == 0 && request.key.j == 0 &&
               request.key.k == 268435456;
      });
  return found == requests.end() ? nullptr : &*found;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: terra_c_api_planar ROOT ROOT_DETAIL\n";
    return 2;
  }
  try {
    std::unique_ptr<terra_context, void (*)(terra_context*)> context(
        terra_create(), terra_destroy);
    require(context != nullptr, "terra_create failed");
    require(terra_set_planar_level(context.get(), 1U) ==
                TERRA_STATUS_INVALID_STATE,
            "planar level was accepted before manifest");
    require(terra_set_planar_target(context.get(), 512.5, 512.5) ==
                TERRA_STATUS_INVALID_STATE,
            "planar target was accepted before manifest");

    terra_manifest_v1 manifest = planar_manifest();
    require_ok(terra_load_manifest(context.get(), &manifest),
               "terra_load_manifest planar");
    require_ok(terra_set_planar_level(context.get(), 1U),
               "terra_set_planar_level");
    require(terra_set_planar_level(context.get(), 12U) ==
                TERRA_STATUS_INVALID_ARGUMENT,
            "out-of-range planar level was accepted");
    require(terra_set_planar_target(context.get(), -1.0, 512.5) ==
                TERRA_STATUS_INVALID_ARGUMENT,
            "out-of-range planar target was accepted");
    require_ok(terra_set_planar_target(context.get(), 600.0, 400.0),
               "terra_set_planar_target");

    terra_viewport_v1 viewport{};
    viewport.struct_size = sizeof(viewport);
    viewport.width = 640U;
    viewport.height = 360U;
    viewport.vertical_fov_radians = 30.0 * (3.14 / 180.0);
    require_ok(terra_set_viewport(context.get(), &viewport),
               "terra_set_viewport planar");
    require_ok(terra_update(context.get(), 0.005F),
               "terra_update planar initial");

    terra_frame_v1 initial{};
    initial.struct_size = sizeof(initial);
    require_ok(terra_get_frame(context.get(), &initial),
               "terra_get_frame planar initial");
    require(initial.sequence == 1U && initial.patch_count == 4U &&
                initial.request_count == 2U && initial.draw_count == 0U,
            "initial planar frame counts changed");
    require(std::abs(initial.camera_position[0] - 600.0) < 0.000001 &&
                std::abs(initial.camera_position[1] - 400.0) < 0.000001,
            "planar target did not move the initial camera position");
    std::vector<terra_request_v1> requests = copy_vector(
        context.get(), terra_get_requests, "terra_get_requests planar");
    const terra_request_v1* root = find_request(requests, TERRA_REQUEST_ROOT);
    const terra_request_v1* detail =
        find_request(requests, TERRA_REQUEST_DETAIL);
    require(root != nullptr && detail != nullptr,
            "planar root dependency chain is missing");

    const std::vector<std::uint8_t> root_record = read_binary(argv[1]);
    const std::vector<std::uint8_t> detail_record = read_binary(argv[2]);
    require(root_record.size() == 10967U && detail_record.size() == 9912U,
            "planar golden record size changed");
    require_ok(terra_submit_record(
                   context.get(), root->kind, &root->key,
                   root_record.data(), root_record.size()),
               "terra_submit_record planar root");
    require_ok(terra_update(context.get(), 0.005F),
               "terra_update after planar root");
    requests = copy_vector(context.get(), terra_get_requests,
                           "terra_get_requests after root");
    detail = find_request(requests, TERRA_REQUEST_DETAIL);
    require(requests.size() == 1U && detail != nullptr,
            "planar detail request changed after root");
    require_ok(terra_submit_record(
                   context.get(), detail->kind, &detail->key,
                   detail_record.data(), detail_record.size()),
               "terra_submit_record planar root detail");
    require_ok(terra_update(context.get(), 0.005F),
               "terra_update after planar hierarchy");

    terra_frame_v1 frame{};
    frame.struct_size = sizeof(frame);
    require_ok(terra_get_frame(context.get(), &frame),
               "terra_get_frame planar drawable");
    require(frame.sequence == 3U && frame.patch_count == 4U &&
                frame.request_count == 0U &&
                frame.loaded_patch_count == 2U && frame.draw_count == 4U &&
                frame.vertex_count == 8580U,
            "drawable planar frame counts changed");

    const std::vector<terra_draw_range_v1> draws = copy_vector(
        context.get(), terra_get_draw_ranges,
        "terra_get_draw_ranges planar");
    const std::vector<float> positions = copy_vector(
        context.get(), terra_get_position_buffer,
        "terra_get_position_buffer planar");
    const std::vector<float> texture_uv = copy_vector(
        context.get(), terra_get_texture_uv_buffer,
        "terra_get_texture_uv_buffer planar");
    const std::vector<std::uint16_t> indices = copy_vector(
        context.get(), terra_get_index_buffer,
        "terra_get_index_buffer planar");
    require(draws.size() == frame.draw_count &&
                positions.size() == frame.position_float_count &&
                texture_uv.size() == frame.texture_float_count &&
                positions.size() == frame.vertex_count * 3U &&
                texture_uv.size() == frame.vertex_count * 2U,
            "planar draw buffer counts disagree");
    require(std::all_of(draws.begin(), draws.end(),
                        [](const terra_draw_range_v1& draw) {
                          return draw.texture.level == 0U &&
                                 draw.texture.matrix == 0 &&
                                 draw.texture.row == 0 &&
                                 draw.texture.column == 0 &&
                                 draw.vertex_count == 2145U &&
                                 draw.index_count == 24573U;
                        }),
            "planar draw range contract changed");
    require(std::all_of(texture_uv.begin(), texture_uv.end(),
                        [](float value) {
                          return std::isfinite(value) && value >= -0.0001F &&
                                 value <= 1.0001F;
                        }),
            "planar texture coordinates are invalid");
    float minimum_height = std::numeric_limits<float>::max();
    float maximum_height = std::numeric_limits<float>::lowest();
    for (std::size_t index = 2U; index < positions.size(); index += 3U) {
      minimum_height = std::min(minimum_height, positions[index]);
      maximum_height = std::max(maximum_height, positions[index]);
    }
    require(std::isfinite(minimum_height) && std::isfinite(maximum_height) &&
                maximum_height > minimum_height,
            "real planar record produced a flat or invalid surface");

    terra_camera_v1 camera{};
    camera.struct_size = sizeof(camera);
    camera.distance = 3000.0;
    camera.tilt_radians = -0.7853981633974483;
    camera.yaw_radians = 0.5235987755982988;
    require_ok(terra_set_camera(context.get(), &camera),
               "terra_set_camera planar");
    require_ok(terra_update(context.get(), 0.005F),
               "terra_update planar camera");
    terra_frame_v1 tilted{};
    tilted.struct_size = sizeof(tilted);
    require_ok(terra_get_frame(context.get(), &tilted),
               "terra_get_frame planar tilted");
    require(tilted.camera_position[0] != frame.camera_position[0] ||
                tilted.camera_position[1] != frame.camera_position[1] ||
                tilted.camera_position[2] != frame.camera_position[2],
            "planar camera update did not move the eye");

    require_ok(terra_set_planar_level(context.get(), 2U),
               "terra_set_planar_level two");
    require_ok(terra_update(context.get(), 0.005F),
               "terra_update planar level two");
    requests = copy_vector(context.get(), terra_get_requests,
                           "terra_get_requests planar level two");
    require(requests.size() == 4U &&
                std::all_of(requests.begin(), requests.end(),
                            [](const terra_request_v1& request) {
                              return request.kind == TERRA_REQUEST_DETAIL &&
                                     request.key.level == 1U;
                            }),
            "planar level two dependency requests changed");

    std::cout << "schema=terra.c_api.planar.v1\n";
    std::cout << "draw_count=" << draws.size() << '\n';
    std::cout << "vertex_count=" << frame.vertex_count << '\n';
    std::cout << "position_fnv1a32="
              << fnv1a32(positions.data(),
                          positions.size() * sizeof(positions.front()))
              << '\n';
    std::cout << "texture_fnv1a32="
              << fnv1a32(texture_uv.data(),
                          texture_uv.size() * sizeof(texture_uv.front()))
              << '\n';
    std::cout << std::fixed << std::setprecision(6)
              << "height_range=" << minimum_height << ',' << maximum_height
              << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
