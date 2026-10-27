#include <terra/c_api/terra.h>

#include "mesh_output.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

// Fail one allocation at a time inside a C API publication. Disable the fault
// before throwing so error reporting and the verification reads can allocate.
static std::ptrdiff_t allocation_fail_after = -1;
static std::size_t allocation_failure_size = 0U;
void* operator new(std::size_t size) {
  if ((!allocation_failure_size || size == allocation_failure_size) &&
      allocation_fail_after >= 0 && allocation_fail_after-- == 0) {
    allocation_fail_after = -1;
    throw std::bad_alloc();
  }
  if (void* value = std::malloc(size ? size : 1U)) return value;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

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

terra_terrain_manifest_v3 planar_manifest() {
  terra_terrain_manifest_v3 manifest{};
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

    terra_terrain_manifest_v3 manifest = planar_manifest();
    require_ok(terra_load_terrain_manifest(context.get(), &manifest),
               "terra_load_terrain_manifest planar");
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

    terra_terrain_sample_v1 query{};
    query.struct_size = sizeof(query);
    require(terra_sizeof_terrain_sample_v1() == 64U, "terrain query ABI size changed");
    require_ok(terra_sample_terrain(context.get(), 512.5, 512.5, &query), "empty terrain query");
    require(!query.available, "query claimed coverage without heights");
    require(terra_sample_terrain(context.get(), -1.0, 512.5, &query) == TERRA_STATUS_INVALID_ARGUMENT,
            "query admitted coordinates outside the dataset");

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

    const auto output = read_mesh_output(context.get());
    const auto& draws = output.draws;
    const auto& positions = output.positions;
    const auto& texture_uv = output.texture_uv;
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
                                 draw.texture.root == 0 &&
                                 draw.texture.row == 0 &&
                                 draw.texture.column == 0 &&
                                 draw.vertex_count == 2145U &&
                                 draw.index_count == 4413U;
                        }),
            "planar draw range contract changed");
    require(std::all_of(texture_uv.begin(), texture_uv.end(),
                        [](float value) {
                          return std::isfinite(value) && value >= -0.0001F &&
                                 value <= 1.0001F;
                        }),
            "planar texture coordinates are invalid");
    // Compare interpolated centroids against the real decoded planar mesh.
    // Queries must not publish a frame or require its position-buffer lifetime.
    for (const auto& draw : draws) {
      for (std::size_t i = 0U; i + 2U < indices.size(); i += 59U) {
        const auto a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a == b || a == c || b == c) continue;
        double u = 0, v = 0, z = 0;
        for (const auto vertex : {a, b, c}) {
          const auto offset = (draw.first_vertex + vertex) * 3U;
          u += (positions[offset] + draw.origin[0]) / 3.0;
          v += (positions[offset + 1] + draw.origin[1]) / 3.0;
          z += (positions[offset + 2] + draw.origin[2]) / 3.0;
        }
        require_ok(terra_sample_terrain(context.get(), u, v, &query), "real terrain query");
        require(query.available && query.key.level == 1U && query.data_level == 1U &&
                query.sample_spacing_metres > 0 && std::abs(query.height_metres - z) < 0.0001,
                "query differs from decoded triangle or loses real data provenance");
      }
    }
    terra_frame_v1 after_queries{};
    after_queries.struct_size = sizeof(after_queries);
    require_ok(terra_get_frame(context.get(), &after_queries), "frame after terrain queries");
    require(after_queries.sequence == frame.sequence, "terrain query published a frame");

    float minimum_height = std::numeric_limits<float>::max();
    float maximum_height = std::numeric_limits<float>::lowest();
    for (std::size_t index = 2U; index < positions.size(); index += 3U) {
      minimum_height = std::min(minimum_height, positions[index]);
      maximum_height = std::max(maximum_height, positions[index]);
    }
    require(std::isfinite(minimum_height) && std::isfinite(maximum_height) &&
                maximum_height > minimum_height,
            "real planar record produced a flat or invalid surface");

    terra_camera_v3 camera{};
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

    require_ok(terra_set_planar_level(context.get(), 1U), "return to fine retention fixture");
    require_ok(terra_update(context.get(), 0.005F), "publish fine retention fixture");
    require_ok(terra_get_frame(context.get(), &tilted), "read fine retention fixture");
    const auto previous_meshes = copy_vector(context.get(), terra_get_mesh_resources,
                                             "old planar mesh resources");
    terra_frame_receipt_v2 receipt{};
    receipt.struct_size = sizeof(receipt);
    receipt.api_version = TERRA_UPDATE_API_VERSION;
    receipt.sequence = tilted.sequence;
    require_ok(terra_present_frame(context.get(), &receipt), "present fine planar cut");
    terra_update_budget_v2 compact{};
    compact.struct_size = sizeof(compact);
    compact.api_version = TERRA_UPDATE_API_VERSION;
    for (const auto& mesh : previous_meshes)
      compact.maximum_mesh_bytes += (mesh.position_float_count + mesh.texture_float_count) * sizeof(float);
    require_ok(terra_update_step(context.get(), 0.005F, &compact), "evict unused coarse fixture meshes");
    require_ok(terra_get_frame(context.get(), &tilted), "read compacted fine candidate");
    receipt.sequence = tilted.sequence;
    require_ok(terra_present_frame(context.get(), &receipt), "present compacted fine candidate");
    require_ok(terra_set_planar_level(context.get(), 0U), "prepare coarser planar cut");
    terra_update_state_v2 published{}, prepared{};
    published.struct_size = sizeof(published);
    prepared.struct_size = sizeof(prepared);
    require_ok(terra_get_update_state(context.get(), &published), "read published model version");
    terra_update_budget_v2 budget{};
    budget.struct_size = sizeof(budget);
    budget.api_version = TERRA_UPDATE_API_VERSION;
    budget.maximum_change_count = 32U;
    budget.maximum_priority_update_count = 256U;
    require_ok(terra_advance_terrain(context.get(), 0.005F, &budget, &prepared), "prepare successor model");
    require(prepared.model_revision > published.model_revision && prepared.sequence == receipt.sequence,
            "model version did not advance independently of publication");
    const auto model_revision = prepared.model_revision;
    require_ok(terra_advance_terrain(context.get(), 0.005F, &budget, &prepared), "repeat stable model work");
    require(prepared.model_revision == model_revision, "unchanged model work changed its version");
    require_ok(terra_get_update_state(context.get(), &prepared), "read retained publication version");
    require(prepared.model_revision == published.model_revision,
            "background preparation changed the published candidate version");
    const auto before_meshes = copy_vector(context.get(), terra_get_mesh_resources, "capture owned meshes");
    const auto before_positions = read_mesh_output(context.get()).positions;
    budget.maximum_mesh_bytes = 1U;
    require(terra_update_step(context.get(), 0.005F, &budget) == TERRA_STATUS_CAPACITY_PENDING,
            "native publication ignored its allocation limit");
    terra_frame_v1 retained_frame{};
    retained_frame.struct_size = sizeof(retained_frame);
    require_ok(terra_get_frame(context.get(), &retained_frame), "read refused publication");
    require(retained_frame.sequence == tilted.sequence && retained_frame.draw_count == tilted.draw_count,
            "capacity refusal changed the published frame");
    const auto retained_meshes = copy_vector(context.get(), terra_get_mesh_resources, "read retained meshes");
    require(retained_meshes.size() == before_meshes.size(), "capacity refusal truncated the candidate");
    for (std::size_t i = 0U; i < before_meshes.size(); ++i)
      require(retained_meshes[i].resource_id == before_meshes[i].resource_id, "capacity refusal changed mesh identity");
    require(read_mesh_output(context.get()).positions == before_positions,
            "capacity refusal changed published arrays");
    require_ok(terra_present_frame(context.get(), &receipt), "retained receipt after admission refusal");
    require_ok(terra_get_update_state(context.get(), &prepared), "read refused allocation state");
    require(prepared.mesh_bytes == published.mesh_bytes && prepared.model_revision == published.model_revision,
            "refused admission allocated a partial mesh or changed publication version");
    bool partial_construction = false;
    // First fail metadata preparation; then fail the second position array,
    // after a complete first mesh exists. Select by allocation size so prior
    // cache warming does not change which construction boundary is exercised.
    for (std::ptrdiff_t failure = 0; failure < 2; ++failure) {
      allocation_failure_size = failure ? before_meshes.front().position_float_count * sizeof(float) : 0U;
      allocation_fail_after = failure;
      const auto status = terra_update(context.get(), 0.005F);
      const bool injected = allocation_fail_after == -1;
      allocation_fail_after = -1;
      allocation_failure_size = 0U;
      require(injected && status == TERRA_STATUS_RESOURCE_LIMIT, "allocation fault did not return a resource error");
      require_ok(terra_get_frame(context.get(), &retained_frame), "read failed allocation frame");
      require(retained_frame.sequence == tilted.sequence, "allocation failure published an incomplete frame");
      require(read_mesh_output(context.get()).positions == before_positions,
              "allocation failure mutated the published mesh output");
      require_ok(terra_get_update_state(context.get(), &prepared), "read partial allocation state");
      partial_construction = partial_construction || prepared.mesh_bytes > published.mesh_bytes;
      require_ok(terra_present_frame(context.get(), &receipt), "receipt survived allocation failure");
    }
    require(partial_construction, "allocation fault did not reach new mesh construction");
    require_ok(terra_update(context.get(), 0.005F), "recover coarse publication after allocation failure");
    const auto candidate_meshes = copy_vector(context.get(), terra_get_mesh_resources,
                                              "candidate planar mesh resources");
    require(candidate_meshes.size() == 2U && previous_meshes.size() == 4U,
            "retention fixture did not coarsen topology");
    const std::uint32_t old_id = previous_meshes.front().resource_id;
    const std::uint32_t candidate_id = candidate_meshes.front().resource_id;
    require(terra_retain_meshes(context.get(), &receipt, &old_id, 1U) == TERRA_STATUS_INVALID_STATE,
            "retention accepted a stale sequence");
    terra_frame_v1 coarse{};
    coarse.struct_size = sizeof(coarse);
    require_ok(terra_get_frame(context.get(), &coarse), "read coarse candidate");
    receipt.sequence = coarse.sequence;
    require(terra_retain_meshes(context.get(), nullptr, &old_id, 1U) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_retain_meshes(nullptr, &receipt, &old_id, 1U) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_retain_meshes(context.get(), &receipt, nullptr, 1U) == TERRA_STATUS_INVALID_ARGUMENT,
            "retention accepted invalid pointers");
    const std::uint32_t duplicate[] = {old_id, old_id};
    const std::uint32_t mixed[] = {std::min(old_id, candidate_id), std::max(old_id, candidate_id)};
    const std::uint32_t unknown[] = {old_id, 0xffffffffU};
    const std::uint32_t reversed[] = {mixed[1], mixed[0]};
    require(terra_retain_meshes(context.get(), &receipt, duplicate, 2U) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_retain_meshes(context.get(), &receipt, reversed, 2U) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_retain_meshes(context.get(), &receipt, unknown, 2U) == TERRA_STATUS_INVALID_STATE,
            "retention accepted duplicate, unordered or unknown IDs");
    require_ok(terra_retain_meshes(context.get(), &receipt, mixed, 2U),
               "retain old and newly submitted meshes after invalid atomic batches");
    terra_frame_v1 after_retention{};
    after_retention.struct_size = sizeof(after_retention);
    require_ok(terra_get_frame(context.get(), &after_retention), "candidate after local retention");
    require(after_retention.sequence == coarse.sequence && after_retention.draw_count == coarse.draw_count,
            "mixed display ownership acknowledged or changed the complete candidate");

    // Replace the unacknowledged candidate. Neither mixed display resource is
    // in this unavailable level-two cut; both must have independent ownership.
    require_ok(terra_set_planar_level(context.get(), 2U), "advance beyond mixed display");
    require_ok(terra_update(context.get(), 0.005F), "replace unsubmitted candidate");
    terra_frame_v1 successor{};
    successor.struct_size = sizeof(successor);
    require_ok(terra_get_frame(context.get(), &successor), "read successor");
    std::size_t successor_count = 1U;
    require_ok(terra_get_mesh_resources(context.get(), nullptr, 0U, &successor_count),
               "read empty successor resources");
    require(successor_count == 0U, "retention fixture unexpectedly loaded level two");
    receipt.sequence = successor.sequence;
    require_ok(terra_retain_meshes(context.get(), &receipt, mixed, 2U),
               "a mixed display must survive candidate replacement");
    require(terra_get_mesh_position_view(context.get(), old_id) != nullptr &&
            terra_get_mesh_position_view(context.get(), candidate_id) != nullptr,
            "mixed ownership lost old or new geometry");
    const auto dropped = previous_meshes[1].resource_id;
    require(terra_retain_meshes(context.get(), &receipt, &dropped, 1U) == TERRA_STATUS_INVALID_STATE,
            "an idle cached resource was mistaken for a display-owned mesh");
    require(terra_acquire_mesh_resource(nullptr, old_id) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_acquire_mesh_resource(context.get(), 0U) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_release_mesh_resource(nullptr, old_id) == TERRA_STATUS_INVALID_ARGUMENT &&
            terra_acquire_mesh_resource(context.get(), UINT32_MAX) == TERRA_STATUS_INVALID_STATE,
            "mesh loan accepted invalid arguments");
    const auto* loan_position = terra_get_mesh_position_view(context.get(), old_id);
    const auto* loan_texture = terra_get_mesh_texture_view(context.get(), old_id);
    const std::vector<float> loan_content(loan_position,
        loan_position + previous_meshes.front().position_float_count);
    require_ok(terra_acquire_mesh_resource(context.get(), old_id), "borrow old mesh");
    require_ok(terra_acquire_mesh_resource(context.get(), old_id), "second independent mesh borrower");
    require_ok(terra_retain_meshes(context.get(), &receipt, nullptr, 0U), "release mixed display");
    require(terra_retain_meshes(context.get(), &receipt, &old_id, 1U) != TERRA_STATUS_OK,
            "released display ownership was resurrected");
    require_ok(terra_present_frame(context.get(), &receipt), "complete successor frame receipt");
    require_ok(terra_trim_mesh_cache(context.get(), 0U), "trim while old mesh is borrowed");
    require(terra_get_mesh_position_view(context.get(), old_id) == loan_position &&
            terra_get_mesh_texture_view(context.get(), old_id) == loan_texture &&
            std::equal(loan_content.begin(), loan_content.end(), loan_position),
            "trim or candidate replacement mutated a borrowed mesh");
    const auto loan_bytes = (previous_meshes.front().position_float_count +
        previous_meshes.front().texture_float_count) * sizeof(float);
    require(terra_mesh_payload_bytes(context.get()) == loan_bytes,
            "loan counted duplicate bytes or retained unrelated mesh payloads");
    require(terra_load_terrain_manifest(context.get(), &manifest) == TERRA_STATUS_INVALID_STATE,
            "manifest reset invalidated live mesh loans");
    require_ok(terra_release_mesh_resource(context.get(), old_id), "release first mesh borrower");
    require_ok(terra_trim_mesh_cache(context.get(), 0U), "trim with final borrower");
    require(terra_mesh_payload_bytes(context.get()) == loan_bytes, "first release freed another borrower's mesh");
    require_ok(terra_release_mesh_resource(context.get(), old_id), "release final mesh borrower");
    require_ok(terra_trim_mesh_cache(context.get(), 0U), "trim after final release");
    require(terra_mesh_payload_bytes(context.get()) == 0U &&
            terra_get_mesh_position_view(context.get(), old_id) == nullptr,
            "released mesh loan leaked payload");
    require(terra_release_mesh_resource(context.get(), old_id) == TERRA_STATUS_INVALID_STATE,
            "unbalanced mesh release succeeded");
    require_ok(terra_load_terrain_manifest(context.get(), &manifest), "reset after loan release");

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
