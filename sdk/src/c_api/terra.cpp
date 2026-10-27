#include <terra/c_api/terra.h>
#include "mesh_source.hpp"
#include "mesh_payload.hpp"
#include "surface_measurement_store.hpp"

#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/atmosphere.hpp>
#include <terra/core/grid.hpp>
#include <terra/core/metadata.hpp>
#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/frame_packet.hpp>
#include <terra/frame/height_query.hpp>
#include <terra/frame/height_session.hpp>
#include <terra/frame/height_storage.hpp>
#include <terra/frame/record_storage.hpp>
#include <terra/frame/imagery.hpp>
#include <terra/frame/imagery_input.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/mesh.hpp>
#include <terra/frame/surface_mesh.hpp>
#include <terra/frame/surface_replacement.hpp>
#include <terra/imagery/adapter.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <limits>
#include <map>
#include <memory>
#include <new>
#include <set>
#include <string>
#include <utility>
#include <vector>

struct terra_loaded_record {
  std::uint32_t kind = 0U;
  terra_patch_key_v1 key{};
  terra::frame::record_storage::handle samples;
  const terra::codec::height_patch& values() const { return samples->value(); }
  std::uint64_t last_used_sequence = 0U;
};

struct terra_surface_key {
  terra_patch_key_v1 patch{};
  std::uint8_t fragment = 0U;
};

struct terra_surface_key_less {
  bool operator()(const terra_surface_key& left,
                  const terra_surface_key& right) const {
    if (left.patch.level != right.patch.level) {
      return left.patch.level < right.patch.level;
    }
    if (left.patch.i != right.patch.i) {
      return left.patch.i < right.patch.i;
    }
    if (left.patch.j != right.patch.j) {
      return left.patch.j < right.patch.j;
    }
    if (left.patch.k != right.patch.k) {
      return left.patch.k < right.patch.k;
    }
    return left.fragment < right.fragment;
  }
};

struct terra_mesh_resource {
  explicit terra_mesh_resource(const terra::c_api_detail::mesh_payload& payload)
      : position_allocation(payload.owner()) {}
  // Arrays retire before this count, including failure and cancellation paths.
  terra::c_api_detail::mesh_payload::allocation position_allocation;
  std::uint32_t id = 0U;
  std::uint64_t texture_id = 0U;
  terra::frame::patch_surface_mesh mesh;
  // Shared by exact layout identity, immutable once populated. Planning owns
  // only the empty resource; payload production still requires native credit.
  std::shared_ptr<terra::c_api_detail::mesh_texture> texture_uv;
};

struct terra_cached_surface {
  std::shared_ptr<terra_mesh_resource> resource;
  std::uint64_t last_used_sequence = 0U;
};

struct patch_key_less {
  bool operator()(const terra_patch_key_v1& left,
                  const terra_patch_key_v1& right) const {
    if (left.level != right.level) {
      return left.level < right.level;
    }
    if (left.i != right.i) {
      return left.i < right.i;
    }
    if (left.j != right.j) {
      return left.j < right.j;
    }
    return left.k < right.k;
  }
};

struct terra_height {
  // Model metadata is local; prepared publications share immutable samples.
  terra::frame::height_storage::handle samples;
  bool has_fragment(std::size_t fragment) const { return samples && samples->has_fragment(fragment); }
  terra::core::grid_diamond diamond;
  double minimum_height = 0.0;
  double maximum_height = 0.0;
  bool range_valid = false;
  std::array<std::uint64_t, 2U> content_revision{{0U, 0U}};
  std::array<std::uint32_t, 2U> data_level{{0U, 0U}};
  std::array<double, 2U> data_spacing{{0.0, 0.0}};
};
using height_map = std::map<terra_patch_key_v1, terra_height, patch_key_less>;

struct terra_mesh_output {
  std::size_t position_float_count = 0U;
  std::size_t texture_float_count = 0U;
  std::vector<std::shared_ptr<terra_mesh_resource>> frame_surfaces;
  std::vector<terra_mesh_resource_v3> mesh_resources;
};

struct terra_replacement_input {
  std::shared_ptr<terra_mesh_resource> resource;
  bool after = false;
  bool retained = false;
};

struct terra_mesh_target {
  terra_mesh_resource_v3 description{};
  terra::frame::lod_patch patch;
  std::weak_ptr<terra_mesh_resource> resource;
};

struct terra_replacement_history {
  std::uint64_t model_revision = 0U;
  terra_frame_v1 frame{};
  std::vector<terra_mesh_target> target;
  std::vector<terra::frame::replacement_member> members;
};

struct terra_prepared_mesh_frame {
  terra_mesh_plan_v1 description{};
  terra_mesh_output output;
  std::vector<terra_patch_decision_v1> patches;
  std::uint64_t height_revision = 0U;
  std::map<terra_patch_key_v1, std::shared_ptr<const terra::frame::height_storage::block>, patch_key_less> height_inputs;
  std::vector<terra_replacement_input> replacement_inputs;
  std::unique_ptr<terra::frame::surface_replacement_plan> replacement;
  std::size_t replacement_cursor = 0U;
  bool replacement_complete = false;
  bool replacement_sealed = false;
  std::vector<terra::frame::replacement_member> replacement_members;
  std::vector<terra_mesh_target> target;
  terra_frame_v1 target_frame{};
  bool production_started = false;
  std::size_t production_cursor = 0U;
  std::uint32_t production_credit = 0U;
};

// Selection is immutable while height production yields for time or credit.
// Payload belongs to height_storage; this work owns only its dependency cursor.
struct terra_terrain_work {
  terra::frame::camera_snapshot snapshot;
  terra::frame::lod_cut cut;
  std::vector<terra::frame::record_storage::handle> inputs;
  terra::frame::lod_update_budget budget;
  float threshold = 0.0F;
  std::size_t maximum_mesh_bytes = 0U, cursor = 0U, next_bytes = 0U;
  bool incremental = false, progress = false, prepared = false;
};

struct terra_imagery_input {
  terra::frame::imagery_input_work storage;
  terra::frame::imagery_budget budget;
  bool reset_history = false;
};

struct terra_imagery_session {
  std::uint32_t id = 0U;
  terra::frame::imagery_controller controller;
  terra_imagery_quality_v4 quality{};
  std::shared_ptr<const std::vector<terra::frame::imagery_draw>> snapshot;
  std::uint64_t draw_revision = 0U;
  terra_imagery_input input;
};

struct terra_context {
  terra_terrain_manifest_v3 manifest{};
  terra_viewport_v1 viewport{};
  terra_camera_v3 camera{};
  bool manifest_loaded = false;
  bool viewport_set = false;
  bool camera_set = false;
  double globe_target_longitude_degrees = 0.0;
  double globe_target_latitude_degrees = 0.0;
  double planar_target_x = 0.0;
  double planar_target_y = 0.0;
  bool planar_target_set = false;
  std::uint32_t planar_level = 0U;
  std::uint64_t sequence = 0U;
  bool incremental_updates = false;
  std::size_t terrain_mesh_capacity = 32U * 1024U * 1024U;
  terra::frame::record_storage record_storage{terrain_mesh_capacity};
  std::uint32_t record_work_limit = static_cast<std::uint32_t>(terrain_mesh_capacity);
  std::vector<terra_loaded_record> loaded_records;
  std::vector<terra_request_v1> failed_records;
  std::vector<terra_request_v1> requests;
  std::vector<terra_request_v1> recent_requests;
  std::vector<terra_request_v1> record_references;
  std::vector<terra_patch_decision_v1> patches;
  terra::c_api_detail::mesh_payload mesh_payload;
  terra_mesh_output output;
  std::unique_ptr<terra_prepared_mesh_frame> prepared_mesh;
  std::unique_ptr<terra_replacement_history> replacement_history;
  std::uint32_t next_mesh_plan_id = 1U;
  std::vector<std::shared_ptr<terra_mesh_resource>> presented_surfaces;
  std::map<std::uint32_t, std::weak_ptr<terra_mesh_resource>> mesh_registry;
  std::map<std::uint64_t, std::weak_ptr<terra::c_api_detail::mesh_texture>> texture_registry;
  std::map<std::uint32_t, std::pair<std::shared_ptr<terra_mesh_resource>, std::uint32_t>> mesh_loans;
  std::map<terra_surface_key, std::weak_ptr<terra_mesh_resource>,
           terra_surface_key_less> live_surfaces;
  std::uint32_t next_mesh_id = 1U;
  std::uint64_t model_revision = 0U;
  terra_update_state_v2 update_state{};
  terra::frame::lod_resource_state terrain_resources;
  std::uint64_t record_revision = 1U;
  terra::frame::height_storage height_storage{2U * terrain_mesh_capacity};
  height_map heights;
  std::unique_ptr<terra_terrain_work> terrain_work;
  terra::frame::lod_cut height_active_cut;
  bool height_active_refine_leaves = true;
  std::uint32_t height_work_limit = static_cast<std::uint32_t>(2U * terrain_mesh_capacity);
  std::uint32_t height_work_builds = UINT32_MAX;
  std::set<terra_patch_key_v1, patch_key_less> procedural_details;
  std::set<terra_patch_key_v1, patch_key_less> confirmed_no_data;
  terra::frame::record_storage::handle zero_detail;
  std::size_t terrain_mesh_budget = terrain_mesh_capacity;
  std::uint64_t height_revision = 1U;
  std::map<terra_patch_key_v1, std::uint8_t, patch_key_less> height_refinements;
  std::map<terra_patch_key_v1, std::uint64_t, patch_key_less> height_last_used;
  std::size_t height_cache_bytes = 0U;
  std::uint32_t height_build_count = 0U;
  std::unique_ptr<terra::frame::height_session> height_query;
  std::uint32_t height_query_id = 0U, next_height_query_id = 1U;
  std::vector<std::uint16_t> index_buffer;
  std::map<terra_surface_key, terra_cached_surface,
           terra_surface_key_less> surface_cache;
  terra_frame_v1 frame{};
  std::vector<std::int64_t> model_signature;
  std::size_t surface_cache_bytes = 0U;
  std::map<const terra::c_api_detail::mesh_texture*, std::size_t> cached_texture_references;
  terra_stats_v1 stats{};
  terra::frame::cylindrical_lod_controller globe_lod;
  terra::c_api_detail::surface_measurement_store surface_measurements;
  std::array<std::unique_ptr<terra_imagery_session>, TERRA_IMAGERY_SESSION_LIMIT> imagery_sessions;
  std::uint32_t next_imagery_session_id = 1U;
  mutable std::string last_error;
};

namespace {

constexpr std::size_t maximum_cached_surface_count = 512U;

terra_status fail(const terra_context* context, terra_status status,
                  const char* message) {
  if (context != nullptr) {
    context->last_error = message == nullptr ? "" : message;
  }
  return status;
}

terra_status succeed(const terra_context* context) {
  if (context != nullptr) {
    context->last_error.clear();
  }
  return TERRA_STATUS_OK;
}

template <typename value_t>
bool valid_input(const value_t* value) {
  return value != nullptr && value->struct_size >= sizeof(value_t);
}

bool valid_key(const terra_patch_key_v1& key) {
  if (key.level >= 40U) {
    return false;
  }
  const std::int32_t minimum = terra::core::grid_coordinate_min;
  const std::int32_t maximum = terra::core::grid_coordinate_max;
  return key.i >= minimum && key.i <= maximum && key.j >= minimum &&
         key.j <= maximum && key.k >= minimum && key.k <= maximum;
}

bool same_key(const terra_patch_key_v1& left,
              const terra_patch_key_v1& right) {
  return left.level == right.level && left.i == right.i &&
         left.j == right.j && left.k == right.k;
}

bool valid_record_kind(std::uint32_t kind) {
  return kind == TERRA_REQUEST_ROOT || kind == TERRA_REQUEST_DETAIL;
}

bool same_record(const terra_loaded_record& record, std::uint32_t kind,
                 const terra_patch_key_v1& key) {
  return record.kind == kind && same_key(record.key, key);
}

const terra_loaded_record* find_record(const terra_context& context,
                                       std::uint32_t kind,
                                       const terra_patch_key_v1& key) {
  const auto found = std::find_if(
      context.loaded_records.begin(), context.loaded_records.end(),
      [kind, &key](const terra_loaded_record& record) {
        return same_record(record, kind, key);
      });
  return found == context.loaded_records.end() ? nullptr : &*found;
}

const terra_request_v1* find_failed_record(
    const terra_context& context, std::uint32_t kind,
    const terra_patch_key_v1& key) {
  const auto found = std::find_if(
      context.failed_records.begin(), context.failed_records.end(),
      [kind, &key](const terra_request_v1& request) {
        return request.kind == kind && same_key(request.key, key);
      });
  return found == context.failed_records.end() ? nullptr : &*found;
}

bool erase_failed_record(terra_context& context, std::uint32_t kind,
                         const terra_patch_key_v1& key) {
  const auto found = std::find_if(
      context.failed_records.begin(), context.failed_records.end(),
      [kind, &key](const terra_request_v1& request) {
        return request.kind == kind && same_key(request.key, key);
      });
  if (found == context.failed_records.end()) {
    return false;
  }
  context.failed_records.erase(found);
  return true;
}

const terra_request_v1* find_request(const terra_context& context,
                                     std::uint32_t kind,
                                     const terra_patch_key_v1& key) {
  const auto found = std::find_if(
      context.requests.begin(), context.requests.end(),
      [kind, &key](const terra_request_v1& request) {
        return request.kind == kind && same_key(request.key, key);
      });
  if (found != context.requests.end()) return &*found;
  const auto recent = std::find_if(context.recent_requests.begin(), context.recent_requests.end(),
      [kind, &key](const terra_request_v1& request) {
        return request.kind == kind && same_key(request.key, key);
      });
  return recent == context.recent_requests.end() ? nullptr : &*recent;
}


void remember_request(terra_context& context, const terra_request_v1& request) {
  // An asynchronous result remains authorized after the next cut changes its
  // request frontier. Keep bounded metadata; decoded data retains its own cap.
  auto& recent = context.recent_requests;
  const auto found = std::find_if(recent.begin(), recent.end(),
      [&request](const terra_request_v1& value) {
        return value.kind == request.kind && same_key(value.key, request.key);
      });
  if (found != recent.end()) recent.erase(found);
  else if (recent.size() == 1024U) recent.erase(recent.begin());
  recent.push_back(request);
}


terra::core::dataset_metadata to_metadata(const terra_terrain_manifest_v3& manifest) {
  terra::core::dataset_metadata metadata;
  metadata.format_version = manifest.format_version;
  metadata.patch_dimension = manifest.patch_dimension;
  metadata.height_scale_factor = manifest.height_scale_factor;
  metadata.srs = "typed-c-api";
  metadata.about = "Terra C API dataset";
  metadata.transform = manifest.transform == TERRA_TRANSFORM_PLANAR
                           ? terra::core::coordinate_transform_kind::planar
                           : terra::core::coordinate_transform_kind::cylindrical;
  metadata.bounds = terra::core::bounds2d(
      terra::core::vector2d{{manifest.minimum_u, manifest.minimum_v}},
      terra::core::vector2d{{manifest.maximum_u, manifest.maximum_v}});
  metadata.radius = manifest.radius;
  return metadata;
}

terra_patch_key_v1 to_key(const terra::frame::lod_patch& patch) {
  terra_patch_key_v1 result{};
  result.level = static_cast<std::uint32_t>(patch.level);
  result.i = patch.id[0];
  result.j = patch.id[1];
  result.k = patch.id[2];
  return result;
}

struct active_record_key {
  std::uint32_t kind = 0U;
  terra_patch_key_v1 key{};
};

struct active_record_key_less {
  bool operator()(const active_record_key& left,
                  const active_record_key& right) const {
    if (left.kind != right.kind) {
      return left.kind < right.kind;
    }
    return patch_key_less()(left.key, right.key);
  }
};

using active_record_set =
    std::set<active_record_key, active_record_key_less>;
using loaded_record_index =
    std::map<active_record_key, const terra_loaded_record*,
             active_record_key_less>;

active_record_key make_active_record_key(
    std::uint32_t kind, const terra_patch_key_v1& key) {
  active_record_key result;
  result.kind = kind;
  result.key = key;
  return result;
}

loaded_record_index index_loaded_records(const terra_context& context) {
  loaded_record_index result;
  for (const terra_loaded_record& record : context.loaded_records) {
    result.emplace(make_active_record_key(record.kind, record.key), &record);
  }
  return result;
}

void prune_inactive_records(terra_context& context,
                            const terra::frame::lod_cut& cut) {
  const std::size_t previous_loaded = context.loaded_records.size();
  const std::size_t previous_failed = context.failed_records.size();
  active_record_set active;
  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    active_record_key key;
    key.kind = request.kind == terra::frame::lod_record_kind::root
                   ? TERRA_REQUEST_ROOT
                   : TERRA_REQUEST_DETAIL;
    key.key = to_key(request.patch);
    active.insert(key);
  }
  std::size_t bytes = context.record_storage.resident_bytes();
  for (auto& record : context.loaded_records) {
    if (active.count(make_active_record_key(record.kind, record.key)) != 0U) {
      record.last_used_sequence = context.sequence + 1U;
    }
  }
  // Decoded idle records are reusable across camera revisions. The active
  // dependency closure is protected; pressure is handled by the cut planner.
  const auto cache_budget = context.record_storage.maximum_bytes();
  if (!context.incremental_updates) {
    context.loaded_records.erase(std::remove_if(context.loaded_records.begin(), context.loaded_records.end(),
        [&active](const terra_loaded_record& record) {
          return active.count(make_active_record_key(record.kind, record.key)) == 0U;
        }), context.loaded_records.end());
    bytes = context.record_storage.resident_bytes();
    context.failed_records.erase(std::remove_if(context.failed_records.begin(), context.failed_records.end(),
        [&active](const terra_request_v1& request) {
          return active.count(make_active_record_key(request.kind, request.key)) == 0U;
        }), context.failed_records.end());
  }
  while (bytes > cache_budget) {
    auto oldest = context.loaded_records.end();
    for (auto it = context.loaded_records.begin(); it != context.loaded_records.end(); ++it) {
      if (active.count(make_active_record_key(it->kind, it->key)) != 0U) continue;
      if (oldest == context.loaded_records.end() ||
          it->last_used_sequence < oldest->last_used_sequence) oldest = it;
    }
    if (oldest == context.loaded_records.end()) break;
    context.loaded_records.erase(oldest);
    bytes = context.record_storage.resident_bytes();
  }
  // A terminal absence belongs to the dataset, rather than to one camera.
  while (context.failed_records.size() > 4096U) {
    const auto oldest = std::find_if(context.failed_records.begin(), context.failed_records.end(),
        [&active](const terra_request_v1& request) {
          return active.count(make_active_record_key(request.kind, request.key)) == 0U;
        });
    if (oldest == context.failed_records.end()) break;
    context.failed_records.erase(oldest);
  }
  context.stats.loaded_patch_count = context.loaded_records.size();
  if (previous_loaded != context.loaded_records.size() ||
      previous_failed != context.failed_records.size()) {
    ++context.record_revision;
  }
  context.stats.decoded_value_count = 0U;
  for (const terra_loaded_record& record : context.loaded_records) {
    context.stats.decoded_value_count += record.values().values.size();
  }
}

terra::core::grid_diamond to_diamond(const terra::frame::lod_patch& patch);

std::size_t height_sample_bytes(const terra::codec::height_diamond& height) {
  return (height.fragments[0U].values.capacity() + height.fragments[1U].values.capacity()) * sizeof(std::int32_t);
}

std::size_t height_payload_bytes(const terra_context& context) {
  return context.height_storage.resident_bytes();
}

bool refine_leaf_heights(const terra_terrain_work& work) {
  return !work.budget.coarsening_only &&
      (!work.incremental || work.budget.maximum_change_count != 0U);
}

bool needs_detail_heights(const terra::frame::lod_cut& cut,
                          const terra::frame::lod_patch& request, bool refine_leaves) {
  return refine_leaves || std::none_of(cut.patches.begin(), cut.patches.end(),
      [&](const terra::frame::lod_patch& patch) {
        return patch.level == request.level && patch.id == request.id;
      });
}

std::set<terra_patch_key_v1, patch_key_less> height_dependency_keys(
    const terra_context& context, const terra::frame::lod_cut& cut, bool refine_leaves) {
  std::set<terra_patch_key_v1, patch_key_less> active, leaves;
  if (!refine_leaves) for (const auto& patch : cut.patches) leaves.insert(to_key(patch));
  for (const auto& request : cut.record_requests) {
    active.insert(to_key(request.patch));
    if (request.kind != terra::frame::lod_record_kind::detail ||
        leaves.count(to_key(request.patch)) ||
        (find_record(context, TERRA_REQUEST_DETAIL, to_key(request.patch)) == nullptr &&
         !context.procedural_details.count(to_key(request.patch)))) continue;
    const auto diamond = to_diamond(request.patch);
    for (std::size_t f = 0U; f < 2U; ++f) {
      if (!request.patch.has_fragment(f)) continue;
      for (std::size_t c = 0U; c < 2U; ++c) {
        const auto child = context.manifest.transform == TERRA_TRANSFORM_PLANAR
            ? diamond.planar_child_diamond(f, c) : diamond.cylindrical_child_diamond(f, c);
        const auto id = child.id();
        active.insert({static_cast<std::uint32_t>(request.patch.level + 1U), id[0], id[1], id[2]});
      }
    }
  }
  for (const auto& patch : cut.patches) active.insert(to_key(patch));
  return active;
}

void prune_height_cache(terra_context& context,
                         const terra::frame::lod_cut& cut,
                         std::size_t incoming_bytes = 0U, bool refine_leaves = true) {
  const auto active = height_dependency_keys(context, cut, refine_leaves);
  std::size_t bytes = height_payload_bytes(context);
  for (const auto& height : context.heights) {
    if (active.count(height.first) != 0U) {
      context.height_last_used[height.first] = context.sequence + 1U;
    }
  }
  const auto maximum = context.height_storage.maximum_bytes();
  const std::size_t cache_budget = maximum - std::min(maximum, incoming_bytes);
  while (bytes > cache_budget) {
    auto oldest = context.heights.end();
    std::uint64_t oldest_sequence = UINT64_MAX;
    for (auto it = context.heights.begin(); it != context.heights.end(); ++it) {
      if (active.count(it->first) != 0U || !it->second.samples.unique()) continue;
      const auto sequence = context.height_last_used.find(it->first);
      const auto used = sequence == context.height_last_used.end() ? 0U : sequence->second;
      if (oldest == context.heights.end() || used < oldest_sequence) {
        oldest = it; oldest_sequence = used;
      }
    }
    if (oldest == context.heights.end()) break;
    bytes -= height_sample_bytes(oldest->second.samples->value());
    if (oldest->first.level > 0U) {
      const auto& diamond = oldest->second.diamond;
      for (std::size_t f = 0U; f < 2U; ++f) {
        const auto id = diamond.parent_id(f);
        context.height_refinements.erase({oldest->first.level - 1U, id[0], id[1], id[2]});
      }
    }
    context.height_last_used.erase(oldest->first);
    context.height_refinements.erase(oldest->first);
    if (!context.confirmed_no_data.count(oldest->first) && context.procedural_details.erase(oldest->first))
      ++context.record_revision;
    ++context.height_revision;
    context.heights.erase(oldest);
  }
  while (context.confirmed_no_data.size() > 4096U) {
    const auto oldest = std::find_if(context.confirmed_no_data.begin(), context.confirmed_no_data.end(),
        [&active](const terra_patch_key_v1& key) { return active.count(key) == 0U; });
    if (oldest == context.confirmed_no_data.end()) break;
    context.procedural_details.erase(*oldest);
    context.confirmed_no_data.erase(oldest);
    ++context.record_revision;
  }
  context.height_cache_bytes = bytes;
}

bool admit_decoded_record(terra_context& context, std::size_t incoming) {
  const auto capacity = context.record_storage.maximum_bytes();
  if (incoming > capacity) return false;
  std::size_t bytes = incoming + context.record_storage.resident_bytes();
  while (bytes > capacity) {
    auto oldest = context.loaded_records.end();
    for (auto it = context.loaded_records.begin(); it != context.loaded_records.end(); ++it) {
      const bool active = std::any_of(context.record_references.begin(), context.record_references.end(),
          [&](const terra_request_v1& ref) { return ref.kind == it->kind && same_key(ref.key, it->key); });
      if (!active && (oldest == context.loaded_records.end() || it->last_used_sequence < oldest->last_used_sequence)) oldest = it;
    }
    if (oldest == context.loaded_records.end()) return false;
    context.stats.decoded_value_count -= oldest->values().values.size();
    context.loaded_records.erase(oldest);
    bytes = incoming + context.record_storage.resident_bytes();
    context.stats.loaded_patch_count = context.loaded_records.size();
    ++context.record_revision;
  }
  return true;
}

void attach_mesh_texture(terra_context& context, terra_mesh_resource& resource) {
  if (resource.texture_uv) return;
  terra::frame::texture_grid_pattern pattern;
  const auto& m = context.manifest;
  const bool regular = m.transform == TERRA_TRANSFORM_CYLINDRICAL &&
      terra::frame::describe_cylindrical_texture_pattern(
          resource.mesh.patch, resource.mesh.fragment, m.patch_dimension, pattern);
  // Nonregular and planar layouts retain independent identities under the same
  // ownership contract. They must never alias based solely on triangle corners.
  const std::uint64_t key = regular ? pattern.dimension * 8U + pattern.orientation
      : (UINT64_C(1) << 32U) + resource.id;
  resource.texture_id = key;
  auto& weak = context.texture_registry[key];
  resource.texture_uv = weak.lock();
  if (!resource.texture_uv) weak = resource.texture_uv =
      std::make_shared<terra::c_api_detail::mesh_texture>(context.mesh_payload);
}

void prune_texture_registry(terra_context& context) {
  for (auto it = context.texture_registry.begin(); it != context.texture_registry.end();)
    if (it->second.expired()) it = context.texture_registry.erase(it); else ++it;
}

std::size_t mesh_payload_bytes(const terra_context& context) {
  return context.mesh_payload.bytes();
}

using surface_cache_iterator = decltype(terra_context::surface_cache)::iterator;

surface_cache_iterator erase_cached_surface(terra_context& context, surface_cache_iterator it) {
  const auto& resource = *it->second.resource;
  context.surface_cache_bytes -= resource.mesh.positions_xyz.capacity() * sizeof(float);
  const auto count = context.cached_texture_references.find(resource.texture_uv.get());
  if (--count->second == 0U) {
    context.surface_cache_bytes -= resource.texture_uv->values.capacity() * sizeof(float);
    context.cached_texture_references.erase(count);
  }
  return context.surface_cache.erase(it);
}

// Only used when the cache is this mesh's final owner. UV can outlive it through
// any other mesh, including an unmaterialized candidate or a native loan.
std::size_t reclaimable_surface_bytes(const terra_mesh_resource& resource) {
  return (resource.mesh.positions_xyz.capacity() +
      (resource.texture_uv.unique() ? resource.texture_uv->values.capacity() : 0U)) * sizeof(float);
}

bool prune_surface_cache(terra_context& context,
                         const terra_mesh_resource& incoming) {
  const auto maximum_cached_surface_bytes = context.terrain_mesh_capacity;
  const auto incoming_bytes = [&]() {
    return (incoming.mesh.positions_xyz.capacity() +
        (context.cached_texture_references.count(incoming.texture_uv.get()) ? 0U
          : incoming.texture_uv->values.capacity())) * sizeof(float);
  };
  if (incoming_bytes() > maximum_cached_surface_bytes) {
    return false;
  }
  while (!context.surface_cache.empty() &&
         (context.surface_cache.size() >= maximum_cached_surface_count ||
          context.surface_cache_bytes >
              maximum_cached_surface_bytes - incoming_bytes())) {
    auto least_recent = context.surface_cache.end();
    for (auto iterator = context.surface_cache.begin();
         iterator != context.surface_cache.end(); ++iterator) {
      if (iterator->second.last_used_sequence == context.sequence + 1U ||
          iterator->second.resource.use_count() > 1) continue;
      if (least_recent == context.surface_cache.end() ||
          iterator->second.last_used_sequence < least_recent->second.last_used_sequence) {
        least_recent = iterator;
      }
    }
    // Never evict a surface needed later in this same frame. A working set
    // larger than the cache otherwise rebuilds every mesh on every update.
    if (least_recent == context.surface_cache.end()) return false;
    erase_cached_surface(context, least_recent);
  }
  return true;
}

terra::core::grid_diamond to_diamond(
    const terra::frame::lod_patch& patch) {
  return terra::core::grid_diamond(
      patch.corners[0], patch.corners[1],
      patch.corners[2], patch.corners[3]);
}

std::size_t fragment_from_parent(
    const terra::core::grid_diamond& child,
    const terra::core::grid_point& parent) {
  return child.corner(1U) == parent ? 0U : 1U;
}

terra_status map_hierarchy_status(terra::codec::hierarchy_status status) {
  switch (status) {
    case terra::codec::hierarchy_status::ok:
      return TERRA_STATUS_OK;
    case terra::codec::hierarchy_status::resource_limit:
      return TERRA_STATUS_RESOURCE_LIMIT;
    case terra::codec::hierarchy_status::invalid_shape:
    case terra::codec::hierarchy_status::missing_fragment:
    case terra::codec::hierarchy_status::arithmetic_overflow:
      return TERRA_STATUS_DECODE_ERROR;
  }
  return TERRA_STATUS_INTERNAL_ERROR;
}

template <typename value_t>
void reserve_frame_output(std::vector<value_t>& values,
                          std::size_t required_count) {
  const std::size_t minimum_headroom = 1024U;
  const std::size_t retained_threshold =
      (1024U * 1024U) / sizeof(value_t);
  const bool enough = values.capacity() >= required_count;
  const std::size_t allowed_surplus =
      std::max(required_count / 2U, minimum_headroom);
  const bool excessive = enough &&
      values.capacity() > retained_threshold &&
      values.capacity() - required_count > allowed_surplus;
  if (enough && !excessive) {
    return;
  }
  if (required_count == 0U) {
    std::vector<value_t>().swap(values);
    return;
  }
  const std::size_t headroom =
      std::max(required_count / 4U, minimum_headroom);
  const std::size_t maximum =
      std::numeric_limits<std::size_t>::max();
  const std::size_t reserve_count = required_count > maximum - headroom
      ? required_count
      : required_count + headroom;
  std::vector<value_t>().swap(values);
  values.reserve(reserve_count);
}

void update_height_range(terra_context& context, const terra_patch_key_v1& key) {
  auto& height = context.heights.at(key);
  double minimum = std::numeric_limits<double>::infinity();
  double maximum = -minimum;
  for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!height.has_fragment(fragment)) continue;
    for (const auto value : height.samples->value().fragments[fragment].values) {
      const double metres = value * context.manifest.height_scale_factor;
      minimum = std::min(minimum, metres);
      maximum = std::max(maximum, metres);
    }
  }
  if (minimum <= maximum) {
    height.minimum_height = minimum;
    height.maximum_height = maximum;
    height.range_valid = true;
    ++context.height_revision;
  }
}

double query_spacing(const terra_context& context,
                     const terra::core::grid_diamond& diamond, std::size_t fragment) {
  const auto& m = context.manifest;
  return terra::frame::height_sample_spacing(diamond, fragment, m.patch_dimension,
      m.transform == TERRA_TRANSFORM_CYLINDRICAL,
      terra::core::bounds2d({{m.minimum_u, m.minimum_v}}, {{m.maximum_u, m.maximum_v}}), m.radius);
}

terra_status prepare_terrain_heights(
    terra_context& context, terra_terrain_work& work) {
  const auto& cut = work.cut;
  const auto initial_bytes = height_payload_bytes(context);
  std::uint32_t builds = 0U, scanned = 0U;
  const auto admit = [&](std::size_t bytes) {
    work.next_bytes = bytes;
    const auto current = height_payload_bytes(context);
    const auto growth = current > initial_bytes ? current - initial_bytes : 0U;
    if (builds >= context.height_work_builds || growth > context.height_work_limit ||
        bytes > context.height_work_limit - growth) return false;
    ++builds;
    return true;
  };
  height_map& heights = context.heights;
  for (; work.cursor < cut.record_requests.size(); ++work.cursor) {
    work.next_bytes = 0U;
    if (context.height_work_builds != UINT32_MAX && scanned++ == 64U)
      return TERRA_STATUS_WORK_PENDING;
    const auto& request = cut.record_requests[work.cursor];
    const terra_patch_key_v1 key = to_key(request.patch);
    const std::uint32_t kind =
        request.kind == terra::frame::lod_record_kind::root
            ? TERRA_REQUEST_ROOT
            : TERRA_REQUEST_DETAIL;
    // A paused topology slice still requests its bounded frontier, but only
    // reconstructs heights needed by the selected surface. Speculative leaf
    // children resume with refinement credit; ancestors and roots stay usable.
    if (kind == TERRA_REQUEST_DETAIL &&
        !needs_detail_heights(cut, request.patch, refine_leaf_heights(work))) continue;
    const auto& record = work.inputs[work.cursor];
    const bool procedural = kind == TERRA_REQUEST_DETAIL && context.procedural_details.count(key) != 0U;
    if (record == nullptr && !procedural) {
      continue;
    }

    if (kind == TERRA_REQUEST_ROOT) {
      context.height_last_used[key] = context.sequence + 1U;
      if (heights.count(key) != 0U) continue;
      terra::frame::height_storage::handle root;
      const auto required = 2U * terra::frame::height_storage::fragment_bytes(context.manifest.patch_dimension);
      if (!admit(required)) return TERRA_STATUS_WORK_PENDING;
      if (height_payload_bytes(context) + required > context.height_storage.maximum_bytes())
        prune_height_cache(context, cut, required, refine_leaf_heights(work));
      const terra::codec::hierarchy_status status =
          context.height_storage.root(record->value(), root);
      if (status != terra::codec::hierarchy_status::ok) {
        return fail(&context, status == terra::codec::hierarchy_status::resource_limit
                        ? TERRA_STATUS_CAPACITY_PENDING : map_hierarchy_status(status),
                    terra::codec::hierarchy_status_message(status));
      }
      heights[key].samples = std::move(root);
      heights[key].diamond = to_diamond(request.patch);
      for (std::size_t f = 0U; f < 2U; ++f) {
        heights[key].data_spacing[f] = query_spacing(context, heights[key].diamond, f);
      }
      update_height_range(context, key);
      ++context.height_build_count;
      continue;
    }

    const height_map::iterator parent = heights.find(key);
    if (parent == heights.end() || !parent->second.samples) {
      continue;
    }

    context.height_last_used[key] = context.sequence + 1U;
    const terra::core::grid_diamond parent_diamond = to_diamond(request.patch);
    const std::uint8_t parent_mask = parent->second.samples->value().fragment_mask;
    bool retained_children = context.height_refinements[key] == parent_mask;
    for (std::size_t fragment = 0U; fragment < 2U && retained_children; ++fragment) {
      if (!parent->second.has_fragment(fragment)) continue;
      for (std::size_t child_index = 0U; child_index < 2U; ++child_index) {
        const auto child = context.manifest.transform == TERRA_TRANSFORM_PLANAR
            ? parent_diamond.planar_child_diamond(fragment, child_index)
            : parent_diamond.cylindrical_child_diamond(fragment, child_index);
        terra_patch_key_v1 child_key{};
        child_key.level = key.level + 1U;
        const auto id = child.id();
        child_key.i = id[0]; child_key.j = id[1]; child_key.k = id[2];
        const auto found = heights.find(child_key);
        const auto child_fragment = fragment_from_parent(child, request.patch.id);
        if (found == heights.end() || !found->second.has_fragment(child_fragment)) {
          retained_children = false;
        }
      }
    }
    if (retained_children) continue;
    std::size_t copied_bytes = 0U;
    for (std::size_t f = 0U; f < 2U; ++f) {
      if (!parent->second.has_fragment(f)) continue;
      for (std::size_t c = 0U; c < 2U; ++c) {
        const auto child = context.manifest.transform == TERRA_TRANSFORM_PLANAR
            ? parent_diamond.planar_child_diamond(f, c) : parent_diamond.cylindrical_child_diamond(f, c);
        const auto id = child.id();
        const auto found = heights.find({key.level + 1U, id[0], id[1], id[2]});
        if (found != heights.end()) copied_bytes += terra::frame::height_storage::copy_bytes(
            found->second.samples, fragment_from_parent(child, request.patch.id));
      }
    }
    const auto required = terra::frame::height_storage::refinement_bytes(parent->second.samples->value(), copied_bytes);
    if (!admit(required)) return TERRA_STATUS_WORK_PENDING;
    if (height_payload_bytes(context) + required > context.height_storage.maximum_bytes())
      prune_height_cache(context, cut, required, refine_leaf_heights(work));
    terra::frame::height_storage::refinement production;
    const terra::codec::hierarchy_status status =
        context.height_storage.refine(parent->second.samples->value(),
            procedural ? context.zero_detail->value() : record->value(), copied_bytes, production);
    if (status != terra::codec::hierarchy_status::ok) {
      return fail(&context, status == terra::codec::hierarchy_status::resource_limit
                      ? TERRA_STATUS_CAPACITY_PENDING : map_hierarchy_status(status),
                  terra::codec::hierarchy_status_message(status));
    }
    const auto& refinement = production.value();

    ++context.height_build_count;
    for (std::size_t parent_fragment = 0U; parent_fragment < 2U;
         ++parent_fragment) {
      for (std::size_t child_index = 0U; child_index < 2U;
           ++child_index) {
        if (!refinement.has_child(parent_fragment, child_index)) {
          continue;
        }
        const terra::core::grid_diamond child =
            context.manifest.transform == TERRA_TRANSFORM_PLANAR
                ? parent_diamond.planar_child_diamond(
                      parent_fragment, child_index)
                : parent_diamond.cylindrical_child_diamond(
                      parent_fragment, child_index);
        terra_patch_key_v1 child_key{};
        child_key.level = key.level + 1U;
        const terra::core::grid_point child_id = child.id();
        child_key.i = child_id[0];
        child_key.j = child_id[1];
        child_key.k = child_id[2];
        const std::size_t child_fragment =
            fragment_from_parent(child, request.patch.id);
        terra_height& child_height = heights[child_key];
        if (child_height.samples && child_height.samples->value().dimension != 0U &&
            child_height.samples->value().dimension != refinement.dimension) {
          return fail(&context, TERRA_STATUS_INTERNAL_ERROR,
                      "height hierarchy dimension mismatch");
        }
        const auto& incoming = refinement.children[2U * parent_fragment + child_index];
        const bool changed = !child_height.has_fragment(child_fragment) ||
            child_height.samples->value().fragments[child_fragment].values != incoming.values;
        if (changed) {
          terra_surface_key surface_key;
          surface_key.patch = child_key;
          surface_key.fragment = static_cast<std::uint8_t>(child_fragment);
          const auto cached = context.surface_cache.find(surface_key);
          if (cached != context.surface_cache.end()) {
            erase_cached_surface(context, cached);
          }
          context.live_surfaces.erase(surface_key);
          child_height.content_revision[child_fragment] = context.height_revision + 1U;
        }
        child_height.diamond = child;
        child_height.data_level[child_fragment] = procedural
            ? parent->second.data_level[parent_fragment] : child_key.level;
        child_height.data_spacing[child_fragment] = procedural
            ? parent->second.data_spacing[parent_fragment] : query_spacing(context, child, child_fragment);
        if (changed) {
          if (!context.height_storage.replace(child_height.samples, child_fragment,
                  production, 2U * parent_fragment + child_index))
            return fail(&context, TERRA_STATUS_INTERNAL_ERROR, "height output exceeded its admitted footprint");
        }
        context.height_last_used[child_key] = context.sequence + 1U;
        update_height_range(context, child_key);
        bool inherited_absence = true;
        for (std::size_t f = 0U; f < 2U; ++f) {
          const auto point = child.corner(2U * f + 1U);
          if (std::any_of(point.begin(), point.end(), [](std::int32_t v) {
            return v < terra::core::grid_coordinate_min || v > terra::core::grid_coordinate_max;
          })) continue;
          const auto id = child.parent_id(f);
          inherited_absence = inherited_absence && context.procedural_details.count(
              {key.level, id[0], id[1], id[2]}) != 0U;
        }
        if (inherited_absence) {
          if (context.procedural_details.insert(child_key).second) ++context.record_revision;
        } else if (!context.confirmed_no_data.count(child_key) && context.procedural_details.erase(child_key)) {
          ++context.record_revision;
        }
      }
    }
    context.height_refinements[key] = parent_mask;
  }
  work.next_bytes = 0U;
  return TERRA_STATUS_OK;
}

void update_model_revision(terra_context& context, const terra::frame::lod_cut& cut,
                           const loaded_record_index& loaded_records) {
  std::set<terra_patch_key_v1, patch_key_less> leaves;
  for (const auto& patch : cut.patches) leaves.insert(to_key(patch));
  height_map& heights = context.heights;
  std::vector<std::int64_t> signature;
  const auto append_signature = [&signature, &heights](const terra::frame::lod_patch& patch) {
    signature.push_back(patch.level);
    for (std::size_t axis = 0U; axis < 3U; ++axis) signature.push_back(patch.id[axis]);
    signature.push_back((patch.has_fragment(0U) ? 1 : 0) |
                        (patch.has_fragment(1U) ? 2 : 0));
    const auto height = heights.find(to_key(patch));
    for (std::size_t f = 0U; f < 2U; ++f)
      signature.push_back(height == heights.end() ? 0U : height->second.content_revision[f]);
  };
  for (const auto& request : cut.record_requests) {
    if (request.kind == terra::frame::lod_record_kind::root) {
      append_signature(request.patch);
      signature.push_back(loaded_records.count(make_active_record_key(
          TERRA_REQUEST_ROOT, to_key(request.patch))) != 0U);
    } else {
      // Pending detail for a leaf is not mesh content yet. Only dependency
      // records of already split diamonds affect the current surfaces.
      const bool leaf = leaves.count(to_key(request.patch)) != 0U;
      if (!leaf) {
        append_signature(request.patch);
        signature.push_back(loaded_records.count(make_active_record_key(
            TERRA_REQUEST_DETAIL, to_key(request.patch))) != 0U ||
            context.procedural_details.count(to_key(request.patch)) != 0U);
      }
    }
  }
  signature.push_back(-1);
  for (const auto& patch : cut.patches) if (patch.visible) append_signature(patch);
  if (signature != context.model_signature) {
    context.model_signature = std::move(signature);
    ++context.model_revision;
  }
}

void describe_mesh_costs(const terra_context& context, terra_prepared_mesh_frame& plan) {
  auto& description = plan.description;
  description.resident_mesh_bytes = mesh_payload_bytes(context);
  description.additional_mesh_bytes = 0U;
  description.reclaimable_mesh_bytes = 0U;
  std::set<std::uint32_t> counted;
  const auto dimension = context.manifest.patch_dimension;
  const std::size_t vertices = (dimension + 1U) * (dimension + 2U) / 2U;
  std::set<const terra::c_api_detail::mesh_texture*> textures;
  for (const auto& resource : plan.output.frame_surfaces) {
    if (counted.insert(resource->id).second && resource->mesh.positions_xyz.empty())
      description.additional_mesh_bytes += vertices * 3U * sizeof(float);
    if (textures.insert(resource->texture_uv.get()).second && resource->texture_uv->values.empty())
      description.additional_mesh_bytes += vertices * 2U * sizeof(float);
  }
  // Required resources are borrowed by the plan and therefore cannot be victims.
  std::map<const terra::c_api_detail::mesh_texture*, std::size_t> texture_victims;
  for (const auto& entry : context.surface_cache)
    if (entry.second.resource.use_count() == 1) {
      description.reclaimable_mesh_bytes += entry.second.resource->mesh.positions_xyz.capacity() * sizeof(float);
      ++texture_victims[entry.second.resource->texture_uv.get()];
    }
  textures.clear();
  for (const auto& entry : context.surface_cache) {
    const auto& uv = entry.second.resource->texture_uv;
    if (textures.insert(uv.get()).second && texture_victims[uv.get()] == static_cast<std::size_t>(uv.use_count()))
      description.reclaimable_mesh_bytes += uv->values.capacity() * sizeof(float);
  }
}

terra_status admit_mesh_publication(terra_context& context, terra_prepared_mesh_frame& plan,
                                    std::uint32_t credit) {
  describe_mesh_costs(context, plan);
  const auto& d = plan.description;
  if (d.additional_mesh_bytes > credit ||
      d.resident_mesh_bytes + d.additional_mesh_bytes - d.reclaimable_mesh_bytes > d.state.maximum_mesh_bytes)
    return fail(&context, TERRA_STATUS_CAPACITY_PENDING, "native mesh publication capacity is occupied");
  std::uint64_t bytes = d.resident_mesh_bytes + d.additional_mesh_bytes;
  for (auto it = context.surface_cache.begin(); it != context.surface_cache.end() && bytes > d.state.maximum_mesh_bytes;) {
    if (it->second.resource.use_count() != 1) { ++it; continue; }
    bytes -= reclaimable_surface_bytes(*it->second.resource);
    it = erase_cached_surface(context, it);
  }
  return TERRA_STATUS_OK;
}

bool replacement_history_current(const terra_context& context) {
  // Model identity includes the selected fragments' content revisions. An idle
  // height eviction changes cache availability, not this immutable target; using
  // the global cache revision here would restart incomplete group publication.
  return context.replacement_history &&
      context.replacement_history->model_revision == context.model_revision;
}

std::vector<terra_mesh_target> mesh_targets(const terra_mesh_output& output) {
  std::vector<terra_mesh_target> target;
  target.reserve(output.mesh_resources.size());
  for (std::size_t i = 0U; i < output.mesh_resources.size(); ++i)
    target.push_back({output.mesh_resources[i], output.frame_surfaces[i]->mesh.patch, output.frame_surfaces[i]});
  return target;
}

void append_mesh_resource(terra_mesh_output& output,
    const std::shared_ptr<terra_mesh_resource>& resource, terra_mesh_resource_v3 value) {
  value.draw.first_vertex = static_cast<std::uint32_t>(output.position_float_count / 3U);
  output.position_float_count += value.position_float_count;
  output.texture_float_count += value.texture_float_count;
  output.frame_surfaces.push_back(resource);
  output.mesh_resources.push_back(value);
}

void append_mesh_target(terra_context& context, terra_mesh_output& output, terra_mesh_target& target,
    std::map<std::uint32_t, std::shared_ptr<terra_mesh_resource>>& aliases) {
  const auto& value = target.description;
  auto& resource = aliases[value.resource_id];
  // Trying another group can replace an expired descriptor while history still
  // holds its older weak reference. Prefer the materialized identity: restoring
  // a second object for an already live ID loses its ownership and byte count.
  if (!resource) {
    const auto live = context.mesh_registry.find(value.resource_id);
    if (live != context.mesh_registry.end()) resource = live->second.lock();
  }
  if (!resource) resource = target.resource.lock();
  if (!resource) {
    resource = std::make_shared<terra_mesh_resource>(context.mesh_payload);
    resource->id = value.resource_id;
    resource->mesh.patch = target.patch;
    resource->mesh.fragment = static_cast<std::uint8_t>(value.draw.fragment);
    resource->mesh.texture_node = terra::imagery::node_key(value.draw.texture.level,
        value.draw.texture.row, value.draw.texture.column);
    std::copy(value.draw.origin, value.draw.origin + 3U, resource->mesh.origin.begin());
  }
  // Coverage and normal draws can share one ID; restoring expired weak targets
  // must recreate exactly one allocation for that immutable resource.
  target.resource = resource;
  attach_mesh_texture(context, *resource);
  append_mesh_resource(output, resource, value);
}

terra_status build_mesh_plan(
    terra_context& context, const terra::frame::lod_cut& cut, terra_mesh_output& output,
    std::uint32_t& expected_draw_count,
    std::uint32_t& omitted_draw_count,
    std::uint32_t& coverage_draw_count,
    std::uint32_t& coverage_complete) {
  prune_texture_registry(context);
  height_map& heights = context.heights;
  if (!replacement_history_current(context)) context.replacement_history.reset();
  if (context.model_revision == context.update_state.model_revision && !context.update_state.pending_mesh_group_count) {
    expected_draw_count = context.frame.expected_draw_count;
    omitted_draw_count = context.frame.omitted_draw_count;
    coverage_draw_count = context.frame.coverage_draw_count;
    coverage_complete = context.frame.coverage_complete;
    output = context.output;
    return TERRA_STATUS_OK;
  }
  if (context.replacement_history) {
    auto& history = *context.replacement_history;
    std::map<std::uint32_t, std::shared_ptr<terra_mesh_resource>> aliases;
    for (auto& target : history.target) append_mesh_target(context, output, target, aliases);
    expected_draw_count = history.frame.expected_draw_count;
    omitted_draw_count = history.frame.omitted_draw_count;
    coverage_draw_count = history.frame.coverage_draw_count;
    coverage_complete = history.frame.coverage_complete;
    return TERRA_STATUS_OK;
  }
  std::map<terra_surface_key, std::shared_ptr<terra_mesh_resource>, terra_surface_key_less> planned;
  expected_draw_count = 0U;
  omitted_draw_count = 0U;
  coverage_draw_count = 0U;
  coverage_complete = 0U;

  const auto ready_fragment_count =
      [&heights](const terra::frame::lod_patch& patch) {
        const height_map::const_iterator height =
            heights.find(to_key(patch));
        if (height == heights.end()) {
          return std::size_t(0U);
        }
        std::size_t count = 0U;
        for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
          if (patch.has_fragment(fragment) &&
              height->second.has_fragment(fragment)) {
            ++count;
          }
        }
        return count;
      };
  std::size_t render_surface_count = 0U;
  if (context.manifest.transform == TERRA_TRANSFORM_CYLINDRICAL) {
    for (const terra::frame::lod_record_request& request :
         cut.record_requests) {
      if (request.kind == terra::frame::lod_record_kind::root) {
        render_surface_count += ready_fragment_count(request.patch);
      }
    }
  }
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (patch.visible) {
      render_surface_count += ready_fragment_count(patch);
    }
  }
  const std::size_t patch_dimension = context.manifest.patch_dimension;
  const std::size_t vertex_count =
      (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
  if (vertex_count != 0U &&
      render_surface_count >
          static_cast<std::size_t>(UINT32_MAX) / vertex_count) {
    return fail(&context, TERRA_STATUS_RESOURCE_LIMIT,
                "frame vertex count exceeds the C ABI range");
  }
  const std::size_t total_vertex_count =
      render_surface_count * vertex_count;
  if (total_vertex_count >
          static_cast<std::size_t>(UINT32_MAX) / 3U) {
    return fail(&context, TERRA_STATUS_RESOURCE_LIMIT,
                "frame buffer exceeds the C ABI range");
  }
  reserve_frame_output(output.mesh_resources, render_surface_count);

  const auto append_surface =
      [&](const terra::frame::lod_patch& patch, std::uint8_t fragment,
          std::uint32_t flags) -> terra_status {
    terra_surface_key surface_key;
    surface_key.patch = to_key(patch);
    surface_key.fragment = fragment;
    auto cached = context.surface_cache.find(surface_key);
    std::shared_ptr<terra_mesh_resource> resource;
    if (cached != context.surface_cache.end()) {
      resource = cached->second.resource;
    } else {
      const auto live = context.live_surfaces.find(surface_key);
      if (live != context.live_surfaces.end()) resource = live->second.lock();
    }
    if (!resource) {
      const auto found = planned.find(surface_key);
      if (found != planned.end()) resource = found->second;
    }
    if (!resource) {
      if (context.next_mesh_id == UINT32_MAX)
        return fail(&context, TERRA_STATUS_RESOURCE_LIMIT, "mesh resource ID range exhausted");
      resource = std::make_shared<terra_mesh_resource>(context.mesh_payload);
      resource->id = context.next_mesh_id++;
      const auto status = terra::frame::describe_patch_surface(patch, fragment, patch_dimension,
          context.manifest.transform == TERRA_TRANSFORM_CYLINDRICAL, context.manifest.radius,
          terra::core::bounds2d({{context.manifest.minimum_u, context.manifest.minimum_v}},
                               {{context.manifest.maximum_u, context.manifest.maximum_v}}), resource->mesh);
      if (status != terra::frame::surface_mesh_status::ok)
        return fail(&context, TERRA_STATUS_INTERNAL_ERROR, terra::frame::surface_mesh_status_message(status));
      planned.emplace(surface_key, resource);
    }
    attach_mesh_texture(context, *resource);
    const terra::frame::patch_surface_mesh& mesh = resource->mesh;

    const std::size_t first_vertex = output.position_float_count / 3U;
    const std::size_t vertex_count = (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
    if (first_vertex > UINT32_MAX || vertex_count > UINT32_MAX ||
        context.index_buffer.size() > UINT32_MAX) {
      return fail(&context, TERRA_STATUS_RESOURCE_LIMIT,
                  "render buffer exceeds the C ABI range");
    }
    terra_draw_range_v1 range{};
    range.struct_size = sizeof(terra_draw_range_v1);
    range.fragment = fragment;
    range.key = to_key(patch);
    range.texture.level =
        static_cast<std::uint32_t>(mesh.texture_node.level);
    range.texture.root = mesh.texture_node.root(context.manifest.transform == TERRA_TRANSFORM_CYLINDRICAL);
    range.texture.row = mesh.texture_node.row;
    range.texture.column = mesh.texture_node.column;
    range.first_vertex = static_cast<std::uint32_t>(first_vertex);
    range.vertex_count = static_cast<std::uint32_t>(vertex_count);
    range.first_index = 0U;
    range.index_count =
        static_cast<std::uint32_t>(context.index_buffer.size());
    std::copy(mesh.origin.begin(), mesh.origin.end(), range.origin);
    range.flags = flags;
    output.position_float_count += vertex_count * 3U;
    output.texture_float_count += vertex_count * 2U;
    output.frame_surfaces.push_back(resource);
    terra_mesh_resource_v3 description{};
    description.struct_size = sizeof(description);
    description.resource_id = resource->id;
    description.position_float_count = vertex_count * 3U;
    description.texture_float_count = vertex_count * 2U;
    description.texture_resource_id = resource->texture_id;
    description.draw = range;
    output.mesh_resources.push_back(description);
    return TERRA_STATUS_OK;
  };

  if (context.manifest.transform == TERRA_TRANSFORM_CYLINDRICAL) {
    const std::uint32_t required_coverage_draw_count =
        static_cast<std::uint32_t>(
            terra::core::cylindrical_roots().size() * 2U);
    std::uint32_t expected_coverage_draw_count = 0U;
    for (const terra::frame::lod_record_request& request :
         cut.record_requests) {
      if (request.kind != terra::frame::lod_record_kind::root) {
        continue;
      }
      const terra_patch_key_v1 key = to_key(request.patch);
      const height_map::const_iterator height = heights.find(key);
      for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
        if (!request.patch.has_fragment(fragment)) {
          continue;
        }
        ++expected_coverage_draw_count;
        if (height == heights.end() ||
            !height->second.has_fragment(fragment)) {
          continue;
        }
        const terra_status status = append_surface(
            request.patch, fragment, TERRA_DRAW_FLAG_COVERAGE);
        if (status != TERRA_STATUS_OK) {
          return status;
        }
        ++coverage_draw_count;
      }
    }
    coverage_complete =
        expected_coverage_draw_count == required_coverage_draw_count &&
                coverage_draw_count == expected_coverage_draw_count
            ? 1U
            : 0U;
  }

  // Resident LOD records are separate from the visible draw payload. Global
  // root coverage remains available for camera-only previews.
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (!patch.visible) continue;
    const terra_patch_key_v1 key = to_key(patch);
    const height_map::const_iterator height = heights.find(key);
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!patch.has_fragment(fragment)) {
        continue;
      }
      ++expected_draw_count;
      if (height == heights.end() ||
          !height->second.has_fragment(fragment)) {
        ++omitted_draw_count;
        continue;
      }
      const terra_status status = append_surface(
          patch, fragment, TERRA_DRAW_FLAG_NONE);
      if (status != TERRA_STATUS_OK) {
        return status;
      }
    }
  }
  if (context.manifest.transform == TERRA_TRANSFORM_PLANAR) {
    coverage_complete =
        expected_draw_count > 0U && omitted_draw_count == 0U ? 1U : 0U;
  }
  if (output.mesh_resources.size() > UINT32_MAX ||
      output.position_float_count > UINT32_MAX ||
      output.texture_float_count > UINT32_MAX ||
      output.position_float_count / 3U > UINT32_MAX) {
    return fail(&context, TERRA_STATUS_RESOURCE_LIMIT,
                "frame buffers exceed the C ABI range");
  }
  return TERRA_STATUS_OK;
}

terra_status materialize_mesh_plan(terra_context& context, std::uint32_t credit, bool& complete) {
  complete = false;
  auto& plan = *context.prepared_mesh;
  if (plan.replacement) return fail(&context, TERRA_STATUS_INVALID_STATE, "boundary work is active");
  if (!plan.production_started) {
    const auto admission = admit_mesh_publication(context, plan, credit);
    if (admission != TERRA_STATUS_OK) return admission;
    plan.production_started = true;
    plan.production_credit = credit;
  } else if (credit != plan.production_credit) {
    return fail(&context, TERRA_STATUS_INVALID_ARGUMENT, "mesh production credit changed");
  }
  // Preserve the selected snapshot and full credit across scheduler turns.
  // A call scans at most 64 descriptors and produces at most one full fragment.
  for (std::size_t scanned = 0U; plan.production_cursor < plan.output.frame_surfaces.size() && scanned < 64U; ++scanned) {
    const auto& resource = plan.output.frame_surfaces[plan.production_cursor];
    const auto& patch = resource->mesh.patch;
    const auto fragment = resource->mesh.fragment;
    const terra_surface_key key{to_key(patch), fragment};
    const auto cached = context.surface_cache.find(key);
    if (cached != context.surface_cache.end())
      cached->second.last_used_sequence = plan.description.frame.sequence;
    if (!resource->mesh.positions_xyz.empty()) { ++plan.production_cursor; continue; }
    const auto height = plan.height_inputs.find(key.patch);
    if (height == plan.height_inputs.end() || !height->second->has_fragment(fragment))
      return fail(&context, TERRA_STATUS_INVALID_STATE, "mesh plan height is unavailable");
    terra::frame::patch_surface_mesh generated;
    const auto& manifest = context.manifest;
    const auto status = manifest.transform == TERRA_TRANSFORM_PLANAR
        ? terra::frame::make_planar_patch_positions(patch, fragment, height->second->value().fragments[fragment],
            manifest.height_scale_factor, terra::core::bounds2d({{manifest.minimum_u, manifest.minimum_v}},
            {{manifest.maximum_u, manifest.maximum_v}}), generated)
        : terra::frame::make_cylindrical_patch_positions(patch, fragment, height->second->value().fragments[fragment],
            manifest.height_scale_factor, manifest.radius, generated);
    if (status != terra::frame::surface_mesh_status::ok)
      return fail(&context, status == terra::frame::surface_mesh_status::resource_limit
          ? TERRA_STATUS_RESOURCE_LIMIT : TERRA_STATUS_INTERNAL_ERROR,
          terra::frame::surface_mesh_status_message(status));
    auto& uv = resource->texture_uv->values;
    if (uv.empty()) {
      const auto vertices = static_cast<std::uint32_t>(generated.positions_xyz.size() / 3U);
      std::vector<float> generated_uv(vertices * 2U);
      for (std::uint32_t first = 0U; first < vertices;) {
        const auto count = std::min(terra::frame::maximum_surface_sample_vertices, vertices - first);
        const auto sampled = terra::frame::sample_patch_texture_coordinates(patch, fragment,
            manifest.patch_dimension, manifest.transform == TERRA_TRANSFORM_CYLINDRICAL,
            terra::core::bounds2d({{manifest.minimum_u, manifest.minimum_v}},
                                {{manifest.maximum_u, manifest.maximum_v}}), first, count, generated_uv.data() + 2U * first);
        if (sampled != terra::frame::surface_mesh_status::ok)
          return fail(&context, TERRA_STATUS_INTERNAL_ERROR, "mesh texture production failed");
        first += count;
      }
      if (!context.mesh_payload.observe(resource->texture_uv->allocation, generated_uv.capacity() * sizeof(float)))
        return fail(&context, TERRA_STATUS_RESOURCE_LIMIT, "mesh UV payload size overflow");
      uv.swap(generated_uv);
    }
    context.mesh_registry[resource->id] = resource;
    if (!context.mesh_payload.observe(resource->position_allocation, generated.positions_xyz.capacity() * sizeof(float)))
      return fail(&context, TERRA_STATUS_RESOURCE_LIMIT, "mesh position payload size overflow");
    static_assert(noexcept(resource->mesh = std::move(generated)), "mesh payload transfer must not throw");
    resource->mesh = std::move(generated);
    // A late snapshot must not restore an old height under the live model key.
    const auto current = context.heights.find(key.patch);
    const bool current_height = current != context.heights.end() && current->second.samples == height->second;
    if (current_height) context.live_surfaces[key] = resource;
    if (current_height && prune_surface_cache(context, *resource)) {
      terra_cached_surface value;
      value.resource = resource;
      value.last_used_sequence = plan.description.frame.sequence;
      if (context.surface_cache.emplace(key, std::move(value)).second) {
        context.surface_cache_bytes += resource->mesh.positions_xyz.capacity() * sizeof(float);
        if (context.cached_texture_references[resource->texture_uv.get()]++ == 0U)
          context.surface_cache_bytes += resource->texture_uv->values.capacity() * sizeof(float);
      }
    }
    ++plan.production_cursor;
    break;
  }
  if (plan.production_cursor < plan.output.frame_surfaces.size()) return TERRA_STATUS_OK;
  // Generation owns a private candidate. Consumers may borrow its immutable
  // payload and price derived work before accepting the publication.
  complete = true;
  return TERRA_STATUS_OK;
}

terra_status commit_mesh_plan(terra_context& context) {
  auto& plan = *context.prepared_mesh;
  if (!plan.production_started || plan.replacement ||
      plan.production_cursor != plan.output.frame_surfaces.size())
    return fail(&context, TERRA_STATUS_INVALID_STATE, "mesh production is incomplete");
  context.output = std::move(plan.output);
  context.patches = std::move(plan.patches);
  context.frame = plan.description.frame;
  context.update_state = plan.description.state;
  context.sequence = context.frame.sequence;
  context.prepared_mesh.reset();
  ++context.stats.update_count;
  context.stats.current_patch_count = context.frame.patch_count;
  context.stats.current_request_count = context.frame.request_count;
  context.stats.last_sequence = context.sequence;
  for (auto it = context.mesh_registry.begin(); it != context.mesh_registry.end();)
    if (it->second.expired()) it = context.mesh_registry.erase(it); else ++it;
  prune_texture_registry(context);
  for (auto it = context.live_surfaces.begin(); it != context.live_surfaces.end();)
    if (it->second.expired()) it = context.live_surfaces.erase(it); else ++it;
  return TERRA_STATUS_OK;
}

terra_status make_camera_snapshot(
    const terra_context* context,
    terra::frame::camera_snapshot& snapshot) {
  if (context == nullptr) {
    return TERRA_STATUS_INVALID_ARGUMENT;
  }
  if (!context->manifest_loaded || !context->viewport_set) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest and viewport are required before camera snapshot");
  }
  if (context->manifest.transform == TERRA_TRANSFORM_PLANAR) {
    if (context->camera_set && context->camera.model != TERRA_CAMERA_ORBIT)
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "eye camera requires globe terrain");
    const terra::core::bounds2d bounds(
        terra::core::vector2d{{context->manifest.minimum_u,
                               context->manifest.minimum_v}},
        terra::core::vector2d{{context->manifest.maximum_u,
                               context->manifest.maximum_v}});
    terra::frame::planar_camera camera(
        bounds, static_cast<int>(context->viewport.width),
        static_cast<int>(context->viewport.height),
        static_cast<float>(context->viewport.vertical_fov_radians));
    if (!camera.is_valid()) {
      return fail(context, TERRA_STATUS_INVALID_STATE,
                  "unable to construct planar camera");
    }
    if (context->camera_set) {
      if (!camera.set_target_height(context->camera.target_height_metres)) {
        return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid camera target height");
      }
      camera.set_distance(context->camera.distance);
      camera.set_tilt_radians(context->camera.tilt_radians);
      camera.rotate_yaw_radians(context->camera.yaw_radians);
    }
    if (context->planar_target_set &&
        !camera.set_target(context->planar_target_x,
                           context->planar_target_y)) {
      return fail(context, TERRA_STATUS_INVALID_STATE,
                  "unable to set planar camera target");
    }
    snapshot = camera.snapshot();
    return TERRA_STATUS_OK;
  }
  terra::frame::globe_camera camera(
      static_cast<float>(context->manifest.radius),
      static_cast<int>(context->viewport.width),
      static_cast<int>(context->viewport.height),
      static_cast<float>(context->viewport.vertical_fov_radians));
  if (!camera.is_valid()) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "unable to construct globe camera");
  }
  if (!camera.set_target_degrees(
          context->globe_target_longitude_degrees,
          context->globe_target_latitude_degrees)) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "unable to set globe camera target");
  }
  if (context->camera_set) {
    if (!camera.set_target_height(context->camera.target_height_metres)) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid camera target height");
    }
    camera.set_distance(context->camera.distance);
    camera.set_tilt_radians(context->camera.tilt_radians);
    camera.rotate_yaw_radians(context->camera.yaw_radians);
  }
  if (context->camera_set && context->camera.model == TERRA_CAMERA_EYE &&
      !camera.set_eye(context->globe_target_longitude_degrees,
          context->globe_target_latitude_degrees, context->camera.target_height_metres,
          context->camera.yaw_radians, -1.57079632679489661923 - context->camera.tilt_radians))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid eye camera");
  snapshot = camera.snapshot();
  return TERRA_STATUS_OK;
}

void reset_runtime_state(terra_context& context) {
  context.surface_measurements.clear();
  context.manifest_loaded = false;
  context.sequence = 0U;
  context.camera_set = false;
  context.globe_target_longitude_degrees = 0.0;
  context.globe_target_latitude_degrees = 0.0;
  context.planar_target_x = 0.0;
  context.planar_target_y = 0.0;
  context.planar_target_set = false;
  context.planar_level = 0U;
  context.incremental_updates = false;
  context.globe_lod.clear();
  for (auto& session : context.imagery_sessions) session.reset();
  // Session IDs are not reused across manifest resets.
  context.model_signature.clear();
  context.loaded_records.clear();
  context.zero_detail.reset();
  context.failed_records.clear();
  context.requests.clear();
  context.recent_requests.clear();
  context.record_references.clear();
  context.patches.clear();
  context.index_buffer.clear();
  context.prepared_mesh.reset();
  context.replacement_history.reset();
  context.surface_cache.clear();
  context.surface_cache_bytes = 0U;
  context.cached_texture_references.clear();
  context.output.position_float_count = 0U;
  context.output.texture_float_count = 0U;
  context.output.frame_surfaces.clear();
  context.presented_surfaces.clear();
  context.mesh_registry.clear();
  context.texture_registry.clear();
  context.live_surfaces.clear();
  context.output.mesh_resources.clear();
  context.model_revision = 0U;
  context.update_state = terra_update_state_v2{};
  context.terrain_resources = terra::frame::lod_resource_state();
  context.heights.clear();
  context.procedural_details.clear();
  context.confirmed_no_data.clear();
  ++context.height_revision;
  context.terrain_work.reset();
  context.height_active_cut = terra::frame::lod_cut();
  context.height_active_refine_leaves = true;
  context.height_refinements.clear();
  context.height_last_used.clear();
  context.height_cache_bytes = 0U;
  context.height_build_count = 0U;
  context.height_query.reset();
  context.height_query_id = 0U;
  ++context.record_revision;
  context.frame = terra_frame_v1{};
  context.frame.struct_size = sizeof(terra_frame_v1);
  context.frame.api_version = TERRA_C_API_VERSION;
  context.stats = terra_stats_v1{};
  context.stats.struct_size = sizeof(terra_stats_v1);
  context.stats.api_version = TERRA_C_API_VERSION;
}

terra_status map_decode_status(terra::codec::decode_status status) {
  switch (status) {
    case terra::codec::decode_status::ok:
      return TERRA_STATUS_OK;
    case terra::codec::decode_status::resource_limit:
      return TERRA_STATUS_RESOURCE_LIMIT;
    case terra::codec::decode_status::invalid_argument:
      return TERRA_STATUS_INVALID_ARGUMENT;
    case terra::codec::decode_status::invalid_record:
    case terra::codec::decode_status::unsupported_shape:
      return TERRA_STATUS_DECODE_ERROR;
  }
  return TERRA_STATUS_INTERNAL_ERROR;
}

bool valid_height_query(const terra_context* context, std::uint32_t id) {
  return context && context->height_query && id != 0U && id == context->height_query_id;
}

void describe_height_query(const terra_context& context, terra_height_query_state_v1& output) {
  output = terra_height_query_state_v1{};
  output.struct_size = sizeof(output); output.api_version = TERRA_C_API_VERSION;
  output.query_id = context.height_query_id;
  const auto& query = *context.height_query;
  output.state = static_cast<std::uint32_t>(query.state());
  output.reasons = query.sample().reasons;
  output.payload_bytes = query.payload_bytes(); output.peak_bytes = query.peak_bytes();
  output.maximum_bytes = query.maximum_bytes();
  auto& sample = output.sample;
  sample.struct_size = sizeof(sample); sample.api_version = TERRA_C_API_VERSION;
  sample.available = query.sample().available ? 1U : 0U;
  sample.fragment = query.sample().fragment; sample.data_level = query.sample().data_level;
  const auto& id = query.sample().id;
  sample.key = {query.sample().level, id[0], id[1], id[2]};
  sample.height_metres = query.sample().height_metres;
  sample.sample_spacing_metres = query.sample().sample_spacing_metres;
  sample.height_revision = context.height_query_id;
}

template <typename value_t>
terra_status copy_vector(const terra_context* context,
                         const std::vector<value_t>* source,
                         value_t* destination, std::size_t capacity,
                         std::size_t* count) {
  // Borrow the stored array: nullable getter dispatch must not create a
  // temporary vector before even validating the caller's destination.
  if (context == nullptr || source == nullptr || count == nullptr) {
    return TERRA_STATUS_INVALID_ARGUMENT;
  }
  *count = source->size();
  if (source->size() > capacity || (!source->empty() && destination == nullptr)) {
    return fail(context, TERRA_STATUS_BUFFER_TOO_SMALL,
                "caller buffer is too small");
  }
  if (!source->empty()) {
    std::copy(source->begin(), source->end(), destination);
  }
  return succeed(context);
}

#if defined(TERRA_SDK_NO_EXCEPTIONS)
#define TERRA_C_API_TRY
#define TERRA_C_API_CATCH(context, fallback_message)
#else
#define TERRA_C_API_TRY try
#define TERRA_C_API_CATCH(context, fallback_message)                    \
  catch (const std::bad_alloc& error) {                                 \
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, error.what());     \
  }                                                                     \
  catch (const std::exception& error) {                                 \
    return fail(context, TERRA_STATUS_INTERNAL_ERROR, error.what());     \
  }                                                                     \
  catch (...) {                                                         \
    return fail(context, TERRA_STATUS_INTERNAL_ERROR, fallback_message); \
  }
#endif

}  // namespace

extern "C" {

std::uint32_t terra_abi_version(void) { return TERRA_C_API_VERSION; }

std::uint32_t terra_sizeof_terrain_manifest_v3(void) {
  return static_cast<std::uint32_t>(sizeof(terra_terrain_manifest_v3));
}

std::uint32_t terra_sizeof_viewport_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_viewport_v1));
}

std::uint32_t terra_sizeof_camera_v3(void) {
  return static_cast<std::uint32_t>(sizeof(terra_camera_v3));
}

std::uint32_t terra_sizeof_camera_snapshot_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_camera_snapshot_v1));
}

std::uint32_t terra_sizeof_patch_key_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_patch_key_v1));
}

std::uint32_t terra_sizeof_texture_node_v3(void) {
  return static_cast<std::uint32_t>(sizeof(terra_texture_node_v3));
}

std::uint32_t terra_sizeof_request_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_request_v1));
}

std::uint32_t terra_sizeof_patch_decision_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_patch_decision_v1));
}

std::uint32_t terra_sizeof_draw_range_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_draw_range_v1));
}

std::uint32_t terra_sizeof_frame_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_frame_v1));
}

std::uint32_t terra_sizeof_stats_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_stats_v1));
}

std::uint32_t terra_sizeof_atmosphere_parameters_v1(void) {
  return static_cast<std::uint32_t>(
      sizeof(terra_atmosphere_parameters_v1));
}

std::uint32_t terra_sizeof_atmosphere_result_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_atmosphere_result_v1));
}

terra_status terra_compute_atmosphere(
    const terra_atmosphere_parameters_v1* parameters,
    terra_atmosphere_result_v1* result,
    std::uint8_t* rgba,
    std::uint32_t rgba_capacity) {
  if (!valid_input(parameters) || !valid_input(result) ||
      parameters->flags != 0U ||
      !std::isfinite(parameters->sun_azimuth_degrees) ||
      !std::isfinite(parameters->sun_zenith_degrees) ||
      !std::isfinite(parameters->turbidity) ||
      !std::isfinite(parameters->exposure) ||
      parameters->sun_zenith_degrees < 0.0F ||
      parameters->sun_zenith_degrees > 120.0F ||
      parameters->turbidity < 1.0F || parameters->turbidity > 20.0F ||
      parameters->exposure <= 0.0F || parameters->exposure > 8.0F ||
      parameters->texture_width == 0U ||
      parameters->texture_width > 2048U ||
      parameters->texture_height == 0U ||
      parameters->texture_height > 512U) {
    return TERRA_STATUS_INVALID_ARGUMENT;
  }

  TERRA_C_API_TRY {
    terra::core::atmosphere_parameters input;
    input.sun_azimuth_degrees = parameters->sun_azimuth_degrees;
    input.sun_zenith_degrees = parameters->sun_zenith_degrees;
    input.turbidity = parameters->turbidity;
    input.exposure = parameters->exposure;
    input.texture_width = parameters->texture_width;
    input.texture_height = parameters->texture_height;
    const terra::core::atmosphere_result output =
        terra::core::compute_atmosphere(input);

    terra_atmosphere_result_v1 value{};
    value.struct_size = sizeof(value);
    value.texture_width = output.texture_width;
    value.texture_height = output.texture_height;
    value.sun_visible = output.sun_visible ? 1U : 0U;
    for (std::size_t index = 0U; index < 3U; ++index) {
      value.sun_direction[index] = output.sun_direction[index];
      value.ambient_color[index] = output.ambient_color[index];
      value.diffuse_color[index] = output.diffuse_color[index];
      value.fog_color[index] = output.fog_color[index];
    }
    value.sea_level_fog_density = output.sea_level_fog_density;
    value.required_rgba_bytes =
        static_cast<std::uint32_t>(output.rgba.size());
    *result = value;

    if (rgba == nullptr || rgba_capacity < value.required_rgba_bytes) {
      return TERRA_STATUS_BUFFER_TOO_SMALL;
    }
    std::copy(output.rgba.begin(), output.rgba.end(), rgba);
    return TERRA_STATUS_OK;
  }
  TERRA_C_API_CATCH(nullptr, "unable to compute atmosphere")
}

terra_context* terra_create(void) {
  terra_context* context = new (std::nothrow) terra_context();
  if (context != nullptr) {
    reset_runtime_state(*context);
  }
  return context;
}

void terra_destroy(terra_context* context) { delete context; }

terra_status terra_configure_terrain_capacity(terra_context* context, std::uint32_t bytes) {
  if (!context || !bytes || bytes > UINT32_MAX / 2U)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid terrain capacity");
  if (context->terrain_mesh_capacity == bytes) return succeed(context);
  if (context->manifest_loaded)
    return fail(context, TERRA_STATUS_INVALID_STATE, "terrain capacity is fixed at creation");
  TERRA_C_API_TRY {
    terra::frame::record_storage records(bytes);
    terra::frame::height_storage heights(2U * bytes);
    context->record_storage = std::move(records);
    context->height_storage = std::move(heights);
    context->record_work_limit = std::min(context->record_work_limit, bytes);
    context->height_work_limit = std::min(context->height_work_limit, 2U * bytes);
    context->terrain_mesh_capacity = context->terrain_mesh_budget = bytes;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "unable to configure terrain capacity")
}

terra_status terra_set_record_work_limit(terra_context* context, std::uint32_t bytes) {
  if (!context || bytes > context->record_storage.maximum_bytes())
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid decoded output credit");
  context->record_work_limit = bytes;
  return succeed(context);
}

std::uint32_t terra_record_payload_bytes(const terra_context* context) {
  return context ? static_cast<std::uint32_t>(context->record_storage.resident_bytes()) : 0U;
}

terra_status terra_trim_record_cache(terra_context* context, std::uint32_t maximum_bytes) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  while (context->record_storage.resident_bytes() > maximum_bytes) {
    auto oldest = context->loaded_records.end();
    for (auto it = context->loaded_records.begin(); it != context->loaded_records.end(); ++it) {
      const bool active = std::any_of(context->record_references.begin(), context->record_references.end(),
          [&](const terra_request_v1& ref) { return ref.kind == it->kind && same_key(ref.key, it->key); });
      if (!active && it->samples.unique() && (oldest == context->loaded_records.end() ||
          it->last_used_sequence < oldest->last_used_sequence)) oldest = it;
    }
    if (oldest == context->loaded_records.end()) break;
    context->stats.decoded_value_count -= oldest->values().values.size();
    context->loaded_records.erase(oldest);
    ++context->record_revision;
  }
  context->stats.loaded_patch_count = context->loaded_records.size();
  return succeed(context);
}

terra_status terra_load_terrain_manifest(terra_context* context,
                                 const terra_terrain_manifest_v3* manifest) {
  if (context == nullptr || manifest == nullptr ||
      manifest->struct_size != sizeof(terra_terrain_manifest_v3)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid manifest argument");
  }
  if (!context->mesh_loans.empty())
    return fail(context, TERRA_STATUS_INVALID_STATE, "native mesh loans must end before manifest reset");
  terra_terrain_manifest_v3 input{};
  std::memcpy(&input, manifest,
              std::min<std::size_t>(manifest->struct_size, sizeof(input)));
  input.struct_size = sizeof(input);
  if (input.api_version != TERRA_C_API_VERSION) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported C API version");
  }
  if (input.transform != TERRA_TRANSFORM_PLANAR &&
      input.transform != TERRA_TRANSFORM_CYLINDRICAL) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported coordinate transform");
  }
  TERRA_C_API_TRY {
    const terra::core::metadata_validation validation =
        terra::core::validate_dataset_metadata(to_metadata(input));
    if (!validation.valid()) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                  terra::core::metadata_status_message(validation.status));
    }
    if (std::size_t(input.patch_dimension) * input.patch_dimension * sizeof(std::int32_t) > context->record_work_limit)
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "procedural input exceeds decoded output credit");
    reset_runtime_state(*context);
    const terra::frame::mesh_index_status index_status =
        terra::frame::make_triangular_patch_strip_indices(
            input.patch_dimension, context->index_buffer);
    if (index_status != terra::frame::mesh_index_status::ok) {
      const terra_status status =
          index_status == terra::frame::mesh_index_status::index_limit
              ? TERRA_STATUS_UNSUPPORTED
              : TERRA_STATUS_RESOURCE_LIMIT;
      return fail(context, status,
                  terra::frame::mesh_index_status_message(index_status));
    }
    context->manifest = input;
    const auto zero_status = context->record_storage.zero(input.patch_dimension, context->zero_detail);
    if (zero_status != terra::codec::decode_status::ok)
      return fail(context, map_decode_status(zero_status), "procedural terrain input capacity exceeded");
    if (input.transform == TERRA_TRANSFORM_CYLINDRICAL) {
      context->globe_lod.configure(input.radius, input.patch_dimension);
    }
    context->manifest_loaded = true;
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected manifest error")
}

terra_status terra_set_viewport(terra_context* context,
                                const terra_viewport_v1* viewport) {
  if (context == nullptr || !valid_input(viewport)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid viewport argument");
  }
  if (viewport->width == 0U || viewport->height == 0U ||
      !std::isfinite(viewport->vertical_fov_radians) ||
      viewport->vertical_fov_radians <= 0.0 ||
      viewport->vertical_fov_radians >= 3.14159265358979323846) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid viewport values");
  }
  context->viewport = *viewport;
  context->viewport_set = true;
  return succeed(context);
}

terra_status terra_set_camera(terra_context* context,
                              const terra_camera_v3* camera) {
  if (context == nullptr || !valid_input(camera)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid camera argument");
  }
  const bool eye = camera->model == TERRA_CAMERA_EYE;
  if (camera->model > TERRA_CAMERA_EYE || !std::isfinite(camera->distance) ||
      (eye ? camera->distance != 0.0 : camera->distance <= 0.0) ||
      (eye && (camera->tilt_radians >= 0.0 || camera->tilt_radians <= -3.14159265358979323846 ||
          (context->manifest_loaded && context->manifest.transform != TERRA_TRANSFORM_CYLINDRICAL))) ||
      !std::isfinite(camera->tilt_radians) ||
      !std::isfinite(camera->yaw_radians) ||
      !std::isfinite(camera->target_height_metres)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid camera values");
  }
  context->camera = *camera;
  context->camera_set = true;
  return succeed(context);
}

terra_status terra_set_globe_target(terra_context* context,
                                    double longitude_degrees,
                                    double latitude_degrees) {
  if (context == nullptr || !std::isfinite(longitude_degrees) ||
      !std::isfinite(latitude_degrees) || longitude_degrees < -180.0 ||
      longitude_degrees > 180.0 || latitude_degrees < -90.0 ||
      latitude_degrees > 90.0) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid globe target");
  }
  if (!context->manifest_loaded) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest is required before globe target");
  }
  if (context->manifest.transform != TERRA_TRANSFORM_CYLINDRICAL) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "globe target requires a cylindrical dataset");
  }
  context->globe_target_longitude_degrees = longitude_degrees;
  context->globe_target_latitude_degrees = latitude_degrees;
  return succeed(context);
}

terra_status terra_set_planar_target(terra_context* context,
                                     double x, double y) {
  if (context == nullptr || !std::isfinite(x) || !std::isfinite(y)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid planar target");
  }
  if (!context->manifest_loaded) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest is required before planar target");
  }
  if (context->manifest.transform != TERRA_TRANSFORM_PLANAR) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "planar target requires a planar dataset");
  }
  if (x < context->manifest.minimum_u || x > context->manifest.maximum_u ||
      y < context->manifest.minimum_v || y > context->manifest.maximum_v) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "planar target is outside dataset bounds");
  }
  context->planar_target_x = x;
  context->planar_target_y = y;
  context->planar_target_set = true;
  return succeed(context);
}

terra_status terra_set_planar_level(terra_context* context,
                                    std::uint32_t target_level) {
  if (context == nullptr || target_level >= 12U) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid planar target level");
  }
  if (!context->manifest_loaded) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest is required before planar level");
  }
  if (context->manifest.transform != TERRA_TRANSFORM_PLANAR) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "planar level requires a planar dataset");
  }
  context->planar_level = target_level;
  return succeed(context);
}

terra_status terra_submit_record(terra_context* context,
                                 std::uint32_t kind,
                                 const terra_patch_key_v1* key,
                                 const std::uint8_t* data,
                                 std::size_t data_size) {
  if (context == nullptr || !valid_record_kind(kind) || key == nullptr ||
      data == nullptr || data_size == 0U || !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid terrain record submission");
  }
  if (find_request(*context, kind, *key) == nullptr) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "terrain record is not requested by the current frame");
  }
  TERRA_C_API_TRY {
    const std::uint32_t expected_dimension =
        kind == TERRA_REQUEST_ROOT
            ? context->manifest.patch_dimension + 1U
            : context->manifest.patch_dimension;
    if (data_size > std::size_t(expected_dimension) * expected_dimension * 16U + 4096U)
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "terrain encoded record exceeds ingress limit");
    const auto shape_status = terra::codec::validate_cbdam_height_record_patch(
        data, data_size, expected_dimension);
    if (shape_status != terra::codec::decode_status::ok)
      return fail(context, map_decode_status(shape_status),
                  terra::codec::decode_status_message(shape_status));
    if (find_record(*context, kind, *key)) {
      // Still reject corrupt duplicate bodies, but never create an unused
      // second decoded array outside the production budget.
      const auto status = terra::codec::verify_cbdam_height_record_patch(data, data_size, expected_dimension);
      if (status != terra::codec::decode_status::ok)
        return fail(context, map_decode_status(status), terra::codec::decode_status_message(status));
    } else {
      // Both incremental and full updates reserve before producing samples.
      if (std::size_t(expected_dimension) * expected_dimension * sizeof(std::int32_t) > context->record_work_limit)
        return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "record exceeds decoded output credit");
      if (!admit_decoded_record(*context,
          std::size_t(expected_dimension) * expected_dimension * sizeof(std::int32_t)))
        return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "decoded terrain capacity exceeded");
      terra_loaded_record record;
      const auto status = context->record_storage.decode(data, data_size, expected_dimension, record.samples);
      if (status != terra::codec::decode_status::ok)
        return fail(context, map_decode_status(status), terra::codec::decode_status_message(status));
      record.kind = kind;
      record.key = *key;
      const auto count = record.values().values.size();
      context->loaded_records.push_back(std::move(record));
      context->stats.decoded_value_count += count;
      ++context->record_revision;
      context->stats.loaded_patch_count = context->loaded_records.size();
    }
    if (erase_failed_record(*context, kind, *key)) ++context->record_revision;
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected terrain record decode error")
}

terra_status terra_fail_record(terra_context* context,
                               std::uint32_t kind,
                               const terra_patch_key_v1* key) {
  if (context == nullptr || !valid_record_kind(kind) || key == nullptr ||
      !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid failed terrain record");
  }
  const terra_request_v1* request = find_request(*context, kind, *key);
  if (request == nullptr) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "failed terrain record is not currently requested");
  }
  if (find_failed_record(*context, kind, *key) == nullptr) {
    context->failed_records.push_back(*request);
    ++context->record_revision;
    ++context->stats.failed_patch_count;
  }
  context->frame.failed_patch_count =
      static_cast<std::uint32_t>(context->stats.failed_patch_count);
  return succeed(context);
}

terra_status terra_no_data_record(terra_context* context,
                                  const terra_patch_key_v1* key) {
  if (context == nullptr || key == nullptr || !valid_key(*key))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid absent detail record");
  if (!find_request(*context, TERRA_REQUEST_DETAIL, *key))
    return fail(context, TERRA_STATUS_NOT_FOUND, "absent detail was not requested");
  context->confirmed_no_data.insert(*key);
  if (context->procedural_details.insert(*key).second) ++context->record_revision;
  erase_failed_record(*context, TERRA_REQUEST_DETAIL, *key);
  return succeed(context);
}

terra_status terra_set_terrain_mesh_budget(terra_context* context, std::uint32_t bytes) {
  if (!context || !context->manifest_loaded || bytes > context->terrain_mesh_capacity)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid terrain mesh budget");
  const auto dimension = context->manifest.patch_dimension;
  const std::size_t fragment = (dimension + 1U) * (dimension + 2U) / 2U * 5U * sizeof(float);
  if (bytes < 32U * fragment)
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "terrain budget cannot hold roots and a target cut");
  context->terrain_mesh_budget = bytes;
  return succeed(context);
}

terra_status terra_retry_record(terra_context* context,
                                std::uint32_t kind,
                                const terra_patch_key_v1* key) {
  if (context == nullptr || !valid_record_kind(kind) || key == nullptr ||
      !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid terrain record retry");
  }
  if (!erase_failed_record(*context, kind, *key)) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "failed terrain record is not available for retry");
  }
  ++context->record_revision;
  return succeed(context);
}

bool detail_height_ready(const terra_context& context, const terra_patch_key_v1& key) {
  const auto height = context.heights.find(key);
  const auto refined = context.height_refinements.find(key);
  if (height == context.heights.end() || !height->second.samples || refined == context.height_refinements.end() ||
      refined->second != height->second.samples->value().fragment_mask) return false;
  const auto& diamond = height->second.diamond;
  for (std::size_t f = 0U; f < 2U; ++f) {
    const auto point = diamond.corner(2U * f + 1U);
    const bool valid = std::none_of(point.begin(), point.end(), [](std::int32_t v) {
      return v < terra::core::grid_coordinate_min || v > terra::core::grid_coordinate_max;
    });
    if (valid && !height->second.has_fragment(f)) return false;
  }
  return true;
}

static terra_status update_frame(terra_context* context, float lod_threshold,
                                 const terra::frame::lod_update_budget* budget,
                                 terra_update_state_v2* progress = nullptr,
                                 std::size_t maximum_mesh_bytes = 0U,
                                 terra_mesh_plan_v1* prepared = nullptr) {
  if (context == nullptr || !std::isfinite(lod_threshold) ||
      lod_threshold <= 0.0F) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid LOD threshold");
  }
  if (!context->manifest_loaded || !context->viewport_set) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest and viewport are required before update");
  }
  if (!maximum_mesh_bytes) maximum_mesh_bytes = static_cast<std::size_t>(
      std::min<std::uint64_t>(UINT32_MAX, std::uint64_t(context->terrain_mesh_capacity) * 4U));
  TERRA_C_API_TRY {
    if (context->terrain_work) {
      const auto& work = *context->terrain_work;
      const auto same_budget = [&]() {
        if (!budget) return !work.incremental;
        const auto& old = work.budget;
        return work.incremental && old.maximum_change_count == budget->maximum_change_count &&
            old.maximum_priority_update_count == budget->maximum_priority_update_count &&
            old.maximum_request_frontier_count == budget->maximum_request_frontier_count &&
            old.maximum_elapsed_milliseconds == budget->maximum_elapsed_milliseconds &&
            old.maximum_node_count == budget->maximum_node_count &&
            old.maximum_visible_mesh_bytes == budget->maximum_visible_mesh_bytes &&
            old.maximum_split_count == budget->maximum_split_count && old.coarsening_only == budget->coarsening_only;
      };
      if (work.threshold != lod_threshold || work.progress != bool(progress) ||
          work.prepared != bool(prepared) || work.maximum_mesh_bytes != maximum_mesh_bytes || !same_budget())
        return fail(context, TERRA_STATUS_INVALID_STATE, "discard pending terrain work before changing operation");
    }
    const bool continuing = bool(context->terrain_work);
    auto work = std::move(context->terrain_work);
    if (!work) work.reset(new terra_terrain_work());
    auto& snapshot = work->snapshot;
    auto& cut = work->cut;
    if (!continuing) {
      work->threshold = lod_threshold; work->incremental = budget != nullptr;
      work->progress = progress != nullptr; work->prepared = prepared != nullptr;
      work->maximum_mesh_bytes = maximum_mesh_bytes;
      if (budget) work->budget = *budget;
      context->height_build_count = 0U;
      if (context->incremental_updates != (budget != nullptr)) ++context->record_revision;
      context->incremental_updates = budget != nullptr;
      const terra_status camera_status =
          make_camera_snapshot(context, snapshot);
      if (camera_status != TERRA_STATUS_OK) {
        return camera_status;
      }
      if (context->manifest.transform == TERRA_TRANSFORM_PLANAR) {
        cut = terra::frame::select_fixed_planar_lod(
            context->manifest.patch_dimension, context->planar_level);
      } else {
        terra::frame::lod_resource_state& resources = context->terrain_resources;
        if (resources.revision != context->record_revision || resources.height_revision != context->height_revision) {
          resources.available_roots.clear();
          resources.available_details.clear();
          resources.unavailable_details.clear();
          resources.available_roots.reserve(context->loaded_records.size());
          resources.available_details.reserve(context->loaded_records.size() + context->procedural_details.size());
          resources.unavailable_details.reserve(context->failed_records.size());
          for (const terra_loaded_record& record : context->loaded_records) {
            terra::frame::lod_detail_key available;
            available.level = record.key.level;
            available.id = {{record.key.i, record.key.j, record.key.k}};
            if (record.kind == TERRA_REQUEST_ROOT) {
              resources.available_roots.push_back(available);
            } else if (record.kind == TERRA_REQUEST_DETAIL &&
                       (!context->incremental_updates || detail_height_ready(*context, record.key))) {
              resources.available_details.push_back(available);
            }
          }
          for (const auto& key : context->procedural_details) {
            if (context->incremental_updates && !detail_height_ready(*context, key)) continue;
            resources.available_details.push_back({key.level, {{key.i, key.j, key.k}}});
          }
          for (const terra_request_v1& failed : context->failed_records) {
            if (failed.kind != TERRA_REQUEST_DETAIL) continue;
            terra::frame::lod_detail_key unavailable;
            unavailable.level = failed.key.level;
            unavailable.id = {{failed.key.i, failed.key.j, failed.key.k}};
            resources.unavailable_details.push_back(unavailable);
          }
          resources.revision = context->record_revision;
        }
        if (resources.height_revision != context->height_revision) {
          resources.height_ranges.clear();
          for (const auto& entry : context->heights) {
            if (!entry.second.range_valid) continue;
            terra::frame::lod_height_range range;
            range.key.level = entry.first.level;
            range.key.id = {{entry.first.i, entry.first.j, entry.first.k}};
            range.minimum = entry.second.minimum_height;
            range.maximum = entry.second.maximum_height;
            resources.height_ranges.push_back(range);
          }
          resources.height_revision = context->height_revision;
        }
        cut = budget == nullptr
            ? context->globe_lod.update(lod_threshold, snapshot, resources)
            : context->globe_lod.update_step(lod_threshold, snapshot, resources,
                                            *budget);
      }
      if (!cut.complete) {
        return fail(context, TERRA_STATUS_RESOURCE_LIMIT,
                    "LOD selection exhausted its safety budget");
      }
      context->requests.clear();
      context->record_references.clear();
      context->requests.reserve(cut.record_requests.size());
      struct scheduled_record {
        const terra::frame::lod_record_request* record = nullptr;
        std::size_t order = 0U;
      };
      const loaded_record_index loaded_records =
          index_loaded_records(*context);
      active_record_set failed_records;
      for (const terra_request_v1& failed : context->failed_records) {
        failed_records.insert(
            make_active_record_key(failed.kind, failed.key));
      }
      std::vector<scheduled_record> schedule;
      schedule.reserve(cut.record_requests.size());
      for (std::size_t index = 0U; index < cut.record_requests.size();
           ++index) {
        scheduled_record entry;
        entry.record = &cut.record_requests[index];
        entry.order = index;
        schedule.push_back(entry);
      }
      std::stable_sort(
          schedule.begin(), schedule.end(),
          [](const scheduled_record& left, const scheduled_record& right) {
            const bool left_root =
                left.record->kind == terra::frame::lod_record_kind::root;
            const bool right_root =
                right.record->kind == terra::frame::lod_record_kind::root;
            if (left_root != right_root) {
              return left_root;
            }
            if (left.record->patch.priority !=
                right.record->patch.priority) {
              return left.record->patch.priority >
                     right.record->patch.priority;
            }
            return left.order < right.order;
          });
      for (const scheduled_record& scheduled : schedule) {
        const terra::frame::lod_record_request& record = *scheduled.record;
        terra_request_v1 request{};
        request.struct_size = sizeof(terra_request_v1);
        request.kind =
            record.kind == terra::frame::lod_record_kind::root
                ? TERRA_REQUEST_ROOT
                : TERRA_REQUEST_DETAIL;
        request.key = to_key(record.patch);
        context->record_references.push_back(request);
        const active_record_key active =
            make_active_record_key(request.kind, request.key);
        if (loaded_records.count(active) == 0U &&
            failed_records.count(active) == 0U &&
            !(request.kind == TERRA_REQUEST_DETAIL && context->procedural_details.count(request.key))) {
          context->requests.push_back(request);
          remember_request(*context, request);
        }
      }
      // Keep immutable inputs across yields. Record arrival may reallocate the
      // cache's vector; no continuation retains raw pointers into that vector.
      // A later epoch consumes new records. Procedural inheritance still flows
      // from an earlier parent to a later request in this same fixed cut.
      work->inputs.reserve(cut.record_requests.size());
      for (const auto& request : cut.record_requests) {
        const auto kind = request.kind == terra::frame::lod_record_kind::root
            ? TERRA_REQUEST_ROOT : TERRA_REQUEST_DETAIL;
        const auto found = loaded_records.find(make_active_record_key(kind, to_key(request.patch)));
        work->inputs.push_back(found == loaded_records.end() ? nullptr : found->second->samples);
      }
      if (context->incremental_updates) {
        const auto keys = height_dependency_keys(*context, cut, refine_leaf_heights(*work));
        const std::size_t dimension = context->manifest.patch_dimension;
        const std::size_t fragment_bytes = (dimension + 1U) * (dimension + 2U) / 2U * sizeof(std::int32_t);
        std::size_t incoming = 0U;
        for (const auto& key : keys) {
          const auto found = context->heights.find(key);
          incoming += fragment_bytes * (found == context->heights.end() ? 2U
              : (found->second.has_fragment(0U) ? 0U : 1U) + (found->second.has_fragment(1U) ? 0U : 1U));
        }
        prune_height_cache(*context, cut, incoming, refine_leaf_heights(*work));
        if (context->height_cache_bytes + incoming > context->height_storage.maximum_bytes()) {
          return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "terrain height capacity exceeded");
        }
      }
    }
    std::uint32_t expected_draw_count = 0U;
    std::uint32_t omitted_draw_count = 0U;
    std::uint32_t coverage_draw_count = 0U;
    std::uint32_t coverage_complete = 0U;
    const terra_status height_status = prepare_terrain_heights(*context, *work);
    if (height_status != TERRA_STATUS_OK) {
      // Only an ordinary continuation owns this epoch. Capacity refusal must
      // permit a fresh/coarsening selection; cached payload remains accounted.
      if (height_status == TERRA_STATUS_WORK_PENDING)
        context->terrain_work = std::move(work);
      return height_status;
    }
    const loaded_record_index loaded_records = index_loaded_records(*context);
    const bool height_pending = context->incremental_updates &&
        context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL &&
        context->terrain_resources.height_revision != context->height_revision;
    update_model_revision(*context, cut, loaded_records);
    terra_update_state_v2 model_state{};
    model_state.struct_size = sizeof(model_state);
    model_state.api_version = TERRA_UPDATE_API_VERSION;
    model_state.sequence = context->sequence;
    model_state.model_revision = context->model_revision;
    model_state.maximum_mesh_bytes = maximum_mesh_bytes;
    model_state.height_build_count = context->height_build_count;
    model_state.requested_lod_threshold = lod_threshold;
    model_state.feasible_lod_threshold = cut.feasible_threshold > 0.0F
        ? cut.feasible_threshold : lod_threshold;
    model_state.topology_node_count = static_cast<std::uint32_t>(cut.node_count);
    model_state.maximum_topology_node_count = budget == nullptr ? 0U
        : static_cast<std::uint32_t>(budget->maximum_node_count);
    model_state.limited_by_capacity = cut.limited_by_capacity ? 1U : 0U;
    model_state.priority_update_count = cut.priority_update_count;
    model_state.topology_change_count = static_cast<std::uint32_t>(cut.change_count);
    model_state.pending_priority_update_count = cut.pending_priority_update_count + (height_pending ? 1U : 0U);
    model_state.budget_exhausted = cut.budget_exhausted || height_pending ? 1U : 0U;
    if (progress) {
      // Model advancement owns no render snapshot. All candidate arrays,
      // resource IDs and its receipt sequence remain immutable until publish.
      prune_inactive_records(*context, cut);
      prune_height_cache(*context, cut, 0U, refine_leaf_heights(*work));
      *progress = model_state;
      context->height_active_refine_leaves = refine_leaf_heights(*work);
      context->height_active_cut = std::move(work->cut);
      return succeed(context);
    }
    context->prepared_mesh.reset();
    if (context->next_mesh_plan_id == UINT32_MAX)
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "mesh plan ID range exhausted");
    std::unique_ptr<terra_prepared_mesh_frame> plan(new terra_prepared_mesh_frame());
    const terra::frame::frame_packet packet = terra::frame::make_frame_packet(
        context->sequence + 1U, snapshot, cut);
    std::vector<terra_patch_decision_v1> decisions;
    decisions.reserve(packet.patch_decisions.size());
    for (const terra::frame::lod_patch& patch : packet.patch_decisions) {
      terra_patch_decision_v1 decision{};
      decision.struct_size = sizeof(terra_patch_decision_v1);
      decision.visible = patch.visible ? 1U : 0U;
      decision.key = to_key(patch);
      decision.priority = patch.priority;
      decisions.push_back(decision);
    }
    prune_inactive_records(*context, cut);
    prune_height_cache(*context, cut, 0U, refine_leaf_heights(*work));
    const terra_status render_status = build_mesh_plan(
        *context, cut, plan->output, expected_draw_count, omitted_draw_count,
        coverage_draw_count, coverage_complete);
    if (render_status != TERRA_STATUS_OK) {
      return render_status;
    }
    plan->description.frame = terra_frame_v1{};
    plan->description.frame.struct_size = sizeof(terra_frame_v1);
    plan->description.frame.api_version = TERRA_C_API_VERSION;
    plan->description.frame.sequence = packet.sequence;
    plan->description.frame.decisions_complete = packet.decisions_complete && !height_pending ? 1U : 0U;
    plan->description.frame.patch_count =
        static_cast<std::uint32_t>(decisions.size());
    plan->description.frame.request_count =
        static_cast<std::uint32_t>(context->requests.size());
    plan->description.frame.loaded_patch_count =
        static_cast<std::uint32_t>(context->loaded_records.size());
    plan->description.frame.failed_patch_count =
        static_cast<std::uint32_t>(context->failed_records.size());
    std::copy(packet.camera.position.begin(), packet.camera.position.end(),
              plan->description.frame.camera_position);
    std::copy(packet.camera.projection_view.begin(),
              packet.camera.projection_view.end(),
              plan->description.frame.projection_view);
    plan->description.frame.draw_count =
        static_cast<std::uint32_t>(plan->output.mesh_resources.size());
    plan->description.frame.vertex_count =
        static_cast<std::uint32_t>(plan->output.position_float_count / 3U);
    plan->description.frame.position_float_count =
        static_cast<std::uint32_t>(plan->output.position_float_count);
    plan->description.frame.texture_float_count =
        static_cast<std::uint32_t>(plan->output.texture_float_count);
    plan->description.frame.expected_draw_count = expected_draw_count;
    plan->description.frame.omitted_draw_count = omitted_draw_count;
    plan->description.frame.coverage_draw_count = coverage_draw_count;
    plan->description.frame.coverage_complete = coverage_complete;

    for (const auto& resource : plan->output.frame_surfaces) {
      if (!resource->mesh.positions_xyz.empty()) continue;
      const auto key = to_key(resource->mesh.patch);
      const auto height = context->heights.find(key);
      if (height == context->heights.end() || !height->second.has_fragment(resource->mesh.fragment))
        return fail(context, TERRA_STATUS_INVALID_STATE, "missing prepared height input");
      plan->height_inputs.emplace(key, height->second.samples);
    }
    plan->patches = std::move(decisions);
    plan->height_revision = context->height_revision;
    plan->description.struct_size = sizeof(terra_mesh_plan_v1);
    plan->description.api_version = TERRA_C_API_VERSION;
    plan->description.plan_id = context->next_mesh_plan_id++;
    plan->description.state = model_state;
    plan->description.state.sequence = packet.sequence;
    describe_mesh_costs(*context, *plan);
    context->prepared_mesh = std::move(plan);
    if (prepared) *prepared = context->prepared_mesh->description;
    else {
      bool complete = false;
      while (!complete) {
        const auto status = materialize_mesh_plan(*context, UINT32_MAX, complete);
        if (status != TERRA_STATUS_OK) { context->prepared_mesh.reset(); return status; }
      }
      const auto status = commit_mesh_plan(*context);
      if (status != TERRA_STATUS_OK) return status;
    }
    context->height_active_refine_leaves = refine_leaf_heights(*work);
    context->height_active_cut = std::move(work->cut);
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected frame update error")
}

terra_status terra_update(terra_context* context, float lod_threshold) {
  return update_frame(context, lod_threshold, nullptr);
}

size_t terra_sizeof_update_budget_v2(void) {
  return sizeof(terra_update_budget_v2);
}

size_t terra_sizeof_update_state_v2(void) {
  return sizeof(terra_update_state_v2);
}

size_t terra_sizeof_mesh_resource_v3(void) {
  return sizeof(terra_mesh_resource_v3);
}

size_t terra_sizeof_frame_receipt_v2(void) {
  return sizeof(terra_frame_receipt_v2);
}

size_t terra_sizeof_imagery_options_v4(void) { return sizeof(terra_imagery_options_v4); }
size_t terra_sizeof_imagery_surface_v3(void) { return sizeof(terra_imagery_surface_v3); }
size_t terra_sizeof_imagery_region_v4(void) { return sizeof(terra_imagery_region_v4); }
size_t terra_sizeof_imagery_hull_point_v3(void) { return sizeof(terra_imagery_hull_point_v3); }
size_t terra_sizeof_imagery_draw_v3(void) { return sizeof(terra_imagery_draw_v3); }
size_t terra_sizeof_imagery_quality_v4(void) { return sizeof(terra_imagery_quality_v4); }

std::uint32_t terra_imagery_payload_bytes(const terra_context* context) {
  std::size_t bytes = context?context->surface_measurements.allocated_bytes():0U;
  if (context) for (const auto& session : context->imagery_sessions) if (session) {
    bytes += sizeof(terra_imagery_session) + session->controller.allocated_bytes();
  }
  return static_cast<std::uint32_t>(std::min<std::size_t>(bytes, UINT32_MAX));
}

std::uint32_t terra_imagery_input_work_bytes(std::uint32_t surfaces, std::uint32_t new_surfaces,
    std::uint32_t regions, std::uint32_t hull_points) {
  if (new_surfaces > surfaces) return UINT32_MAX;
  const auto bytes = terra::frame::imagery_input_work::work_bytes(surfaces, new_surfaces, regions, hull_points);
  return static_cast<std::uint32_t>(std::min<std::uint64_t>(bytes, UINT32_MAX));
}

std::uint32_t terra_imagery_input_payload_bytes(const terra_context* context) {
  std::size_t bytes = context?context->surface_measurements.allocated_bytes():0U;
  if (context) for (const auto& session : context->imagery_sessions) if (session)
    bytes += session->controller.input_allocated_bytes();
  return static_cast<std::uint32_t>(std::min<std::size_t>(bytes, UINT32_MAX));
}

static const terra_imagery_session* read_imagery_session(const terra_context* context, std::uint32_t id) {
  if (context && id) for (const auto& session : context->imagery_sessions)
    if (session && session->id == id) return session.get();
  return nullptr;
}

static terra_imagery_session* find_imagery_session(terra_context* context, std::uint32_t id) {
  return const_cast<terra_imagery_session*>(read_imagery_session(static_cast<const terra_context*>(context), id));
}

std::uint32_t terra_imagery_reference_payload_bytes(const terra_context* context) {
  std::size_t bytes = 0U;
  if (context) for (const auto& session : context->imagery_sessions) if (session)
    bytes += session->controller.reference_allocated_bytes();
  return static_cast<std::uint32_t>(std::min<std::size_t>(bytes, UINT32_MAX));
}

std::uint32_t terra_imagery_reference_work_bytes(const terra_context* context, std::uint32_t id) {
  const auto* session = read_imagery_session(context, id);
  return session ? static_cast<std::uint32_t>(std::min<std::size_t>(
      session->controller.reference_work_bytes(), UINT32_MAX)) : UINT32_MAX;
}

std::uint32_t terra_imagery_output_payload_bytes(const terra_context* context) {
  std::size_t bytes = 0U;
  if (context) for (const auto& session : context->imagery_sessions) if (session)
    bytes += session->controller.output_allocated_bytes();
  return static_cast<std::uint32_t>(std::min<std::size_t>(bytes, UINT32_MAX));
}

std::uint32_t terra_imagery_output_work_bytes(const terra_context* context, std::uint32_t id) {
  const auto* session = read_imagery_session(context, id);
  return session ? static_cast<std::uint32_t>(std::min<std::size_t>(
      session->controller.output_work_bytes(), UINT32_MAX)) : UINT32_MAX;
}

terra_status terra_reclaim_imagery_references(terra_context* context, std::uint32_t needed,
    std::uint32_t maximum_visits, std::uint32_t restart,
    std::uint32_t* released_bytes, std::uint32_t* pending) {
  if (!context || !needed || !maximum_visits || maximum_visits > 64U || restart > 1U || !released_bytes || !pending)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery reference reclamation");
  std::size_t released = 0U, visits = 0U;
  bool more = false;
  for (auto& session : context->imagery_sessions) if (session && session->controller.reference_allocated_bytes()) {
    const auto progress = session->controller.reclaim_references(
        needed > released ? needed - released : 0U, maximum_visits - visits, restart != 0U);
    released += progress.released_bytes; visits += progress.visited; more = more || progress.pending;
  }
  *released_bytes = static_cast<std::uint32_t>(std::min<std::size_t>(released, UINT32_MAX));
  *pending = more ? 1U : 0U;
  return succeed(context);
}

terra_status terra_open_imagery(terra_context* context, std::uint32_t* session_id) {
  if (!context || !session_id) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery session output");
  if (!context->manifest_loaded) return fail(context, TERRA_STATUS_INVALID_STATE, "imagery requires a manifest");
  TERRA_C_API_TRY {
    if (context->next_imagery_session_id) for (auto& slot : context->imagery_sessions) if (!slot) {
      std::unique_ptr<terra_imagery_session> session(new terra_imagery_session());
      session->id = context->next_imagery_session_id++;
      *session_id = session->id;
      slot = std::move(session);
      return succeed(context);
    }
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "imagery session capacity exhausted");
  } TERRA_C_API_CATCH(context, "imagery session allocation failed")
}

terra_status terra_close_imagery(terra_context* context, std::uint32_t session_id) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  for (auto& session : context->imagery_sessions) if (session && session->id == session_id) {
    context->surface_measurements.close_session(session_id);
    session.reset();
    return succeed(context);
  }
  return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
}

terra_status terra_reset_imagery(terra_context* context, std::uint32_t session_id) {
  if (context == nullptr) return TERRA_STATUS_INVALID_ARGUMENT;
  auto* session = find_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  TERRA_C_API_TRY {
    session->input = terra_imagery_input();
    session->controller.clear();
    session->snapshot.reset();
    session->quality = terra_imagery_quality_v4{};
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected imagery reset error")
}

static bool publish_imagery(terra_imagery_session& session, const terra::frame::imagery_cut& cut) {
  if (session.snapshot != cut.draws) {
    if (session.draw_revision == std::numeric_limits<std::uint64_t>::max())
      return false;
    session.snapshot = cut.draws;
    ++session.draw_revision;
  }
  auto& quality = session.quality;
  quality = terra_imagery_quality_v4{};
  quality.struct_size = sizeof(quality);
  quality.api_version = TERRA_C_API_VERSION;
  quality.requested_pixel_error = cut.requested_pixel_error;
  quality.feasible_pixel_error = cut.feasible_pixel_error;
  quality.maximum_pixel_error = cut.maximum_pixel_error;
  quality.selected_texture_count = cut.selected_texture_count;
  quality.draw_count = cut.draws->size();
  quality.draw_revision = session.draw_revision;
  quality.cached_node_count = cut.cached_node_count;
  quality.limit_flags = (cut.limited_by_texture_budget ? 1U : 0U) |
      (cut.limited_by_draw_budget ? 2U : 0U) | (cut.limited_by_level ? 4U : 0U) |
      (!std::isfinite(cut.maximum_pixel_error) ? 8U : 0U) |
      (cut.limited_by_partition_budget ? 16U : 0U) | (!cut.decisions_complete ? 32U : 0U) |
      (cut.rebuilding ? 64U : 0U);
  return true;
}

static terra_status imagery_budget_from_input(terra_context* context,
    const terra_imagery_options_v4* options, terra::frame::imagery_budget& budget) {
  if (!std::isfinite(options->requested_pixel_error) || options->requested_pixel_error <= 0.0 ||
      !options->tile_size || options->maximum_level > 27U ||
      !options->maximum_texture_count || !options->maximum_draw_count)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery budget");
  budget.requested_pixel_error = options->requested_pixel_error;
  budget.tile_size = options->tile_size;
  budget.maximum_level = options->maximum_level;
  budget.maximum_texture_count = options->maximum_texture_count;
  budget.maximum_draw_count = options->maximum_draw_count;
  terra::imagery::texture_model texture_model;
  texture_model.global = context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL;
  texture_model.extent = {{{context->manifest.minimum_u, context->manifest.minimum_v}},
                          {{context->manifest.maximum_u, context->manifest.maximum_v}}};
  const bool shared_roots = texture_model.global && options->source_root_columns == 2U &&
      options->source_root_rows == 1U;
  const bool matching_roots = options->source_root_columns == (texture_model.global ? 4U : 1U) &&
      options->source_root_rows == (texture_model.global ? 2U : 1U);
  if ((!shared_roots && !matching_roots) || options->source_maximum_level > 28U || options->reserved != 0U) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery resource grid");
  }
  terra::imagery::source_descriptor source_grid;
  source_grid.extent = texture_model.extent;
  const unsigned maximum_source_level = options->source_maximum_level;
  const unsigned level_offset = shared_roots ? 1U : 0U;
  if (options->maximum_level != (maximum_source_level > level_offset ? maximum_source_level - level_offset : 0U)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "imagery resource levels do not match the internal model");
  }
  for (unsigned level = 0; level <= maximum_source_level; ++level) {
    const auto columns = static_cast<std::uint64_t>(options->source_root_columns) << level;
    const auto rows = static_cast<std::uint64_t>(options->source_root_rows) << level;
    if (columns > std::numeric_limits<int>::max() || rows > std::numeric_limits<int>::max()) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "imagery matrix exceeds supported dimensions");
    }
    source_grid.matrices.push_back({std::to_string(level), static_cast<int>(columns), static_cast<int>(rows)});
  }
  const double target_error = budget.requested_pixel_error;
  budget.resource_key = [texture_model, source_grid, maximum_source_level, level_offset, target_error]
      (const terra::imagery::node_key& node, double error) {
    unsigned level = std::min(static_cast<unsigned>(node.level) + level_offset, maximum_source_level);
    if (node.level == 0 && level_offset && maximum_source_level >= level_offset && error * 2.0 <= target_error) level = 0;
    terra::imagery::texture_binding binding;
    if (!terra::imagery::bind_node(texture_model, node, source_grid, static_cast<int>(level), binding)) {
      return std::string();
    }
    return binding.resource.matrix + "/" + std::to_string(binding.resource.row) + "/" + std::to_string(binding.resource.column);
  };
  return TERRA_STATUS_OK;
}

static terra_status convert_imagery_region(terra_context* context,
    const terra_imagery_region_v4& source, terra::frame::measurement_region& row) {
  row=terra::frame::measurement_region();row.flags=source.flags;row.domain=source.domain;
  auto& region=row.value;
  region.uv = terra::core::bounds2d(terra::core::vector2d{{source.minimum_u, source.minimum_v}},
                                  terra::core::vector2d{{source.maximum_u, source.maximum_v}});
  region.pixels_per_uv = source.pixels_per_uv;
  if(row.flags&4U)region.numerator_bound=source.numerator_bound;
  if(row.flags&1U)std::copy_n(source.projection,9U,region.projection.begin());
  if(row.flags&2U)for(unsigned j=0U;j<3U;++j)region.triangle[j]={{source.triangle_uv[j*2U],source.triangle_uv[j*2U+1U]}};
  if(!terra::frame::valid_measurement_region(row))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery region");
  return TERRA_STATUS_OK;
}

static terra_status convert_imagery_surface(terra_context* context,
    const terra_imagery_surface_v3& source, terra::frame::imagery_surface& value) {
  if (!valid_input(&source) || source.source.level > 27U || source.source.root < 0 ||
      source.source.root > 7 || source.source.row < 0 || source.source.column < 0)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery surface");
  if (source.resource_id != 0U) {
    const auto resource = context->mesh_registry.find(source.resource_id);
    if (resource == context->mesh_registry.end() || resource->second.expired()) {
      return fail(context, TERRA_STATUS_NOT_FOUND, "imagery mesh resource is unavailable");
    }
  }
  value.draw_index = source.draw_index;
  value.source = terra::imagery::node_key(static_cast<int>(source.source.level),
      static_cast<int>(source.source.row),
      static_cast<int>(source.source.column));
  terra::imagery::texture_model model;
  model.global = context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL;
  if (!model.contains(value.source) || value.source.root(model.global) != source.source.root) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid internal texture anchor");
  }
  return TERRA_STATUS_OK;
}

static terra_status apply_imagery_input(terra_context* context, terra_imagery_session& session,
    terra::frame::imagery_input_work input,
    const terra::frame::imagery_budget& budget, bool begin_only) {
  if (!session.controller.commit_input(std::move(input), budget))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "imagery cut cannot satisfy its base budget");
  if(begin_only)return succeed(context);
  const auto cut=session.controller.update_step(std::numeric_limits<std::size_t>::max(),std::numeric_limits<std::size_t>::max(),0.0);
  if (!cut.complete) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "imagery cut cannot satisfy its base budget");
  if (!publish_imagery(session, cut))
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "imagery draw revision exhausted");
  return succeed(context);
}

static terra_status plan_imagery_internal(terra_context* context, std::uint32_t session_id,
    const terra_imagery_options_v4* options,
    const terra_imagery_surface_v3* surfaces, std::size_t surface_count,
    const terra_imagery_region_v4* regions, std::size_t region_count,
    const terra_imagery_hull_point_v3* hull_points, std::size_t hull_point_count,
    std::uint32_t maximum_input_work_bytes, bool begin_only) {
  if (context == nullptr || !valid_input(options) || options->api_version != TERRA_C_API_VERSION ||
      surface_count > 65536U || region_count > 1048576U || hull_point_count > 393216U ||
      (surface_count != 0U && surfaces == nullptr) || (region_count != 0U && regions == nullptr) ||
      (hull_point_count != 0U && hull_points == nullptr) ||
      options->maximum_texture_count > 65536U || options->maximum_draw_count > 1048576U) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery plan input");
  }
  auto* session = find_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  if (session->input.storage.active()) return fail(context, TERRA_STATUS_INVALID_STATE, "imagery input already staged");
  std::uint64_t copied_regions = 0U, copied_hull = 0U;
  for (std::size_t i = 0U; i < surface_count; ++i) {
    const auto& source = surfaces[i];
    if (!valid_input(&source) || source.first_region > region_count ||
        source.region_count > region_count - source.first_region ||
        source.first_hull_point > hull_point_count ||
        source.hull_point_count > hull_point_count - source.first_hull_point)
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery surface range");
    copied_regions += source.region_count; copied_hull += source.hull_point_count;
  }
  const auto input_bytes = copied_regions > UINT32_MAX || copied_hull > UINT32_MAX ? UINT32_MAX :
    terra_imagery_input_work_bytes(static_cast<std::uint32_t>(surface_count), static_cast<std::uint32_t>(surface_count),
      static_cast<std::uint32_t>(copied_regions), static_cast<std::uint32_t>(copied_hull));
  if (input_bytes == UINT32_MAX || input_bytes > maximum_input_work_bytes)
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "imagery input exceeds production credit");
  TERRA_C_API_TRY {
    terra::frame::imagery_budget budget;
    const auto budget_status = imagery_budget_from_input(context, options, budget);
    if (budget_status != TERRA_STATUS_OK) return budget_status;
    terra::frame::imagery_input_work input;
    if(!session->controller.stage_input(input,surface_count,surface_count,copied_regions,copied_hull,maximum_input_work_bytes))
      return fail(context,TERRA_STATUS_RESOURCE_LIMIT,"imagery input allocation failed");
    for(std::size_t i=0U;i<surface_count;++i) {
      const auto& source=surfaces[i];terra::frame::imagery_surface description;
      const auto status=convert_imagery_surface(context,source,description);
      if(status!=TERRA_STATUS_OK)return status;
      if(!input.append_surface(description.draw_index,description.source,source.region_count,source.hull_point_count))
        return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery surface shape");
      for(std::size_t r=source.first_region;r<source.first_region+source.region_count;++r) {
        terra::frame::measurement_region row;const auto converted=convert_imagery_region(context,regions[r],row);
        if(converted!=TERRA_STATUS_OK)return converted;
        if(!input.append_region(row))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery region");
      }
      for(std::size_t h=source.first_hull_point;h<source.first_hull_point+source.hull_point_count;++h)
        if(!input.append_hull({{hull_points[h].u,hull_points[h].v}}))
          return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery hull point");
    }
    return apply_imagery_input(context, *session, std::move(input), budget, begin_only);
  }
  TERRA_C_API_CATCH(context, "unexpected imagery planning error")
}

terra_status terra_stage_imagery_input(terra_context* context,std::uint32_t session_id,
    const terra_imagery_options_v4* options,std::uint32_t surface_count,std::uint32_t new_surface_count,
    std::uint32_t region_count,std::uint32_t hull_count,std::uint32_t maximum_input_work_bytes,
    std::uint32_t reset_history) {
  if(!context||!valid_input(options)||options->api_version!=TERRA_C_API_VERSION||
      surface_count>65536U||new_surface_count>surface_count||region_count>1048576U||hull_count>393216U||reset_history>1U||
      options->maximum_texture_count>65536U||options->maximum_draw_count>1048576U)
    return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid staged imagery input");
  auto* session=find_imagery_session(context,session_id);
  if(!session||session->input.storage.active())return fail(context,TERRA_STATUS_INVALID_STATE,"unavailable imagery input stage");
  const auto bytes=terra_imagery_input_work_bytes(surface_count,new_surface_count,region_count,hull_count);
  if(bytes==UINT32_MAX||bytes>maximum_input_work_bytes)return fail(context,TERRA_STATUS_RESOURCE_LIMIT,"imagery input exceeds production credit");
  TERRA_C_API_TRY {
    terra::frame::imagery_budget budget;const auto status=imagery_budget_from_input(context,options,budget);
    if(status!=TERRA_STATUS_OK)return status;
    if(!session->controller.stage_input(session->input.storage,surface_count,new_surface_count,region_count,hull_count,maximum_input_work_bytes))
      return fail(context,TERRA_STATUS_RESOURCE_LIMIT,"imagery input allocation failed");
    session->input.budget=std::move(budget);session->input.reset_history=reset_history!=0U;
    return succeed(context);
  } TERRA_C_API_CATCH(context,"imagery input stage allocation failed")
}

terra_status terra_append_imagery_surface(terra_context* context,std::uint32_t session_id,const terra_imagery_surface_v3* surface) {
  if(!context||!valid_input(surface))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid staged imagery surface");
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed())return fail(context,TERRA_STATUS_INVALID_STATE,"no writable imagery input stage");
  if(surface->first_region||surface->first_hull_point)return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"staged imagery surface exceeds declared shape");
  TERRA_C_API_TRY {
    terra::frame::imagery_surface value;const auto status=convert_imagery_surface(context,*surface,value);
    if(status!=TERRA_STATUS_OK)return status;
    if(!session->input.storage.append_surface(value.draw_index,value.source,surface->region_count,surface->hull_point_count))
      return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"staged imagery surface exceeds declared shape");
    return succeed(context);
  } TERRA_C_API_CATCH(context,"imagery surface stage allocation failed")
}

terra_status terra_append_retained_imagery_surface(terra_context* context,std::uint32_t session_id,
    std::uint32_t previous_draw_index,std::uint32_t draw_index) {
  if(!context)return TERRA_STATUS_INVALID_ARGUMENT;
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed())return fail(context,TERRA_STATUS_INVALID_STATE,"no writable imagery input stage");
  const auto retained=session->controller.retain_surface(previous_draw_index);
  if(!retained)return fail(context,TERRA_STATUS_NOT_FOUND,"retained imagery input is unavailable or ambiguous");
  TERRA_C_API_TRY {
    if(!session->input.storage.append_retained(retained,draw_index))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"retained imagery member exceeds declared shape");
    return succeed(context);
  } TERRA_C_API_CATCH(context,"retained imagery member allocation failed")
}

terra_status terra_append_imagery_regions(terra_context* context,std::uint32_t session_id,
    const terra_imagery_region_v4* regions,std::uint32_t count) {
  if(!context||(count&&!regions)||count>256U)return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery region batch");
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed()||!session->input.storage.has_member())
    return fail(context,TERRA_STATUS_INVALID_STATE,"no writable imagery surface");
  auto& work=session->input.storage;
  if(count>work.remaining_regions())return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"imagery region batch exceeds declared shape");
  for(std::uint32_t i=0U;i<count;++i) {
    terra::frame::measurement_region row;const auto status=convert_imagery_region(context,regions[i],row);
    if(status!=TERRA_STATUS_OK){work.invalidate();return status;}
    if(!work.append_region(row))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery region");
  }
  return succeed(context);
}

terra_status terra_append_imagery_hull(terra_context* context,std::uint32_t session_id,
    const terra_imagery_hull_point_v3* points,std::uint32_t count) {
  if(!context||(count&&!points)||count>256U)return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery hull batch");
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed()||!session->input.storage.has_member())
    return fail(context,TERRA_STATUS_INVALID_STATE,"no writable imagery surface");
  auto& work=session->input.storage;
  if(count>work.remaining_hull())return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"imagery hull batch exceeds declared shape");
  for(std::uint32_t i=0U;i<count;++i)if(!work.append_hull({{points[i].u,points[i].v}}))
    return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery hull point");
  return succeed(context);
}

terra_status terra_commit_imagery_input(terra_context* context,std::uint32_t session_id,std::uint32_t begin_only) {
  if(!context||begin_only>1U)return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid imagery input commit");
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed())return fail(context,TERRA_STATUS_INVALID_STATE,"no complete imagery input stage");
  if(!session->input.storage.complete())return fail(context,TERRA_STATUS_INVALID_STATE,"imagery input stage is incomplete");
  TERRA_C_API_TRY {
    const bool reset=session->input.reset_history;
    auto input=std::move(session->input.storage);auto budget=std::move(session->input.budget);
    session->input=terra_imagery_input();
    if(reset)session->controller.clear();
    return apply_imagery_input(context,*session,std::move(input),budget,begin_only!=0U);
  } TERRA_C_API_CATCH(context,"imagery input commit failed")
}

terra_status terra_cancel_imagery_input(terra_context* context, std::uint32_t session_id) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  auto* session = find_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  session->input = terra_imagery_input();
  return succeed(context);
}

size_t terra_sizeof_surface_work_v1(void){return sizeof(terra_surface_work_v1);}
size_t terra_sizeof_surface_projection_v1(void){return sizeof(terra_surface_projection_v1);}
size_t terra_sizeof_surface_summary_v1(void){return sizeof(terra_surface_summary_v1);}
std::uint32_t terra_surface_model_work_bytes(void){return terra::c_api_detail::surface_measurement_store::model_bytes();}
std::uint32_t terra_surface_measurement_work_bytes(void){return terra::c_api_detail::surface_measurement_store::measurement_bytes();}

terra_status terra_open_surface_model(terra_context* context,std::uint32_t plan,std::uint32_t resource,
    std::uint32_t reuse,std::uint32_t maximum,std::uint32_t* id) {
  if(!context||!id)return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid surface model request");
  if(maximum<terra_surface_model_work_bytes())return fail(context,TERRA_STATUS_RESOURCE_LIMIT,"surface model metadata is uncredited");
  terra::frame::surface_source source;terra::imagery::node_key anchor;
  if(!terra::c_api_detail::borrow_surface_source(context,plan,resource,source,&anchor))
    return fail(context,TERRA_STATUS_INVALID_STATE,"surface model source is unavailable");
  TERRA_C_API_TRY {
    const auto status=context->surface_measurements.open_model(std::move(source),anchor,resource,plan,reuse,maximum,*id);
    return status==TERRA_STATUS_OK?succeed(context):fail(context,status,"surface model could not open");
  } TERRA_C_API_CATCH(context,"surface model creation failed")
}
terra_status terra_step_surface_model(terra_context* context,std::uint32_t id,std::uint32_t maximum,double milliseconds,
    std::uint32_t quote,std::uint32_t grant,terra_surface_work_v1* output) {
  if(!context||!valid_input(output))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid surface model output");
  TERRA_C_API_TRY {
    const auto status=context->surface_measurements.step_model(id,maximum,milliseconds,quote,grant,*output);
    return status==TERRA_STATUS_OK?succeed(context):fail(context,status,"surface model step failed");
  } TERRA_C_API_CATCH(context,"surface model step allocation failed")
}
terra_status terra_close_surface_model(terra_context* context,std::uint32_t id) {
  if(!context)return TERRA_STATUS_INVALID_ARGUMENT;
  return context->surface_measurements.close_model(id)?succeed(context):fail(context,TERRA_STATUS_INVALID_STATE,"stale surface model");
}
terra_status terra_open_surface_measurement(terra_context* context,std::uint32_t session_id,
    const terra_surface_projection_v1* request,const std::uint32_t* domains,std::uint32_t count,
    std::uint32_t maximum,std::uint32_t* id) {
  if(!context||!id||!valid_input(request)||request->api_version!=TERRA_C_API_VERSION)
    return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid native surface projection");
  if(!find_imagery_session(context,session_id))return fail(context,TERRA_STATUS_INVALID_STATE,"stale measurement session");
  TERRA_C_API_TRY {
    const auto status=context->surface_measurements.open_measurement(session_id,*request,domains,count,maximum,*id);
    return status==TERRA_STATUS_OK?succeed(context):fail(context,status,"native surface projection could not open");
  } TERRA_C_API_CATCH(context,"native surface projection creation failed")
}
terra_status terra_step_surface_measurement(terra_context* context,std::uint32_t session_id,std::uint32_t id,
    std::uint32_t maximum,double milliseconds,std::uint32_t quote,std::uint32_t grant,terra_surface_work_v1* output) {
  if(!context||!valid_input(output))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid native surface work output");
  auto* session=find_imagery_session(context,session_id);
  if(!session)return fail(context,TERRA_STATUS_INVALID_STATE,"stale measurement session");
  TERRA_C_API_TRY {
    const auto status=context->surface_measurements.step_measurement(id,session->controller,session_id,maximum,milliseconds,quote,grant,*output);
    return status==TERRA_STATUS_OK?succeed(context):fail(context,status,"native surface work step failed");
  } TERRA_C_API_CATCH(context,"native surface work allocation failed")
}
terra_status terra_get_surface_measurement_summary(const terra_context* context,std::uint32_t id,terra_surface_summary_v1* output) {
  if(!context||!valid_input(output))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid surface measurement summary");
  const auto status=context->surface_measurements.summary(id,*output);
  return status==TERRA_STATUS_OK?succeed(context):fail(context,status,"surface measurement is not ready");
}
terra_status terra_get_surface_measurement_regions(const terra_context* context,std::uint32_t session,
    std::uint32_t id,std::uint32_t first,terra_imagery_region_v4* output,std::uint32_t capacity,std::uint32_t* count) {
  if(!context||!count||capacity>256U||(capacity&&!output))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid surface region read");
  *count=0U;
  const auto input=context->surface_measurements.input(id,session);
  std::array<terra::frame::measurement_region,256U> rows;std::size_t size=0U;
  if(!terra::frame::imagery_controller::read_input(input,first,rows.data(),capacity,size))
    return fail(context,TERRA_STATUS_INVALID_STATE,"surface measurement input is unavailable");
  for(std::size_t i=0U;i<size;++i) {
    const auto& row=rows[i];const auto& source=row.value;auto& target=output[i];
    target.minimum_u=source.uv.minimum[0];target.minimum_v=source.uv.minimum[1];target.maximum_u=source.uv.maximum[0];target.maximum_v=source.uv.maximum[1];
    target.pixels_per_uv=source.pixels_per_uv;std::copy(source.projection.begin(),source.projection.end(),target.projection);
    for(unsigned j=0U;j<3U;++j){target.triangle_uv[j*2U]=source.triangle[j][0];target.triangle_uv[j*2U+1U]=source.triangle[j][1];}
    target.numerator_bound=source.numerator_bound;target.flags=row.flags;target.domain=row.domain;
  }
  *count=std::uint32_t(size);return succeed(context);
}
terra_status terra_get_surface_measurement_hull(const terra_context* context,std::uint32_t session,
    std::uint32_t id,std::uint32_t first,terra_imagery_hull_point_v3* output,std::uint32_t capacity,std::uint32_t* count) {
  if(!context||!count||capacity>256U||(capacity&&!output))return fail(context,TERRA_STATUS_INVALID_ARGUMENT,"invalid surface hull read");
  *count=0U;
  const auto input=context->surface_measurements.input(id,session);
  std::array<terra::core::vector2d,256U> points;std::size_t size=0U;
  if(!terra::frame::imagery_controller::read_input_hull(input,first,points.data(),capacity,size))
    return fail(context,TERRA_STATUS_INVALID_STATE,"surface measurement hull is unavailable");
  for(std::size_t i=0U;i<size;++i)output[i]={points[i][0],points[i][1]};
  *count=std::uint32_t(size);return succeed(context);
}
terra_status terra_append_measured_imagery_surface(terra_context* context,std::uint32_t session_id,std::uint32_t id,std::uint32_t index) {
  if(!context)return TERRA_STATUS_INVALID_ARGUMENT;
  auto* session=find_imagery_session(context,session_id);
  if(!session||!session->input.storage.active()||session->input.storage.failed())
    return fail(context,TERRA_STATUS_INVALID_STATE,"no writable native measurement input");
  const auto input=context->surface_measurements.input(id,session_id);
  if(!input||!session->input.storage.append_retained(input,index))return fail(context,TERRA_STATUS_INVALID_STATE,"incompatible native measurement input");
  return succeed(context);
}
terra_status terra_close_surface_measurement(terra_context* context,std::uint32_t id) {
  if(!context)return TERRA_STATUS_INVALID_ARGUMENT;
  return context->surface_measurements.close_measurement(id)?succeed(context):fail(context,TERRA_STATUS_INVALID_STATE,"stale surface measurement");
}

terra_status terra_plan_imagery(terra_context* context, std::uint32_t session_id,
    const terra_imagery_options_v4* options,
    const terra_imagery_surface_v3* surfaces, std::size_t surface_count,
    const terra_imagery_region_v4* regions, std::size_t region_count,
    const terra_imagery_hull_point_v3* hull_points, std::size_t hull_point_count,
    std::uint32_t maximum_input_work_bytes) {
  return plan_imagery_internal(context, session_id, options, surfaces, surface_count,
      regions, region_count, hull_points, hull_point_count, maximum_input_work_bytes, false);
}

terra_status terra_begin_imagery(terra_context* context, std::uint32_t session_id,
    const terra_imagery_options_v4* options,
    const terra_imagery_surface_v3* surfaces, std::size_t surface_count,
    const terra_imagery_region_v4* regions, std::size_t region_count,
    const terra_imagery_hull_point_v3* hull_points, std::size_t hull_point_count,
    std::uint32_t maximum_input_work_bytes) {
  return plan_imagery_internal(context, session_id, options, surfaces, surface_count,
      regions, region_count, hull_points, hull_point_count, maximum_input_work_bytes, true);
}

terra_status terra_step_imagery(terra_context* context, std::uint32_t session_id, uint32_t maximum_changes,
    uint32_t maximum_priorities, double maximum_milliseconds,
    uint32_t maximum_reference_work_bytes, uint32_t maximum_output_work_bytes, uint32_t* complete) {
  if (!context || !complete || maximum_changes == 0U || maximum_priorities == 0U ||
      !std::isfinite(maximum_milliseconds) || maximum_milliseconds < 0.0) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery continuation budget");
  }
  auto* session = find_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  TERRA_C_API_TRY {
    const auto cut = session->controller.update_step(maximum_changes, maximum_priorities,
        maximum_milliseconds, maximum_reference_work_bytes, maximum_output_work_bytes);
    if (!cut.complete) return fail(context, TERRA_STATUS_INVALID_STATE, "imagery initialization or continuation is invalid");
    if (cut.output_pending) { *complete = 0U; return succeed(context); }
    if (!publish_imagery(*session, cut))
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "imagery draw revision exhausted");
    *complete = cut.decisions_complete ? 1U : 0U;
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected imagery continuation error")
}

terra_status terra_accept_imagery(terra_context* context, std::uint32_t session_id,
    const terra_imagery_draw_v3* draws, std::size_t count, uint32_t admission_revision) {
  if (!context || (count && !draws) || count > 65536U) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid accepted imagery cut");
  auto* session = find_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  TERRA_C_API_TRY {
    std::vector<terra::imagery::node_key> tiles;
    for (std::size_t i = 0U; i < count; ++i) {
      if (!valid_input(&draws[i])) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid accepted imagery draw");
      const auto& t = draws[i].texture;
      terra::imagery::node_key tile(t.level, t.row, t.column);
      if (!tile.is_valid() || t.level > 27U ||
          tile.root(context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL) != t.root) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid accepted imagery tile");
      tiles.push_back(tile);
    }
    if (!session->controller.accept_cut(tiles, admission_revision)) return fail(context, TERRA_STATUS_INVALID_STATE, "accepted imagery is not in the current measured tree");
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected imagery admission error")
}

terra_status terra_get_imagery_draws(const terra_context* context, std::uint32_t session_id,
    std::size_t first, terra_imagery_draw_v3* draws, std::size_t capacity, std::size_t* count) {
  if (!context || !count || (capacity && !draws) || capacity > 256U)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery output range");
  const auto* session = read_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  const auto size = session->snapshot ? session->snapshot->size() : 0U;
  if (first > size) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "imagery output range exceeds snapshot");
  *count = capacity ? std::min(capacity, size - first) : size - first;
  if (!capacity) return succeed(context);
  for (std::size_t i = 0U; i < *count; ++i) {
    const auto& draw = (*session->snapshot)[first + i];
    terra_imagery_draw_v3 value{};
    value.struct_size = sizeof(value);
    value.draw_index = draw.draw_index;
    value.texture.level = draw.tile.level;
    value.texture.root = draw.tile.root(context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL);
    value.texture.row = draw.tile.row;
    value.texture.column = draw.tile.column;
    value.pixel_error = draw.pixel_error;
    draws[i] = value;
  }
  return succeed(context);
}

terra_status terra_get_imagery_quality(const terra_context* context, std::uint32_t session_id, terra_imagery_quality_v4* quality) {
  if (context == nullptr || !valid_input(quality)) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid imagery quality");
  const auto* session = read_imagery_session(context, session_id);
  if (!session) return fail(context, TERRA_STATUS_INVALID_STATE, "stale imagery session");
  if (session->quality.api_version != TERRA_C_API_VERSION) {
    return fail(context, TERRA_STATUS_INVALID_STATE, "imagery has not been planned");
  }
  *quality = session->quality;
  return succeed(context);
}

static terra_status step_terrain(terra_context* context, float lod_threshold,
                                 const terra_update_budget_v2* budget,
                                 terra_update_state_v2* progress,
                                 terra_mesh_plan_v1* prepared = nullptr) {
  if (!valid_input(budget) || budget->api_version != TERRA_UPDATE_API_VERSION ||
      !std::isfinite(budget->maximum_elapsed_milliseconds) ||
      budget->maximum_elapsed_milliseconds < 0.0 || budget->coarsening_only > 1U) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid update budget");
  }
  terra::frame::lod_update_budget value;
  value.maximum_change_count = budget->maximum_change_count;
  value.maximum_priority_update_count = budget->maximum_priority_update_count;
  value.maximum_elapsed_milliseconds = budget->maximum_elapsed_milliseconds;
  value.maximum_node_count = budget->maximum_node_count;
  value.coarsening_only = budget->coarsening_only != 0U;
  if (context != nullptr && context->manifest_loaded) {
    const std::size_t dimension = context->manifest.patch_dimension;
    const std::size_t vertex_count = (dimension + 1U) * (dimension + 2U) / 2U;
    const std::size_t height_nodes = context->height_storage.maximum_bytes() / (2U * vertex_count * sizeof(std::int32_t));
    // Retain roots plus the conservative child frontier of one mutation batch.
    // This is selection headroom; the actual decoder/refinement peak is still
    // quoted and admitted before allocation, including retained old readers.
    const std::size_t batch = std::max<std::size_t>(32U, budget->maximum_change_count);
    const std::size_t headroom = 8U + 4U * std::min<std::size_t>(batch, 65536U);
    const std::size_t capacity = std::max<std::size_t>(8U, height_nodes > headroom ? height_nodes - headroom : 8U);
    value.maximum_visible_mesh_bytes = context->terrain_mesh_budget;
    const std::size_t root_bytes = 8U * (dimension + 1U) * (dimension + 1U) * sizeof(std::int32_t);
    const auto record_bytes = context->record_storage.maximum_bytes();
    value.maximum_split_count = (record_bytes - std::min(record_bytes, root_bytes)) /
        (dimension * dimension * sizeof(std::int32_t));
    value.maximum_split_count = value.maximum_split_count > batch ? value.maximum_split_count - batch : 1U;
    if (16U * vertex_count * 5U * sizeof(float) > context->terrain_mesh_capacity) {
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "terrain root meshes exceed capacity");
    }
    value.maximum_node_count = value.maximum_node_count == 0U ? capacity
        : std::min(capacity, value.maximum_node_count);
  }
  return update_frame(context, lod_threshold, &value, progress,
      budget->maximum_mesh_bytes, prepared);
}

terra_status terra_update_step(terra_context* context, float lod_threshold,
                               const terra_update_budget_v2* budget) {
  return step_terrain(context, lod_threshold, budget, nullptr);
}

size_t terra_sizeof_mesh_plan_v1(void) { return sizeof(terra_mesh_plan_v1); }

terra_status terra_prepare_mesh_frame(terra_context* context, float threshold,
    const terra_update_budget_v2* budget, terra_mesh_plan_v1* plan) {
  if (!valid_input(plan)) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh plan output");
  return step_terrain(context, threshold, budget, nullptr, plan);
}

terra_status terra_get_prepared_mesh_resources(const terra_context* context,
    std::uint32_t plan_id, terra_mesh_resource_v3* resources, std::size_t capacity, std::size_t* count) {
  if (!context || !context->prepared_mesh || context->prepared_mesh->description.plan_id != plan_id)
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh plan");
  return copy_vector(context, &context->prepared_mesh->output.mesh_resources, resources, capacity, count);
}

terra_status terra_step_mesh_frame(terra_context* context, std::uint32_t plan_id,
    std::uint32_t maximum_new_bytes, std::uint32_t* complete) {
  if (!context || !context->prepared_mesh || context->prepared_mesh->description.plan_id != plan_id)
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh plan");
  if (!complete) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "missing production progress output");
  TERRA_C_API_TRY {
    bool finished = false;
    const auto status = materialize_mesh_plan(*context, maximum_new_bytes, finished);
    if (status == TERRA_STATUS_OK) *complete = finished ? 1U : 0U;
    return status == TERRA_STATUS_OK ? succeed(context) : status;
  } TERRA_C_API_CATCH(context, "mesh plan materialization failed")
}

terra_status terra_discard_mesh_plan(terra_context* context, std::uint32_t plan_id) {
  if (!context || !context->prepared_mesh || context->prepared_mesh->description.plan_id != plan_id)
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh plan");
  context->prepared_mesh.reset();
  return succeed(context);
}

terra_status terra_commit_mesh_frame(terra_context* context, std::uint32_t plan_id) {
  if (!context || !context->prepared_mesh || context->prepared_mesh->description.plan_id != plan_id)
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh plan");
  TERRA_C_API_TRY {
    const auto status = commit_mesh_plan(*context);
    return status == TERRA_STATUS_OK ? succeed(context) : status;
  } TERRA_C_API_CATCH(context, "mesh plan publication failed")
}

size_t terra_sizeof_replacement_member_v1(void) { return sizeof(terra_replacement_member_v1); }

std::uint32_t terra_mesh_payload_bytes(const terra_context* context) {
  return context ? static_cast<std::uint32_t>(mesh_payload_bytes(*context)) : 0U;
}

terra_status terra_trim_mesh_cache(terra_context* context, std::uint32_t maximum_bytes) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  auto bytes = mesh_payload_bytes(*context);
  for (auto it = context->surface_cache.begin(); it != context->surface_cache.end() && bytes > maximum_bytes;) {
    if (it->second.resource.use_count() != 1) { ++it; continue; }
    bytes -= reclaimable_surface_bytes(*it->second.resource);
    it = erase_cached_surface(*context, it);
  }
  return succeed(context);
}

static bool current_mesh_plan(const terra_context* context, std::uint32_t id) {
  return context && context->prepared_mesh && context->prepared_mesh->description.plan_id == id;
}

terra_status terra_get_prepared_mesh_uv(const terra_context* context,
    std::uint32_t plan_id, std::uint32_t resource_id, std::uint32_t first_vertex,
    std::uint32_t vertex_count, float* output) {
  static_assert(TERRA_MESH_SAMPLE_LIMIT == terra::frame::maximum_surface_sample_vertices,
                "UV sampling limit differs between core and C ABI");
  if (!current_mesh_plan(context, plan_id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale UV plan");
  for (const auto& resource : context->prepared_mesh->output.frame_surfaces) {
    if (resource->id != resource_id) continue;
    const auto& m = context->manifest;
    const terra::core::bounds2d bounds({{m.minimum_u, m.minimum_v}}, {{m.maximum_u, m.maximum_v}});
    const auto status = terra::frame::sample_patch_texture_coordinates(
        resource->mesh.patch, resource->mesh.fragment, m.patch_dimension,
        m.transform == TERRA_TRANSFORM_CYLINDRICAL, bounds, first_vertex, vertex_count, output);
    return status == terra::frame::surface_mesh_status::ok ? succeed(context)
        : fail(context, TERRA_STATUS_INVALID_ARGUMENT, terra::frame::surface_mesh_status_message(status));
  }
  return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "resource is not in the prepared candidate");
}

terra_status terra_get_prepared_mesh_positions(const terra_context* context,
    std::uint32_t plan_id, std::uint32_t resource_id, std::uint32_t first_vertex,
    std::uint32_t vertex_count, float* output) {
  if (!current_mesh_plan(context, plan_id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale position plan");
  const auto& plan = *context->prepared_mesh;
  for (const auto& resource : plan.output.frame_surfaces) {
    if (resource->id != resource_id) continue;
    const auto& m = context->manifest;
    const auto total = (m.patch_dimension + 1U) * (m.patch_dimension + 2U) / 2U;
    if (vertex_count > TERRA_MESH_SAMPLE_LIMIT || (vertex_count && !output) ||
        first_vertex > total || vertex_count > total - first_vertex)
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid position sample range");
    const auto& mesh = resource->mesh;
    if (!mesh.positions_xyz.empty()) {
      // Mixed candidates and partially produced plans must read their actual
      // immutable payload, not heights that may have since been refined.
      if (vertex_count) std::copy_n(mesh.positions_xyz.data() + first_vertex * 3U, vertex_count * 3U, output);
      return succeed(context);
    }
    const auto height = plan.height_inputs.find(to_key(mesh.patch));
    if (height == plan.height_inputs.end() || !height->second->has_fragment(mesh.fragment))
      return fail(context, TERRA_STATUS_INVALID_STATE, "missing prepared height");
    const terra::core::bounds2d bounds({{m.minimum_u, m.minimum_v}}, {{m.maximum_u, m.maximum_v}});
    const auto status = terra::frame::sample_patch_positions(mesh.patch, mesh.fragment,
        height->second->value().fragments[mesh.fragment], m.height_scale_factor,
        m.transform == TERRA_TRANSFORM_CYLINDRICAL, m.radius, bounds, first_vertex, vertex_count, output);
    return status == terra::frame::surface_mesh_status::ok ? succeed(context)
        : fail(context, TERRA_STATUS_INVALID_ARGUMENT, terra::frame::surface_mesh_status_message(status));
  }
  return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "resource is not in the prepared candidate");
}

std::uint32_t terra_mesh_replacement_work_bytes(const terra_context* context, std::uint32_t id,
                                               const std::uint32_t* before, std::size_t count) {
  if (!current_mesh_plan(context, id) || (count && !before) || count > context->presented_surfaces.size()) return 0U;
  for (std::size_t i = 0U; i < count; ++i)
    if (!before[i] || (i && before[i - 1U] >= before[i])) return 0U;
  std::size_t members = count, retained = 0U;
  for (const auto& draw : context->prepared_mesh->output.mesh_resources) {
    if (draw.draw.flags & TERRA_DRAW_FLAG_COVERAGE) continue;
    ++members;
    if (count && std::binary_search(before, before + count, draw.resource_id)) ++retained;
  }
  const auto bytes = terra::frame::surface_replacement_plan::payload_bound(
      members, 3U * context->manifest.patch_dimension, retained);
  return bytes <= UINT32_MAX ? static_cast<std::uint32_t>(bytes) : 0U;
}

terra_status terra_begin_mesh_replacement(terra_context* context, std::uint32_t id,
    const std::uint32_t* before, std::size_t count, std::uint32_t credit) {
  if (!current_mesh_plan(context, id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale boundary plan");
  auto& plan = *context->prepared_mesh;
  if ((plan.production_started && plan.production_cursor != plan.output.frame_surfaces.size()) ||
      plan.replacement || !plan.target.empty() || (count && !before) || count > context->presented_surfaces.size())
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary owners");
  for (std::size_t i = 0U; i < count; ++i)
    if (!before[i] || (i && before[i - 1U] >= before[i]))
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary owners");
  const auto bytes = terra_mesh_replacement_work_bytes(context, id, before, count);
  if (!bytes || credit < bytes) return fail(context, TERRA_STATUS_CAPACITY_PENDING, "insufficient boundary credit");
  TERRA_C_API_TRY {
    std::vector<terra_replacement_input> inputs;
    inputs.reserve(count + plan.output.frame_surfaces.size());
    inputs.resize(count);
    if (count) for (const auto& resource : context->presented_surfaces) {
      const auto found = std::lower_bound(before, before + count, resource->id);
      if (found != before + count && *found == resource->id) inputs[found - before] = {resource, false};
    }
    for (const auto& input : inputs)
      if (!input.resource) return fail(context, TERRA_STATUS_INVALID_STATE, "unowned boundary input");
    std::size_t member_count = count, retained_count = 0U;
    for (std::size_t i = 0U; i < plan.output.mesh_resources.size(); ++i) {
      if (plan.output.mesh_resources[i].draw.flags & TERRA_DRAW_FLAG_COVERAGE) continue;
      ++member_count;
      const auto& resource = plan.output.frame_surfaces[i];
      const auto found = count ? std::lower_bound(before, before + count, resource->id) : before;
      if (count && found != before + count && *found == resource->id) {
        inputs[found - before].retained = true;
        ++retained_count;
      } else inputs.push_back({resource, true});
    }
    std::unique_ptr<terra::frame::surface_replacement_plan> work(new terra::frame::surface_replacement_plan(
        member_count, 3U * context->manifest.patch_dimension,
        context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL, retained_count));
    plan.replacement_inputs = std::move(inputs);
    plan.replacement = std::move(work);
    plan.replacement_members.clear();
    plan.replacement_sealed = false;
    plan.replacement_cursor = 0U;
    plan.replacement_complete = false;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "boundary allocation failed")
}

static terra_status mesh_boundary(terra_context& context, const terra_mesh_resource& resource,
                                  std::vector<terra::frame::replacement_point>& points) {
  const auto& source = resource.mesh;
  const auto& m = context.manifest;
  terra::frame::patch_surface_mesh generated;
  const auto* mesh = &source;
  const bool full = !source.positions_xyz.empty();
  if (!full) {
    const auto& inputs = context.prepared_mesh->height_inputs;
    const auto height = inputs.find(to_key(source.patch));
    if (height == inputs.end() || !height->second->has_fragment(source.fragment))
      return fail(&context, TERRA_STATUS_INVALID_STATE, "missing boundary height");
    const auto& input = height->second->value().fragments[source.fragment];
    const auto status = m.transform == TERRA_TRANSFORM_CYLINDRICAL
        ? terra::frame::make_cylindrical_patch_boundary(source.patch, source.fragment, input,
            m.height_scale_factor, m.radius, generated)
        : terra::frame::make_planar_patch_boundary(source.patch, source.fragment, input,
            m.height_scale_factor, terra::core::bounds2d({{m.minimum_u, m.minimum_v}},
            {{m.maximum_u, m.maximum_v}}), generated);
    if (status != terra::frame::surface_mesh_status::ok)
      return fail(&context, TERRA_STATUS_INTERNAL_ERROR, terra::frame::surface_mesh_status_message(status));
    mesh = &generated;
  }
  points.resize(m.patch_dimension * 3U);
  const auto& texture_uv = full ? resource.texture_uv->values : generated.texture_uv;
  const auto scale = std::ldexp(1.0, 28 - static_cast<int>(source.texture_node.level));
  std::size_t row_begin = 0U, boundary = 0U;
  for (std::uint32_t y = 0U; y <= m.patch_dimension; ++y) {
    const auto last = m.patch_dimension - y;
    const auto stride = y && last ? last : 1U;
    for (std::uint32_t x = 0U; x <= last; x += stride) {
      const auto index = full ? row_begin + x : boundary;
      ++boundary;
      const double u = (source.texture_node.column + static_cast<double>(texture_uv[index * 2U])) * scale;
      const double v = (source.texture_node.row + static_cast<double>(texture_uv[index * 2U + 1U])) * scale;
      if (!std::isfinite(u) || !std::isfinite(v) || u < 0.0 || v < 0.0 || u > 1073741824.0 ||
          v > 1073741824.0 || std::floor(u) != u || std::floor(v) != v)
        return fail(&context, TERRA_STATUS_UNSUPPORTED, "inexact boundary coordinates");
      terra::frame::replacement_point point;
      point.u = static_cast<std::int64_t>(u); point.v = static_cast<std::int64_t>(v);
      for (std::size_t axis = 0U; axis < 3U; ++axis)
        point.world[axis] = source.origin[axis] + mesh->positions_xyz[index * 3U + axis];
      const auto perimeter = y == 0U ? x : (x + y == m.patch_dimension
          ? m.patch_dimension + y : 3U * m.patch_dimension - y);
      points[perimeter] = point;
    }
    row_begin += last + 1U;
  }
  return TERRA_STATUS_OK;
}

terra_status terra_step_mesh_replacement(terra_context* context, std::uint32_t id,
    std::uint32_t maximum_operations, std::uint32_t* complete) {
  if (!current_mesh_plan(context, id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale boundary plan");
  auto& plan = *context->prepared_mesh;
  if (!complete || !maximum_operations || !plan.replacement)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary continuation");
  TERRA_C_API_TRY {
    *complete = 0U;
    std::uint32_t surfaces = 0U;
    while (plan.replacement_cursor < plan.replacement_inputs.size() && surfaces < std::min(4U, maximum_operations)) {
      const auto& input = plan.replacement_inputs[plan.replacement_cursor];
      std::vector<terra::frame::replacement_point> points;
      const auto status = mesh_boundary(*context, *input.resource, points);
      if (status != TERRA_STATUS_OK) return status;
      const bool added = input.retained
          ? plan.replacement->retain(input.resource->id, std::move(points))
          : plan.replacement->add(input.resource->id, input.after, std::move(points));
      if (!added)
        return fail(context, TERRA_STATUS_UNSUPPORTED, "invalid CBDAM boundary");
      ++plan.replacement_cursor; ++surfaces;
    }
    if (surfaces) return succeed(context);
    plan.replacement_complete = plan.replacement->step(maximum_operations);
    *complete = plan.replacement_complete ? 1U : 0U;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "boundary continuation failed")
}

terra_status terra_get_mesh_replacement(const terra_context* context, std::uint32_t id,
    terra_replacement_member_v1* members, std::size_t capacity, std::size_t* count) {
  if (!current_mesh_plan(context, id) || (!context->prepared_mesh->replacement_complete &&
      !context->prepared_mesh->replacement_sealed))
    return fail(context, TERRA_STATUS_INVALID_STATE, "incomplete boundary plan");
  const auto& plan = *context->prepared_mesh;
  const auto& values = plan.replacement_sealed ? plan.replacement_members : plan.replacement->members();
  if (!count || (!members && capacity)) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary output");
  *count = values.size();
  if (capacity < values.size()) return fail(context, TERRA_STATUS_BUFFER_TOO_SMALL, "boundary output too small");
  for (std::size_t i = 0U; i < values.size(); ++i)
    members[i] = {values[i].group, values[i].after, values[i].resource_id};
  return succeed(context);
}

terra_status terra_end_mesh_replacement(terra_context* context, std::uint32_t id) {
  if (!context || !context->prepared_mesh || context->prepared_mesh->description.plan_id != id)
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale boundary plan");
  auto& plan = *context->prepared_mesh;
  auto work = std::move(plan.replacement);
  std::vector<terra_replacement_input>().swap(plan.replacement_inputs);
  const bool complete = plan.replacement_complete;
  plan.replacement_complete = false;
  TERRA_C_API_TRY {
    if (complete && work) {
      plan.replacement_members = work->take_members();
      work.reset();
      plan.replacement_sealed = true;
      std::unique_ptr<terra_replacement_history> history(new terra_replacement_history());
      history->model_revision = plan.description.state.model_revision;
      history->frame = plan.description.frame;
      history->target = mesh_targets(plan.output);
      history->members = plan.replacement_members;
      context->replacement_history = std::move(history);
    }
    return succeed(context);
  } TERRA_C_API_CATCH(context, "boundary history allocation failed")
}

terra_status terra_reuse_mesh_replacement(terra_context* context, std::uint32_t id,
    const std::uint32_t* before_ids, std::size_t count, std::uint32_t* reused) {
  if (!current_mesh_plan(context, id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale boundary reuse");
  auto& plan = *context->prepared_mesh;
  if (!reused || (count && !before_ids) || plan.production_started || plan.replacement || !plan.target.empty() ||
      count > context->presented_surfaces.size())
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary reuse input");
  *reused = 0U;
  for (std::size_t i = 0U; i < count; ++i)
    if (!before_ids[i] || (i && before_ids[i - 1U] >= before_ids[i]))
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid boundary reuse IDs");
  TERRA_C_API_TRY {
    std::set<std::uint32_t> owned;
    for (const auto& resource : context->presented_surfaces) owned.insert(resource->id);
    for (std::size_t i = 0U; i < count; ++i)
      if (!owned.count(before_ids[i])) return fail(context, TERRA_STATUS_INVALID_STATE, "unowned boundary reuse input");
    if (!replacement_history_current(*context)) return succeed(context);
    const auto& history = *context->replacement_history;
    std::set<std::uint32_t> expected, actual;
    for (const auto& target : history.target)
      if (!(target.description.draw.flags & TERRA_DRAW_FLAG_COVERAGE)) expected.insert(target.description.resource_id);
    for (const auto& draw : plan.output.mesh_resources)
      if (!(draw.draw.flags & TERRA_DRAW_FLAG_COVERAGE)) actual.insert(draw.resource_id);
    if (expected != actual) return succeed(context);
    std::vector<std::uint32_t> displayed;
    if (count) displayed.assign(before_ids, before_ids + count);
    std::vector<terra::frame::replacement_member> proof;
    if (!terra::frame::surface_replacement_plan::rebase(history.members, displayed, proof))
      return succeed(context);
    plan.replacement_members = std::move(proof);
    plan.replacement_sealed = true;
    *reused = 1U;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "boundary reuse failed")
}

terra_status terra_select_mesh_groups(terra_context* context, std::uint32_t id,
    const std::uint32_t* groups, std::size_t count, terra_mesh_plan_v1* description) {
  if (!current_mesh_plan(context, id)) return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh group plan");
  auto& plan = *context->prepared_mesh;
  if (!valid_input(description) || !count || !groups ||
      (plan.production_started && plan.production_cursor != plan.output.frame_surfaces.size()) ||
      plan.replacement || plan.replacement_members.empty() ||
      !plan.description.frame.coverage_complete || plan.description.frame.omitted_draw_count)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh group selection");
  const auto& members = plan.replacement_members;
  std::uint32_t group_count = 0U;
  for (const auto& member : members) group_count = std::max(group_count, member.group + 1U);
  if (count > group_count) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh group count");
  for (std::size_t i = 0U; i < count; ++i)
    if (groups[i] >= group_count || (i && groups[i - 1U] >= groups[i]))
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh group IDs");
  TERRA_C_API_TRY {
    std::map<std::uint32_t, std::shared_ptr<terra_mesh_resource>> old;
    for (const auto& resource : context->presented_surfaces) old.emplace(resource->id, resource);
    std::vector<std::set<std::uint32_t>> before(group_count), after(group_count);
    std::set<std::uint32_t> keep;
    for (const auto& member : members) {
      (member.after ? after : before)[member.group].insert(member.resource_id);
      if (!member.after && !old.count(member.resource_id))
        return fail(context, TERRA_STATUS_INVALID_STATE, "mesh group input was retired");
      const bool selected = std::binary_search(groups, groups + count, member.group);
      if (selected == (member.after != 0U)) keep.insert(member.resource_id);
    }
    std::uint32_t pending = 0U;
    for (std::uint32_t group = 0U; group < group_count; ++group)
      if (!std::binary_search(groups, groups + count, group) && before[group] != after[group]) ++pending;
    if (plan.target.empty()) {
      plan.target = mesh_targets(plan.output);
      plan.target_frame = plan.description.frame;
    }
    terra_mesh_output output;
    std::map<std::uint32_t, std::shared_ptr<terra_mesh_resource>> aliases;
    for (auto& target : plan.target) {
      const auto& value = target.description;
      if (!(value.draw.flags & TERRA_DRAW_FLAG_COVERAGE) && !keep.erase(value.resource_id)) continue;
      append_mesh_target(*context, output, target, aliases);
    }
    for (const auto resource_id : keep) {
      const auto found = old.find(resource_id);
      if (found == old.end()) return fail(context, TERRA_STATUS_INVALID_STATE, "missing mesh group input");
      const auto& resource = found->second;
      const auto& mesh = resource->mesh;
      terra_mesh_resource_v3 value{};
      value.struct_size = sizeof(value); value.resource_id = resource_id;
      value.position_float_count = static_cast<std::uint32_t>(mesh.positions_xyz.size());
      value.texture_float_count = static_cast<std::uint32_t>(resource->texture_uv->values.size());
      value.texture_resource_id = resource->texture_id;
      auto& draw = value.draw;
      draw.struct_size = sizeof(draw); draw.fragment = mesh.fragment; draw.key = to_key(mesh.patch);
      draw.texture = {static_cast<std::uint32_t>(mesh.texture_node.level),
        static_cast<std::int32_t>(mesh.texture_node.root(context->manifest.transform == TERRA_TRANSFORM_CYLINDRICAL)),
        static_cast<std::int32_t>(mesh.texture_node.row), static_cast<std::int32_t>(mesh.texture_node.column)};
      draw.vertex_count = value.position_float_count / 3U;
      draw.index_count = static_cast<std::uint32_t>(context->index_buffer.size());
      std::copy(mesh.origin.begin(), mesh.origin.end(), draw.origin);
      append_mesh_resource(output, resource, value);
    }
    auto frame = plan.target_frame;
    frame.draw_count = static_cast<std::uint32_t>(output.mesh_resources.size());
    frame.vertex_count = static_cast<std::uint32_t>(output.position_float_count / 3U);
    frame.position_float_count = static_cast<std::uint32_t>(output.position_float_count);
    frame.texture_float_count = static_cast<std::uint32_t>(output.texture_float_count);
    frame.expected_draw_count = frame.draw_count - frame.coverage_draw_count;
    if (pending) frame.decisions_complete = 0U;
    plan.output = std::move(output);
    // A fully generated but unpublished cut may be replaced by another safe
    // group selection. Reprice new allocations and require production again;
    // already generated immutable resources remain reusable and accounted.
    plan.production_started = false;
    plan.production_cursor = 0U;
    plan.production_credit = 0U;
    plan.description.frame = frame;
    plan.description.state.pending_mesh_group_count = pending;
    describe_mesh_costs(*context, plan);
    *description = plan.description;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "mesh group selection failed")
}

terra_status terra_set_height_work_limit(terra_context* context, std::uint32_t bytes,
                                        std::uint32_t maximum_builds) {
  if (!context || bytes > context->height_storage.maximum_bytes() || !maximum_builds)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid height production window");
  context->height_work_limit = bytes;
  context->height_work_builds = maximum_builds;
  return succeed(context);
}

std::uint32_t terra_height_work_bytes(const terra_context* context) {
  return context && context->terrain_work ? static_cast<std::uint32_t>(context->terrain_work->next_bytes) : 0U;
}

std::uint32_t terra_height_payload_bytes(const terra_context* context) {
  return context ? static_cast<std::uint32_t>(height_payload_bytes(*context)) : 0U;
}

terra_status terra_trim_height_cache(terra_context* context, std::uint32_t maximum_bytes) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  TERRA_C_API_TRY {
    const auto maximum = context->height_storage.maximum_bytes();
    const auto& cut = context->terrain_work ? context->terrain_work->cut : context->height_active_cut;
    prune_height_cache(*context, cut, maximum - std::min<std::size_t>(maximum, maximum_bytes),
        context->terrain_work ? refine_leaf_heights(*context->terrain_work) : context->height_active_refine_leaves);
    return succeed(context);
  } TERRA_C_API_CATCH(context, "height cache reclamation failed")
}

terra_status terra_discard_terrain_work(terra_context* context) {
  if (!context) return TERRA_STATUS_INVALID_ARGUMENT;
  context->terrain_work.reset();
  return succeed(context);
}

terra_status terra_advance_terrain(terra_context* context, float lod_threshold,
                                  const terra_update_budget_v2* budget,
                                  terra_update_state_v2* progress) {
  if (!valid_input(progress)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid terrain progress output");
  }
  return step_terrain(context, lod_threshold, budget, progress);
}

float terra_get_terrain_error(const terra_context* context) {
  float error = 0.0F;
  if (context) for (const auto& patch : context->patches)
    if (patch.visible) error = std::max(error, patch.priority);
  return error;
}

std::uint32_t terra_sizeof_terrain_sample_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_terrain_sample_v1));
}

terra_status terra_sample_terrain(const terra_context* context, double u, double v,
                                  terra_terrain_sample_v1* sample) {
  if (!context || !valid_input(sample) || !std::isfinite(u) || !std::isfinite(v))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid terrain query");
  if (!context->manifest_loaded)
    return fail(context, TERRA_STATUS_INVALID_STATE, "terrain query requires a manifest");
  const auto& m = context->manifest;
  const bool globe = m.transform == TERRA_TRANSFORM_CYLINDRICAL;
  if (u < (globe ? -180.0 : m.minimum_u) || u > (globe ? 180.0 : m.maximum_u) ||
      v < (globe ? -90.0 : m.minimum_v) || v > (globe ? 90.0 : m.maximum_v))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "terrain query outside dataset coordinates");
  const auto point = terra::frame::height_query_grid(u, v, globe,
      terra::core::bounds2d({{m.minimum_u, m.minimum_v}}, {{m.maximum_u, m.maximum_v}}));
  terra_terrain_sample_v1 result{};
  result.struct_size = sizeof(result);
  result.api_version = TERRA_C_API_VERSION;
  result.height_revision = context->height_revision;
  // This scan is bounded by the existing height-cache capacity. No render
  // arrays are constructed, transferred or retained for a query.
  for (const auto& entry : context->heights) {
    if (result.available && entry.first.level <= result.key.level) continue;
    for (std::size_t f = 0U; f < 2U; ++f) {
      double height = 0.0;
      const auto& h = entry.second;
      if (!h.has_fragment(f) || !terra::frame::sample_height_fragment(
          h.diamond, f, h.samples->value().fragments[f], point, height)) continue;
      result.available = 1U;
      result.fragment = static_cast<std::uint32_t>(f);
      result.key = entry.first;
      result.height_metres = height * m.height_scale_factor;
      result.data_level = h.data_level[f];
      result.sample_spacing_metres = h.data_spacing[f];
      break;
    }
  }
  *sample = result;
  return succeed(context);
}

std::uint32_t terra_sizeof_height_query_state_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_height_query_state_v1));
}
std::uint32_t terra_sizeof_height_region_v1(void) { return sizeof(terra_height_region_v1); }

terra_status terra_get_height_query_region(const terra_context* context, std::uint32_t id,
    terra_height_region_v1* output, std::int32_t* values, std::size_t capacity, std::size_t* count) {
  if (!valid_height_query(context, id) || !valid_input(output) || !count)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale or invalid height region");
  const auto& query = *context->height_query;
  if (query.state() != terra::frame::height_session_state::ready &&
      query.state() != terra::frame::height_session_state::limited)
    return fail(context, TERRA_STATUS_INVALID_STATE, "height region requires a completed query");
  const auto& region = query.region();
  *output = terra_height_region_v1{};
  output->struct_size = sizeof(*output); output->api_version = TERRA_C_API_VERSION;
  output->dimension = region.heights.dimension;
  output->value_count = static_cast<std::uint32_t>(region.heights.values.size());
  for (std::size_t c = 0U; c < 3U; ++c) for (std::size_t axis = 0U; axis < 3U; ++axis)
    output->grid_corners[3U * c + axis] = region.corners[c][axis];
  output->geometry_spacing_metres = region.geometry_spacing_metres;
  output->height_scale = region.height_scale;
  return copy_vector(context, &region.heights.values, values, capacity, count);
}

terra_status terra_begin_height_query(terra_context* context, double u, double v,
    double spacing, std::uint32_t maximum_level, std::uint32_t maximum_bytes,
    terra_height_query_state_v1* state) {
  if (!context || !valid_input(state))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid height query");
  if (!context->manifest_loaded || context->height_query)
    return fail(context, TERRA_STATUS_INVALID_STATE, "height query needs a manifest and a free query slot");
  if (context->next_height_query_id == UINT32_MAX)
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "height query IDs exhausted");
  TERRA_C_API_TRY {
    const auto& m = context->manifest;
    terra::frame::height_demand_request request;
    request.cylindrical = m.transform == TERRA_TRANSFORM_CYLINDRICAL;
    request.bounds = terra::core::bounds2d({{m.minimum_u, m.minimum_v}}, {{m.maximum_u, m.maximum_v}});
    request.radius = m.radius; request.patch_dimension = m.patch_dimension;
    request.u = u; request.v = v; request.sample_spacing_metres = spacing;
    request.maximum_level = maximum_level;
    std::unique_ptr<terra::frame::height_session> query(new terra::frame::height_session());
    if (query->begin(request, m.height_scale_factor, maximum_bytes) == terra::frame::height_session_state::failed)
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid height query options");
    context->height_query = std::move(query);
    context->height_query_id = context->next_height_query_id++;
    describe_height_query(*context, *state);
    return succeed(context);
  } TERRA_C_API_CATCH(context, "height query allocation failed")
}

terra_status terra_step_height_query(terra_context* context, std::uint32_t id,
    std::uint32_t maximum_work, terra_height_query_state_v1* state) {
  if (!valid_height_query(context, id) || !valid_input(state) || maximum_work > 1024U)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale or invalid height query step");
  TERRA_C_API_TRY {
    auto& query = *context->height_query;
    for (std::uint32_t i = 0U; i < maximum_work; ++i) {
      if (query.state() != terra::frame::height_session_state::waiting) query.step(1U);
      else {
        bool reused = false;
        // Read existing decoded records without pinning or mutating the display
        // cache. The query owns its admitted copy through reconstruction.
        const auto requests = query.requests();
        for (const auto& request : requests) {
          const terra_patch_key_v1 key{request.level, request.id[0], request.id[1], request.id[2]};
          const auto kind = request.root ? TERRA_REQUEST_ROOT : TERRA_REQUEST_DETAIL;
          const auto record = find_record(*context, kind, key);
          if (record && query.can_decode(request)) {
            auto copy = record->values();
            reused = query.submit(request, std::move(copy)); break;
          }
          if (!request.root && context->confirmed_no_data.count(key)) {
            reused = query.unavailable(request, false); break;
          }
        }
        if (!reused) break;
      }
      if (query.state() >= terra::frame::height_session_state::ready) break;
    }
    describe_height_query(*context, *state);
    return succeed(context);
  } TERRA_C_API_CATCH(context, "height query work failed")
}

terra_status terra_get_height_query_requests(const terra_context* context, std::uint32_t id,
    terra_request_v1* output, std::size_t capacity, std::size_t* count) {
  if (!valid_height_query(context, id) || !count)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale height query requests");
  *count = context->height_query->requests().size();
  if (capacity < *count || (*count && !output))
    return fail(context, TERRA_STATUS_BUFFER_TOO_SMALL, "height query request buffer is too small");
  for (std::size_t i = 0U; i < *count; ++i) {
    const auto& r = context->height_query->requests()[i];
    output[i] = terra_request_v1{}; output[i].struct_size = sizeof(terra_request_v1);
    output[i].kind = r.root ? TERRA_REQUEST_ROOT : TERRA_REQUEST_DETAIL;
    output[i].key = {r.level, r.id[0], r.id[1], r.id[2]};
  }
  return succeed(context);
}

terra_status terra_submit_height_query_record(terra_context* context, std::uint32_t id,
    std::uint32_t kind, const terra_patch_key_v1* key, const std::uint8_t* data, std::size_t size) {
  if (!valid_height_query(context, id) || !key || !valid_key(*key) ||
      !valid_record_kind(kind) || !data || !size)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale or invalid height query record");
  const terra::frame::height_session_request request{key->level, {{key->i, key->j, key->k}}, kind == TERRA_REQUEST_ROOT};
  const auto input = context->height_query->input_state(request);
  if (input == terra::frame::height_input_state::consumed) return succeed(context);
  if (input != terra::frame::height_input_state::pending)
    return fail(context, TERRA_STATUS_NOT_FOUND, "height query record is not requested");
  if (!context->height_query->can_decode(request))
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "height query record exceeds its credit");
  const auto dimension = context->manifest.patch_dimension + (request.root ? 1U : 0U);
  if (size > std::size_t(dimension) * dimension * 16U + 4096U)
    return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "height query encoded record exceeds ingress credit");
  TERRA_C_API_TRY {
    terra::codec::height_patch decoded;
    const auto decoded_status = terra::codec::decode_cbdam_height_record_patch(data, size, dimension, decoded);
    if (decoded_status != terra::codec::decode_status::ok)
      return fail(context, map_decode_status(decoded_status), "height query decode/shape failed");
    if (!context->height_query->submit(request, std::move(decoded)))
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "height query decoded record exceeds credit");
    return succeed(context);
  } TERRA_C_API_CATCH(context, "height query record allocation failed")
}

terra_status terra_height_query_unavailable(terra_context* context, std::uint32_t id,
    std::uint32_t kind, const terra_patch_key_v1* key, std::uint32_t failed) {
  if (!valid_height_query(context, id) || !key || !valid_key(*key) || !valid_record_kind(kind) || failed > 1U)
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale height query failure");
  const terra::frame::height_session_request request{key->level, {{key->i, key->j, key->k}}, kind == TERRA_REQUEST_ROOT};
  if (context->height_query->input_state(request) == terra::frame::height_input_state::consumed)
    return succeed(context);
  if (!context->height_query->unavailable(request, failed != 0U))
    return fail(context, TERRA_STATUS_NOT_FOUND, "height query failure is not requested");
  return succeed(context);
}

terra_status terra_end_height_query(terra_context* context, std::uint32_t id) {
  if (!valid_height_query(context, id))
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "stale height query release");
  context->height_query.reset(); context->height_query_id = 0U;
  return succeed(context);
}

std::uint32_t terra_get_no_data_count(const terra_context* context) {
  return context ? static_cast<std::uint32_t>(context->confirmed_no_data.size()) : 0U;
}

terra_status terra_get_update_state(const terra_context* context,
                                    terra_update_state_v2* state) {
  if (context == nullptr || !valid_input(state)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid update state");
  }
  if (context->sequence == 0U) {
    return fail(context, TERRA_STATUS_INVALID_STATE, "no update is available");
  }
  *state = context->update_state;
  state->mesh_bytes = mesh_payload_bytes(*context);
  state->decoded_record_bytes = context->record_storage.resident_bytes();
  state->height_bytes = height_payload_bytes(*context);
  return succeed(context);
}

terra_status terra_get_mesh_resources(const terra_context* context,
                                      terra_mesh_resource_v3* resources,
                                      std::size_t capacity,
                                      std::size_t* count) {
  return copy_vector(context, context == nullptr ? nullptr : &context->output.mesh_resources,
      resources, capacity, count);
}

terra_status terra_acquire_mesh_resource(terra_context* context, std::uint32_t id) {
  if (!context || !id) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh loan");
  const auto found = context->mesh_registry.find(id);
  const auto resource = found == context->mesh_registry.end() ? nullptr : found->second.lock();
  if (!resource || resource->mesh.positions_xyz.empty())
    return fail(context, TERRA_STATUS_INVALID_STATE, "mesh payload is unavailable");
  TERRA_C_API_TRY {
    auto& loan = context->mesh_loans[id];
    if (loan.second == UINT32_MAX)
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT, "mesh loan count exhausted");
    loan.first = resource;
    ++loan.second;
    return succeed(context);
  } TERRA_C_API_CATCH(context, "mesh loan allocation failed")
}

terra_status terra_release_mesh_resource(terra_context* context, std::uint32_t id) {
  if (!context || !id) return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh loan");
  const auto found = context->mesh_loans.find(id);
  if (found == context->mesh_loans.end())
    return fail(context, TERRA_STATUS_INVALID_STATE, "mesh loan is not owned");
  if (--found->second.second == 0U) context->mesh_loans.erase(found);
  return succeed(context);
}

const float* terra_get_mesh_position_view(const terra_context* context,
                                         std::uint32_t resource_id) {
  if (context == nullptr) return nullptr;
  const auto found = context->mesh_registry.find(resource_id);
  if (found == context->mesh_registry.end()) return nullptr;
  const auto resource = found->second.lock();
  return resource && !resource->mesh.positions_xyz.empty()
      ? resource->mesh.positions_xyz.data() : nullptr;
}

const float* terra_get_mesh_texture_view(const terra_context* context,
                                        std::uint32_t resource_id) {
  if (context == nullptr) return nullptr;
  const auto found = context->mesh_registry.find(resource_id);
  if (found == context->mesh_registry.end()) return nullptr;
  const auto resource = found->second.lock();
  return resource && resource->texture_uv && !resource->texture_uv->values.empty() && !resource->mesh.positions_xyz.empty()
      ? resource->texture_uv->values.data() : nullptr;
}

terra_status terra_present_frame(terra_context* context,
                                 const terra_frame_receipt_v2* receipt) {
  if (context == nullptr || !valid_input(receipt) ||
      receipt->api_version != TERRA_UPDATE_API_VERSION) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid frame receipt");
  }
  if (context->sequence == 0U || receipt->sequence != context->sequence) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "only the current candidate can be presented");
  }
  context->presented_surfaces = context->output.frame_surfaces;
  return succeed(context);
}

terra_status terra_retain_meshes(terra_context* context,
                                const terra_frame_receipt_v2* receipt,
                                const std::uint32_t* resource_ids,
                                std::size_t count) {
  if (context == nullptr || !valid_input(receipt) ||
      receipt->api_version != TERRA_UPDATE_API_VERSION ||
      (count > 0U && resource_ids == nullptr)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid mesh retention");
  }
  if (context->sequence == 0U || receipt->sequence != context->sequence) {
    return fail(context, TERRA_STATUS_INVALID_STATE, "stale mesh retention");
  }
  if (count > context->presented_surfaces.size() + context->output.frame_surfaces.size()) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid retention count");
  }
  for (std::size_t i = 0U; i < count; ++i) {
    if (resource_ids[i] == 0U || (i > 0U && resource_ids[i - 1U] >= resource_ids[i])) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT, "invalid retention IDs");
    }
  }
  TERRA_C_API_TRY {
    std::vector<std::shared_ptr<terra_mesh_resource>> retained(count);
    if (count > 0U) {
      const auto select = [&](const std::shared_ptr<terra_mesh_resource>& mesh) {
        const auto found = std::lower_bound(resource_ids, resource_ids + count, mesh->id);
        if (found != resource_ids + count && *found == mesh->id) {
          retained[found - resource_ids] = mesh;
        }
      };
      for (const auto& mesh : context->presented_surfaces) select(mesh);
      for (const auto& mesh : context->output.frame_surfaces) select(mesh);
    }
    if (std::any_of(retained.begin(), retained.end(),
        [](const std::shared_ptr<terra_mesh_resource>& mesh) { return !mesh; })) {
      return fail(context, TERRA_STATUS_INVALID_STATE, "mesh has no presentation owner");
    }
    context->presented_surfaces.swap(retained);
    return succeed(context);
  } TERRA_C_API_CATCH(context, "mesh retention failed")
}

terra_status terra_get_camera_snapshot(
    const terra_context* context,
    terra_camera_snapshot_v1* snapshot) {
  if (context == nullptr || !valid_input(snapshot)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid camera snapshot output");
  }
  TERRA_C_API_TRY {
    terra::frame::camera_snapshot value;
    const terra_status status = make_camera_snapshot(context, value);
    if (status != TERRA_STATUS_OK) {
      return status;
    }
    snapshot->struct_size = sizeof(terra_camera_snapshot_v1);
    snapshot->api_version = TERRA_C_API_VERSION;
    std::copy(value.position.begin(), value.position.end(),
              snapshot->camera_position);
    std::copy(value.projection_view.begin(), value.projection_view.end(),
              snapshot->projection_view);
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected camera snapshot error")
}

terra_status terra_get_requests(const terra_context* context,
                                terra_request_v1* requests,
                                std::size_t capacity,
                                std::size_t* count) {
  return copy_vector(context, context == nullptr ? nullptr : &context->requests,
                     requests, capacity, count);
}

terra_status terra_get_frame(const terra_context* context,
                             terra_frame_v1* frame) {
  if (context == nullptr || !valid_input(frame)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid frame output");
  }
  if (context->sequence == 0U) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "no frame is available");
  }
  *frame = context->frame;
  return succeed(context);
}

terra_status terra_get_frame_patches(const terra_context* context,
                                     terra_patch_decision_v1* patches,
                                     std::size_t capacity,
                                     std::size_t* count) {
  return copy_vector(context, context == nullptr ? nullptr : &context->patches,
                     patches, capacity, count);
}

terra_status terra_get_index_buffer(const terra_context* context,
                                    std::uint16_t* indices,
                                    std::size_t capacity,
                                    std::size_t* count) {
  return copy_vector(context, context == nullptr ? nullptr : &context->index_buffer,
                     indices, capacity, count);
}

terra_status terra_get_stats(const terra_context* context,
                             terra_stats_v1* stats) {
  if (context == nullptr || !valid_input(stats)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid stats output");
  }
  *stats = context->stats;
  return succeed(context);
}

terra_status terra_get_last_error(const terra_context* context, char* buffer,
                                  std::size_t capacity,
                                  std::size_t* required_size) {
  if (context == nullptr || required_size == nullptr) {
    return TERRA_STATUS_INVALID_ARGUMENT;
  }
  *required_size = context->last_error.size() + 1U;
  if (buffer == nullptr || capacity < *required_size) {
    return TERRA_STATUS_BUFFER_TOO_SMALL;
  }
  std::memcpy(buffer, context->last_error.c_str(), *required_size);
  return TERRA_STATUS_OK;
}

void* terra_alloc(std::size_t size) { return std::malloc(size); }

void terra_free(void* memory) { std::free(memory); }

}  // extern "C"

namespace terra {
namespace c_api_detail {
bool borrow_surface_source(const terra_context* context, std::uint32_t plan_id,
    std::uint32_t resource_id, frame::surface_source& output,imagery::node_key* anchor) {
  if (!context || !context->manifest_loaded || !resource_id) return false;
  std::shared_ptr<terra_mesh_resource> resource;
  std::shared_ptr<const frame::height_storage::block> heights;
  if (plan_id) {
    if (!context->prepared_mesh || context->prepared_mesh->description.plan_id != plan_id) return false;
    const auto& plan = *context->prepared_mesh;
    for (const auto& value : plan.output.frame_surfaces) if (value->id == resource_id) {resource = value; break;}
    if (!resource) return false;
    const auto found = plan.height_inputs.find(to_key(resource->mesh.patch));
    if (found != plan.height_inputs.end()) heights = found->second;
  } else {
    const auto found = context->mesh_registry.find(resource_id);
    if (found == context->mesh_registry.end()) return false;
    resource = found->second.lock();
    if (!resource || resource->mesh.positions_xyz.empty()) return false;
  }
  const auto& m = context->manifest;
  frame::surface_source_parameters parameters;
  parameters.dimension = m.patch_dimension; parameters.height_scale = m.height_scale_factor;
  parameters.radius = m.radius; parameters.cylindrical = m.transform == TERRA_TRANSFORM_CYLINDRICAL;
  parameters.bounds = core::bounds2d({{m.minimum_u,m.minimum_v}},{{m.maximum_u,m.maximum_v}});
  frame::surface_source source(std::shared_ptr<const frame::patch_surface_mesh>(resource,&resource->mesh),
      std::shared_ptr<const std::vector<float>>(resource->texture_uv, &resource->texture_uv->values), heights, parameters);
  if (!source.valid()) return false;
  output = std::move(source);if(anchor)*anchor=resource->mesh.texture_node;return true;
}
} // namespace c_api_detail
} // namespace terra
