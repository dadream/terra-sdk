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
  require(static_cast<bool>(input), "unable to open record fixture");
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "record fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read record fixture");
  return result;
}

void print_key(const terra_patch_key_v1& key) {
  std::cout << key.level << ',' << key.i << ',' << key.j << ',' << key.k;
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

const terra_request_v1* find_request(
    const std::vector<terra_request_v1>& requests, std::uint32_t kind,
    std::uint32_t level, std::int32_t i, std::int32_t j, std::int32_t k) {
  for (const terra_request_v1& request : requests) {
    if (request.kind == kind && request.key.level == level &&
        request.key.i == i && request.key.j == j && request.key.k == k) {
      return &request;
    }
  }
  return nullptr;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr << "usage: terra_c_api_parity ROOT0 DETAIL0 ROOT3 DETAIL3 CHILD_DETAIL\n";
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
    manifest.texture_matrix_level_offset = 0U;
    manifest.texture_maximum_level = 8U;
    require_ok(terra_load_manifest(context.get(), &manifest),
               "terra_load_manifest");
    require_ok(terra_set_globe_target(context.get(), 0.0, 0.0),
               "terra_set_globe_target");

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

    require_ok(terra_update(context.get(), 0.0025F),
               "terra_update hierarchy cut");

    std::size_t request_count = 0U;
    require(terra_get_requests(context.get(), nullptr, 0U, &request_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "request sizing failed");
    std::vector<terra_request_v1> requests(request_count);
    require_ok(terra_get_requests(context.get(), requests.data(),
                                  requests.size(), &request_count),
               "terra_get_requests");
    const terra_request_v1* root0 = find_request(
        requests, TERRA_REQUEST_ROOT, 0U, 0, 134217728, 134217728);
    const terra_request_v1* detail0 = find_request(
        requests, TERRA_REQUEST_DETAIL, 0U, 0, 134217728, 134217728);
    const terra_request_v1* root3 = find_request(
        requests, TERRA_REQUEST_ROOT, 0U, -134217728, 134217728, 0);
    const terra_request_v1* detail3 = find_request(
        requests, TERRA_REQUEST_DETAIL, 0U, -134217728, 134217728, 0);
    const terra_request_v1* child_detail = find_request(
        requests, TERRA_REQUEST_DETAIL, 1U, -134217728, 134217728,
        134217728);
    require(root0 != nullptr && detail0 != nullptr && root3 != nullptr &&
                detail3 != nullptr && child_detail != nullptr,
            "complete globe request chain is missing");

    std::size_t index_count = 0U;
    require(terra_get_index_buffer(context.get(), nullptr, 0U,
                                   &index_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "index sizing failed");
    std::vector<std::uint16_t> indices(index_count);
    require_ok(terra_get_index_buffer(context.get(), indices.data(),
                                      indices.size(), &index_count),
               "terra_get_index_buffer");

    const std::vector<std::uint8_t> root0_record = read_binary(argv[1]);
    const std::vector<std::uint8_t> detail0_record = read_binary(argv[2]);
    const std::vector<std::uint8_t> root3_record = read_binary(argv[3]);
    const std::vector<std::uint8_t> detail3_record = read_binary(argv[4]);
    const std::vector<std::uint8_t> child_record = read_binary(argv[5]);
    require_ok(terra_submit_record(
                   context.get(), root0->kind, &root0->key,
                   root0_record.data(), root0_record.size()),
               "terra_submit_record root zero");
    require_ok(terra_submit_record(
                   context.get(), detail0->kind, &detail0->key,
                   detail0_record.data(), detail0_record.size()),
               "terra_submit_record root zero detail");
    require_ok(terra_submit_record(
                   context.get(), root3->kind, &root3->key,
                   root3_record.data(), root3_record.size()),
               "terra_submit_record root three");
    require_ok(terra_submit_record(
                   context.get(), detail3->kind, &detail3->key,
                   detail3_record.data(), detail3_record.size()),
               "terra_submit_record root three detail");
    require_ok(terra_submit_record(
                   context.get(), child_detail->kind, &child_detail->key,
                   child_record.data(), child_record.size()),
               "terra_submit_record shared child detail");
    require_ok(terra_update(context.get(), 0.0025F),
               "terra_update after records");

    terra_frame_v1 after{};
    after.struct_size = sizeof(after);
    require_ok(terra_get_frame(context.get(), &after),
               "terra_get_frame after records");

    std::size_t draw_count = 0U;
    require(terra_get_draw_ranges(context.get(), nullptr, 0U, &draw_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "draw sizing failed");
    std::vector<terra_draw_range_v1> draws(draw_count);
    require_ok(terra_get_draw_ranges(context.get(), draws.data(),
                                     draws.size(), &draw_count),
               "terra_get_draw_ranges");

    std::size_t position_count = 0U;
    require(terra_get_position_buffer(context.get(), nullptr, 0U,
                                      &position_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "position sizing failed");
    std::vector<float> positions(position_count);
    require_ok(terra_get_position_buffer(context.get(), positions.data(),
                                         positions.size(), &position_count),
               "terra_get_position_buffer");

    std::size_t texture_count = 0U;
    require(terra_get_texture_uv_buffer(context.get(), nullptr, 0U,
                                        &texture_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL,
            "texture sizing failed");
    std::vector<float> texture_uv(texture_count);
    require_ok(terra_get_texture_uv_buffer(
                   context.get(), texture_uv.data(), texture_uv.size(),
                   &texture_count),
               "terra_get_texture_uv_buffer");
    require(!draws.empty() && !positions.empty() && !texture_uv.empty(),
            "record chain produced no render buffers");

    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_ok(terra_get_stats(context.get(), &stats), "terra_get_stats");

    std::cout << "schema=terra.c_api.parity.v1\n";
    std::cout << "abi=" << terra_abi_version() << '\n';
    std::cout << "layout=" << terra_sizeof_manifest_v1() << ','
              << terra_sizeof_viewport_v1() << ','
              << terra_sizeof_patch_key_v1() << ','
              << terra_sizeof_texture_key_v1() << ','
              << terra_sizeof_request_v1() << ','
              << terra_sizeof_patch_decision_v1() << ','
              << terra_sizeof_draw_range_v1() << ','
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
    std::cout << "initial.request_kind=" << root0->kind << '\n';
    std::cout << "initial.index_count=" << indices.size() << '\n';
    std::cout << "initial.index_fnv1a32="
              << fnv1a32(indices.data(),
                         indices.size() * sizeof(indices.front())) << '\n';
    std::cout << "after.sequence=" << after.sequence << '\n';
    std::cout << "after.patch_count=" << after.patch_count << '\n';
    std::cout << "after.request_count=" << after.request_count << '\n';
    std::cout << "after.loaded_patch_count=" << after.loaded_patch_count
              << '\n';
    std::cout << "after.draw_count=" << after.draw_count << '\n';
    std::cout << "after.vertex_count=" << after.vertex_count << '\n';
    std::cout << "after.first_draw=";
    print_key(draws.front().key);
    std::cout << ',' << draws.front().fragment << ','
              << draws.front().texture.level << ','
              << draws.front().texture.matrix << ','
              << draws.front().texture.row << ','
              << draws.front().texture.column << '\n';
    std::cout << "after.position_count=" << positions.size() << '\n';
    std::cout << "after.position_fnv1a32="
              << fnv1a32(positions.data(),
                         positions.size() * sizeof(positions.front())) << '\n';
    std::cout << "after.texture_count=" << texture_uv.size() << '\n';
    std::cout << "after.texture_fnv1a32="
              << fnv1a32(texture_uv.data(),
                         texture_uv.size() * sizeof(texture_uv.front())) << '\n';
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
