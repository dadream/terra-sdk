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
  if (argc != 2) {
    std::cerr << "usage: terra_c_api_contract PATCH_RECORD\n";
    return 2;
  }
  try {
    require(terra_abi_version() == TERRA_C_API_VERSION,
            "ABI version changed");
    require(terra_sizeof_manifest_v1() == sizeof(terra_manifest_v1) &&
                terra_sizeof_viewport_v1() == sizeof(terra_viewport_v1) &&
                terra_sizeof_camera_v1() == sizeof(terra_camera_v1) &&
                terra_sizeof_patch_key_v1() == sizeof(terra_patch_key_v1) &&
                terra_sizeof_request_v1() == sizeof(terra_request_v1) &&
                terra_sizeof_patch_decision_v1() ==
                    sizeof(terra_patch_decision_v1) &&
                terra_sizeof_frame_v1() == sizeof(terra_frame_v1) &&
                terra_sizeof_stats_v1() == sizeof(terra_stats_v1),
            "ABI size query changed");

    terra_context* context = terra_create();
    require(context != nullptr, "terra_create failed");

    require_status(terra_update(context, 0.005F),
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
                frame.patch_count == 28U && frame.request_count == 28U &&
                frame.loaded_patch_count == 0U,
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
    require(patch_count == 28U, "patch sizing count changed");
    std::vector<terra_patch_decision_v1> patches(patch_count);
    require_status(terra_get_frame_patches(context, patches.data(),
                                           patches.size(), &patch_count),
                   TERRA_STATUS_OK, "get patches");
    require(patches.front().key.level == 1U &&
                patches.front().key.i == 0 &&
                patches.front().key.j == 268435456 &&
                patches.front().key.k == 134217728 &&
                patches.front().visible == 1U &&
                patches.back().key.level == 2U &&
                patches.back().key.i == -67108864 &&
                patches.back().key.j == -67108864 &&
                patches.back().key.k == -134217728 &&
                patches.back().visible == 1U,
            "frame patch IDs changed");

    std::size_t request_count = 0U;
    require_status(terra_get_requests(context, nullptr, 0U, &request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "request sizing");
    require(request_count == 28U, "request sizing count changed");
    std::vector<terra_request_v1> requests(request_count);
    require_status(terra_get_requests(context, requests.data(),
                                      requests.size(), &request_count),
                   TERRA_STATUS_OK, "get requests");
    require(requests.front().kind == TERRA_REQUEST_PATCH,
            "request kind changed");

    const std::vector<std::uint8_t> patch_record = read_binary(argv[1]);
    require_status(terra_submit_patch(context, &requests.front().key,
                                      patch_record.data(),
                                      patch_record.size()),
                   TERRA_STATUS_OK, "submit patch");
    require_status(terra_update(context, 0.005F), TERRA_STATUS_OK,
                   "update after patch");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get updated frame");
    require(frame.sequence == 2U && frame.patch_count == 28U &&
                frame.request_count == 27U &&
                frame.loaded_patch_count == 1U,
            "loaded patch state changed");

    require_status(terra_fail_patch(context, &requests[1].key),
                   TERRA_STATUS_OK, "fail patch");
    const std::uint8_t malformed[] = {0U};
    require_status(terra_submit_patch(context, &requests[2].key, malformed,
                                      sizeof(malformed)),
                   TERRA_STATUS_DECODE_ERROR, "malformed patch");

    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_status(terra_get_stats(context, &stats), TERRA_STATUS_OK,
                   "get stats");
    require(stats.update_count == 2U && stats.loaded_patch_count == 1U &&
                stats.failed_patch_count == 1U &&
                stats.decoded_value_count == 4096U &&
                stats.current_patch_count == 28U &&
                stats.current_request_count == 27U &&
                stats.last_sequence == 2U,
            "ABI statistics changed");

    terra_camera_v1 camera{};
    camera.struct_size = sizeof(camera);
    camera.distance = 20000000.0;
    camera.tilt_radians = 0.7853981633974483;
    camera.yaw_radians = 0.5235987755982988;
    require_status(terra_set_camera(context, &camera), TERRA_STATUS_OK,
                   "set camera");
    require_status(terra_update(context, 0.005F), TERRA_STATUS_OK,
                   "camera update");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get camera frame");
    require(frame.sequence == 3U && frame.decisions_complete == 1U,
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
