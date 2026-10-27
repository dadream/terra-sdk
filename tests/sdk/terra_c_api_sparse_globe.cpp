#include <terra/c_api/terra.h>

#include "mesh_output.hpp"

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

terra_terrain_manifest_v3 manifest() {
  terra_terrain_manifest_v3 value{};
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
    const terra_terrain_manifest_v3 dataset = manifest();
    require_ok(terra_load_terrain_manifest(context, &dataset), "load manifest");
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
    const auto draws = read_mesh_output(context).draws;
    require(!draws.empty(), "unavailable detail removed parent coverage");
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

    // Desktop NULL_DATA is a zero residual subtree, distinct from a failed fetch.
    context = terra_create();
    require_ok(terra_load_terrain_manifest(context, &dataset), "load procedural fixture");
    require_ok(terra_set_viewport(context, &viewport), "set procedural viewport");
    require_ok(terra_update(context, 0.0025F), "request procedural roots");
    for (const auto& request : requests(context)) {
      if (request.kind == TERRA_REQUEST_ROOT) {
        require_ok(terra_submit_record(context, request.kind, &request.key, root_bytes.data(), root_bytes.size()), "submit procedural root");
      } else require_ok(terra_no_data_record(context, &request.key), "confirm absent detail");
    }
    terra_update_budget_v2 budget{};
    budget.struct_size = sizeof(budget);
    budget.api_version = TERRA_UPDATE_API_VERSION;
    budget.maximum_change_count = 4U;
    budget.maximum_priority_update_count = 128U;
    budget.maximum_node_count = 64U;
    bool refined = false;
    for (std::size_t step = 0U; step < 100U; ++step) {
      require_ok(terra_update_step(context, 0.0025F, &budget), "refine zero residual subtree");
      std::size_t count = 0U;
      require(terra_get_requests(context, nullptr, 0U, &count) == TERRA_STATUS_OK && count == 0U,
              "procedural descendants made network requests");
      terra_update_state_v2 state{};
      state.struct_size = sizeof(state);
      require_ok(terra_get_update_state(context, &state), "read procedural state");
      refined = refined || state.topology_node_count > 8U;
      require(state.topology_node_count <= 64U && state.decoded_record_bytes < 1024U * 1024U &&
              state.height_bytes <= 32U * 1024U * 1024U, "procedural refinement exceeded byte or topology limits");
    }
    terra_terrain_sample_v1 synthetic_query{};
    synthetic_query.struct_size = sizeof(synthetic_query);
    bool queried_descendant = false;
    for (double lon = -165; lon < 180; lon += 30) {
      require_ok(terra_sample_terrain(context, lon, 35.0, &synthetic_query), "query zero residual subtree");
      require(synthetic_query.available && synthetic_query.data_level == 0U &&
              synthetic_query.sample_spacing_metres > 100000.0,
              "zero residual synthesis fabricated finer source precision");
      queried_descendant = queried_descendant || synthetic_query.key.level > 0U;
    }
    require(queried_descendant, "procedural query did not exercise a refined cache entry");
    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_ok(terra_get_stats(context, &stats), "read procedural statistics");
    require(refined && stats.failed_patch_count == 0U, "confirmed absence stalled refinement or became a failure");
    terra_destroy(context);

    // A response can arrive while a newer cut is being prepared in the Worker,
    // before that cut's request frontier has reached the main thread.
    context = terra_create();
    require_ok(terra_load_terrain_manifest(context, &dataset), "load late-response manifest");
    require_ok(terra_set_viewport(context, &viewport), "set late-response viewport");
    require_ok(terra_update(context, 0.0025F), "issue late-response requests");
    const auto issued = requests(context);
    const auto other = std::find_if(issued.begin(), issued.end(), [&detail_key](const terra_request_v1& request) {
      return request.kind == TERRA_REQUEST_DETAIL && !same_key(request.key, detail_key.level,
          detail_key.i, detail_key.j, detail_key.k);
    });
    require(other != issued.end(), "missing second late detail request");
    require_ok(terra_update(context, 1.0F), "replace request frontier");
    require(find_root_zero(requests(context), TERRA_REQUEST_DETAIL) == nullptr,
            "late detail fixture remained in the current frontier");
    require_ok(terra_submit_record(context, TERRA_REQUEST_DETAIL, &detail_key,
        detail_bytes.data(), detail_bytes.size()), "accept previously issued detail response");
    require_ok(terra_fail_record(context, other->kind, &other->key), "accept previously issued failure");
    auto unrequested = detail_key;
    unrequested.level = 20U;
    require(terra_submit_record(context, TERRA_REQUEST_DETAIL, &unrequested,
        detail_bytes.data(), detail_bytes.size()) == TERRA_STATUS_NOT_FOUND,
        "unsolicited detail was admitted by request history");
    require_ok(terra_load_terrain_manifest(context, &dataset), "reset late-response dataset");
    require(terra_submit_record(context, TERRA_REQUEST_DETAIL, &detail_key,
        detail_bytes.data(), detail_bytes.size()) == TERRA_STATUS_NOT_FOUND,
        "request history survived the dataset reset");
    terra_destroy(context);

    // Invisible resident leaves must not inflate the draw payload. Root
    // coverage remains exported independently for camera previews.
    context = terra_create();
    require(context != nullptr, "unable to create preview coverage context");
    require_ok(terra_load_terrain_manifest(context, &dataset), "load preview manifest");
    require_ok(terra_set_viewport(context, &viewport), "set preview viewport");
    require_ok(terra_update(context, 0.0025F), "initialize preview coverage");
    require_ok(terra_submit_record(context, TERRA_REQUEST_ROOT, &root_key,
                                   root_bytes.data(), root_bytes.size()),
               "submit preview root");
    require_ok(terra_fail_record(context, TERRA_REQUEST_DETAIL, &detail_key),
               "keep preview root coarse");
    terra_camera_v3 preview_camera{};
    preview_camera.struct_size = sizeof(preview_camera);
    preview_camera.distance = 10000.0;
    require_ok(terra_set_camera(context, &preview_camera), "set preview camera");
    bool observed_invisible = false;
    for (double longitude : {-135.0, -45.0, 45.0, 135.0}) {
      require_ok(terra_set_globe_target(context, longitude, -45.0),
                 "rotate preview target");
      require_ok(terra_update(context, 0.0025F), "update preview target");
      std::size_t patch_count = 0U;
      require(terra_get_frame_patches(context, nullptr, 0U, &patch_count) ==
                  TERRA_STATUS_BUFFER_TOO_SMALL, "size preview patches");
      std::vector<terra_patch_decision_v1> patches(patch_count);
      require_ok(terra_get_frame_patches(context, patches.data(), patches.size(),
                                         &patch_count), "read preview patches");
      for (const terra_patch_decision_v1& patch : patches) {
        if (same_key(patch.key, root_key.level, root_key.i, root_key.j, root_key.k) &&
            patch.visible == 0U) {
          observed_invisible = true;
          const auto preview_draws = read_mesh_output(context).draws;
          const auto fragments = std::count_if(preview_draws.begin(), preview_draws.end(),
              [&root_key](const terra_draw_range_v1& draw) {
                return draw.flags == TERRA_DRAW_FLAG_NONE &&
                    same_key(draw.key, root_key.level, root_key.i, root_key.j, root_key.k);
              });
          require(fragments == 0, "invisible resident leaf entered visible payload");
          require(std::count_if(preview_draws.begin(), preview_draws.end(),
              [&root_key](const terra_draw_range_v1& draw) {
                return draw.flags == TERRA_DRAW_FLAG_COVERAGE &&
                    same_key(draw.key, root_key.level, root_key.i, root_key.j, root_key.k);
              }) == 2, "root preview coverage was lost");
        }
      }
    }
    require(observed_invisible, "preview regression did not exercise an invisible leaf");
    terra_destroy(context);
    std::cout << "Terra sparse globe fallback contract passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
