#include <terra/c_api/terra.h>

#include <algorithm>
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

void require_ok(terra_status status, const char* operation) {
  if (status != TERRA_STATUS_OK) {
    throw std::runtime_error(std::string(operation) + " returned status " +
                             std::to_string(status));
  }
}

std::vector<std::uint8_t> read_binary(const char* path) {
  std::ifstream input(path, std::ios::binary);
  require(static_cast<bool>(input), "unable to open sparse globe fixture");
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "sparse globe fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read sparse globe fixture");
  return result;
}

terra_manifest_v1 manifest() {
  terra_manifest_v1 value{};
  value.struct_size = sizeof(value);
  value.api_version = TERRA_C_API_VERSION;
  value.format_version = 1U;
  value.patch_dimension = 64U;
  value.transform = TERRA_TRANSFORM_CYLINDRICAL;
  value.height_scale_factor = 0.001953125;
  value.minimum_u = -180.0;
  value.minimum_v = -90.0;
  value.maximum_u = 180.0;
  value.maximum_v = 90.0;
  value.radius = 6378000.0;
  value.texture_matrix_level_offset = 1U;
  value.texture_maximum_level = 17U;
  return value;
}

std::vector<terra_request_v1> requests(terra_context* context) {
  std::size_t count = 0U;
  const terra_status sizing =
      terra_get_requests(context, nullptr, 0U, &count);
  require(sizing == TERRA_STATUS_BUFFER_TOO_SMALL && count > 0U,
          "sparse globe request sizing failed");
  std::vector<terra_request_v1> result(count);
  require_ok(terra_get_requests(context, result.data(), result.size(), &count),
             "read sparse globe requests");
  result.resize(count);
  return result;
}

bool same_key(const terra_patch_key_v1& key, std::uint32_t level,
              std::int32_t i, std::int32_t j, std::int32_t k) {
  return key.level == level && key.i == i && key.j == j && key.k == k;
}

const terra_request_v1* find_root_zero(
    const std::vector<terra_request_v1>& values, std::uint32_t kind) {
  const auto found = std::find_if(
      values.begin(), values.end(), [kind](const terra_request_v1& request) {
        return request.kind == kind &&
               same_key(request.key, 0U, 0, 134217728, 134217728);
      });
  return found == values.end() ? nullptr : &*found;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: terra_c_api_sparse_globe ROOT DETAIL\n";
    return 2;
  }
  try {
    terra_context* context = terra_create();
    require(context != nullptr, "unable to create sparse globe context");
    const terra_manifest_v1 dataset = manifest();
    require_ok(terra_load_manifest(context, &dataset), "load manifest");
    terra_viewport_v1 viewport{};
    viewport.struct_size = sizeof(viewport);
    viewport.width = 1280U;
    viewport.height = 720U;
    viewport.vertical_fov_radians = 30.0 * (3.14 / 180.0);
    require_ok(terra_set_viewport(context, &viewport), "set viewport");
    require_ok(terra_update(context, 0.0025F), "initial sparse update");

    const std::vector<terra_request_v1> initial = requests(context);
    const terra_request_v1* root = find_root_zero(initial, TERRA_REQUEST_ROOT);
    const terra_request_v1* detail =
        find_root_zero(initial, TERRA_REQUEST_DETAIL);
    require(root != nullptr && detail != nullptr,
            "root zero requests are missing");
    const terra_patch_key_v1 root_key = root->key;
    const terra_patch_key_v1 detail_key = detail->key;
    const std::vector<std::uint8_t> root_bytes = read_binary(argv[1]);
    require_ok(terra_submit_record(context, TERRA_REQUEST_ROOT, &root_key,
                                   root_bytes.data(), root_bytes.size()),
               "submit sparse root");
    require_ok(terra_fail_record(context, TERRA_REQUEST_DETAIL, &detail_key),
               "fail sparse detail");
    require_ok(terra_update(context, 0.0025F), "fallback sparse update");

    const std::vector<terra_request_v1> fallback = requests(context);
    require(find_root_zero(fallback, TERRA_REQUEST_DETAIL) == nullptr,
            "unavailable detail was requested again");
    std::size_t draw_count = 0U;
    require(terra_get_draw_ranges(context, nullptr, 0U, &draw_count) ==
                TERRA_STATUS_BUFFER_TOO_SMALL &&
                draw_count > 0U,
            "unavailable detail removed parent coverage");
    std::vector<terra_draw_range_v1> draws(draw_count);
    require_ok(terra_get_draw_ranges(context, draws.data(), draws.size(),
                                     &draw_count),
               "read fallback draws");
    require(std::any_of(draws.begin(), draws.end(),
                        [&root_key](const terra_draw_range_v1& draw) {
                          return same_key(draw.key, root_key.level, root_key.i,
                                          root_key.j, root_key.k);
                        }),
            "fallback frame did not draw the parent patch");

    require_ok(terra_retry_record(context, TERRA_REQUEST_DETAIL, &detail_key),
               "retry sparse detail");
    require_ok(terra_update(context, 0.0025F), "retry sparse update");
    const std::vector<terra_request_v1> retry = requests(context);
    require(find_root_zero(retry, TERRA_REQUEST_DETAIL) != nullptr,
            "retried detail did not return to the request queue");
    const std::vector<std::uint8_t> detail_bytes = read_binary(argv[2]);
    require_ok(terra_submit_record(context, TERRA_REQUEST_DETAIL, &detail_key,
                                   detail_bytes.data(), detail_bytes.size()),
               "submit retried detail");
    require_ok(terra_update(context, 0.0025F), "resolved sparse update");

    terra_destroy(context);
    std::cout << "Terra sparse globe fallback contract passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
