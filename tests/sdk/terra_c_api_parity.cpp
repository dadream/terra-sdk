#include <terra/c_api/terra.h>

#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
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
  require(static_cast<bool>(input), "unable to open patch fixture");
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "patch fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read patch fixture");
  return result;
}

void print_key(const terra_patch_key_v1& key) {
  std::cout << key.level << ',' << key.i << ',' << key.j << ',' << key.k;
}

std::uint32_t fnv1a32(const std::vector<std::uint16_t>& values) {
  std::uint32_t hash = 2166136261U;
  for (const std::uint16_t value : values) {
    hash ^= static_cast<std::uint8_t>(value & 0xffU);
    hash *= 16777619U;
    hash ^= static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    hash *= 16777619U;
  }
  return hash;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: terra_c_api_parity PATCH_RECORD\n";
    return 2;
  }
  try {
    std::unique_ptr<terra_context, void (*)(terra_context*)> context(
        terra_create(), terra_destroy);
    require(context != nullptr, "terra_create failed");

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
    require_ok(terra_load_manifest(context.get(), &manifest),
               "terra_load_manifest");

    terra_viewport_v1 viewport{};
    viewport.struct_size = sizeof(viewport);
    viewport.width = 1280U;
    viewport.height = 720U;
    viewport.vertical_fov_radians = 30.0 * (3.14 / 180.0);
    require_ok(terra_set_viewport(context.get(), &viewport),
               "terra_set_viewport");
    require_ok(terra_update(context.get(), 0.005F), "terra_update");

    terra_frame_v1 initial{};
    initial.struct_size = sizeof(initial);
    require_ok(terra_get_frame(context.get(), &initial), "terra_get_frame");

    std::size_t patch_count = 0U;
    require(terra_get_frame_patches(context.get(), nullptr, 0U,
                                    &patch_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "patch sizing failed");
    std::vector<terra_patch_decision_v1> patches(patch_count);
    require_ok(terra_get_frame_patches(context.get(), patches.data(),
                                       patches.size(), &patch_count),
               "terra_get_frame_patches");

    std::size_t request_count = 0U;
    require(terra_get_requests(context.get(), nullptr, 0U, &request_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "request sizing failed");
    std::vector<terra_request_v1> requests(request_count);
    require_ok(terra_get_requests(context.get(), requests.data(),
                                  requests.size(), &request_count),
               "terra_get_requests");

    std::size_t index_count = 0U;
    require(terra_get_index_buffer(context.get(), nullptr, 0U,
                                   &index_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "index sizing failed");
    std::vector<std::uint16_t> indices(index_count);
    require_ok(terra_get_index_buffer(context.get(), indices.data(),
                                      indices.size(), &index_count),
               "terra_get_index_buffer");

    const std::vector<std::uint8_t> record = read_binary(argv[1]);
    require_ok(terra_submit_patch(context.get(), &requests.front().key,
                                  record.data(), record.size()),
               "terra_submit_patch");
    require_ok(terra_update(context.get(), 0.005F), "terra_update after patch");

    terra_frame_v1 after{};
    after.struct_size = sizeof(after);
    require_ok(terra_get_frame(context.get(), &after),
               "terra_get_frame after patch");
    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_ok(terra_get_stats(context.get(), &stats), "terra_get_stats");

    std::cout << "schema=terra.c_api.parity.v1\n";
    std::cout << "abi=" << terra_abi_version() << '\n';
    std::cout << "layout=" << terra_sizeof_manifest_v1() << ','
              << terra_sizeof_viewport_v1() << ','
              << terra_sizeof_patch_key_v1() << ','
              << terra_sizeof_request_v1() << ','
              << terra_sizeof_patch_decision_v1() << ','
              << terra_sizeof_frame_v1() << ','
              << terra_sizeof_stats_v1() << '\n';
    std::cout << "initial.sequence=" << initial.sequence << '\n';
    std::cout << "initial.patch_count=" << initial.patch_count << '\n';
    std::cout << "initial.request_count=" << initial.request_count << '\n';
    std::cout << std::fixed << std::setprecision(6);
    std::cout << "initial.camera=" << initial.camera_position[0] << ','
              << initial.camera_position[1] << ','
              << initial.camera_position[2] << '\n';
    std::cout << "initial.first=";
    print_key(patches.front().key);
    std::cout << ',' << patches.front().visible << ','
              << patches.front().priority << '\n';
    std::cout << "initial.last=";
    print_key(patches.back().key);
    std::cout << ',' << patches.back().visible << ','
              << patches.back().priority << '\n';
    std::cout << "initial.request_kind=" << requests.front().kind << '\n';
    std::cout << "initial.index_count=" << indices.size() << '\n';
    std::cout << "initial.index_fnv1a32=" << fnv1a32(indices) << '\n';
    std::cout << "after.sequence=" << after.sequence << '\n';
    std::cout << "after.patch_count=" << after.patch_count << '\n';
    std::cout << "after.request_count=" << after.request_count << '\n';
    std::cout << "after.loaded_patch_count=" << after.loaded_patch_count
              << '\n';
    std::cout << "stats.update_count=" << stats.update_count << '\n';
    std::cout << "stats.loaded_patch_count=" << stats.loaded_patch_count
              << '\n';
    std::cout << "stats.decoded_value_count=" << stats.decoded_value_count
              << '\n';
    std::cout << "stats.last_sequence=" << stats.last_sequence << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
