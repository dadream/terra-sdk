#include <terra/c_api/terra.h>

#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/atmosphere.hpp>
#include <terra/core/grid.hpp>
#include <terra/core/metadata.hpp>
#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/frame_packet.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/mesh.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <limits>
#include <map>
#include <new>
#include <set>
#include <string>
#include <vector>

struct terra_loaded_record {
  std::uint32_t kind = 0U;
  terra_patch_key_v1 key{};
  terra::codec::height_patch values;
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

struct terra_cached_surface {
  terra::frame::patch_surface_mesh mesh;
  std::uint64_t last_used_sequence = 0U;
  std::size_t byte_size = 0U;
};

struct terra_context {
  terra_manifest_v1 manifest{};
  terra_viewport_v1 viewport{};
  terra_camera_v1 camera{};
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
  std::vector<terra_loaded_record> loaded_records;
  std::vector<terra_request_v1> failed_records;
  std::vector<terra_request_v1> requests;
  std::vector<terra_patch_decision_v1> patches;
  std::vector<terra_draw_range_v1> draw_ranges;
  std::vector<float> positions;
  std::vector<float> texture_uv;
  std::vector<std::uint16_t> index_buffer;
  std::map<terra_surface_key, terra_cached_surface,
           terra_surface_key_less> surface_cache;
  terra_frame_v1 frame{};
  std::vector<std::int64_t> render_signature;
  std::size_t surface_cache_bytes = 0U;
  terra_stats_v1 stats{};
  terra::frame::cylindrical_lod_controller globe_lod;
  mutable std::string last_error;
};

namespace {

constexpr std::size_t manifest_v1_base_size =
    offsetof(terra_manifest_v1, texture_matrix_level_offset);
constexpr std::size_t manifest_v1_tiled_texture_size =
    offsetof(terra_manifest_v1, texture_minimum_u);
constexpr std::size_t frame_v1_base_size =
    offsetof(terra_frame_v1, draw_count);
constexpr std::size_t maximum_cached_surface_bytes = 16U * 1024U * 1024U;
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
  return found == context.requests.end() ? nullptr : &*found;
}

const terra_request_v1* find_request(const terra_context& context,
                                     const terra_patch_key_v1& key) {
  const auto found = std::find_if(
      context.requests.begin(), context.requests.end(),
      [&key](const terra_request_v1& request) {
        return same_key(request.key, key);
      });
  return found == context.requests.end() ? nullptr : &*found;
}

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

terra::core::dataset_metadata to_metadata(const terra_manifest_v1& manifest) {
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
  context.loaded_records.erase(
      std::remove_if(
          context.loaded_records.begin(), context.loaded_records.end(),
          [&active](const terra_loaded_record& record) {
            active_record_key key;
            key.kind = record.kind;
            key.key = record.key;
            return active.find(key) == active.end();
          }),
      context.loaded_records.end());
  context.failed_records.erase(
      std::remove_if(
          context.failed_records.begin(), context.failed_records.end(),
          [&active](const terra_request_v1& request) {
            active_record_key key;
            key.kind = request.kind;
            key.key = request.key;
            return active.find(key) == active.end();
          }),
      context.failed_records.end());
  context.stats.loaded_patch_count = context.loaded_records.size();
  context.stats.decoded_value_count = 0U;
  for (const terra_loaded_record& record : context.loaded_records) {
    context.stats.decoded_value_count += record.values.values.size();
  }
}

std::size_t surface_mesh_bytes(
    const terra::frame::patch_surface_mesh& mesh) {
  return (mesh.positions_xyz.capacity() + mesh.texture_uv.capacity()) *
         sizeof(float);
}

bool prune_surface_cache(terra_context& context,
                         std::size_t incoming_bytes) {
  if (incoming_bytes > maximum_cached_surface_bytes) {
    context.surface_cache.clear();
    context.surface_cache_bytes = 0U;
    return false;
  }
  while (!context.surface_cache.empty() &&
         (context.surface_cache.size() >= maximum_cached_surface_count ||
          context.surface_cache_bytes >
              maximum_cached_surface_bytes - incoming_bytes)) {
    auto least_recent = context.surface_cache.end();
    for (auto iterator = context.surface_cache.begin();
         iterator != context.surface_cache.end(); ++iterator) {
      if (iterator->second.last_used_sequence == context.sequence + 1U) continue;
      if (least_recent == context.surface_cache.end() ||
          iterator->second.last_used_sequence < least_recent->second.last_used_sequence) {
        least_recent = iterator;
      }
    }
    // Never evict a surface needed later in this same frame. A working set
    // larger than the cache otherwise rebuilds every mesh on every update.
    if (least_recent == context.surface_cache.end()) return false;
    const std::size_t removed_bytes = least_recent->second.byte_size;
    context.surface_cache.erase(least_recent);
    context.surface_cache_bytes =
        removed_bytes <= context.surface_cache_bytes
            ? context.surface_cache_bytes - removed_bytes
            : 0U;
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

terra_status build_render_buffers(
    terra_context& context, const terra::frame::lod_cut& cut,
    std::uint32_t& expected_draw_count,
    std::uint32_t& omitted_draw_count,
    std::uint32_t& coverage_draw_count,
    std::uint32_t& coverage_complete) {
  std::vector<std::int64_t> signature;
  const auto append_signature = [&signature](const terra::frame::lod_patch& patch) {
    signature.push_back(patch.level);
    for (std::size_t axis = 0U; axis < 3U; ++axis) signature.push_back(patch.id[axis]);
    signature.push_back((patch.has_fragment(0U) ? 1 : 0) |
                        (patch.has_fragment(1U) ? 2 : 0));
  };
  for (const auto& request : cut.record_requests) {
    if (request.kind == terra::frame::lod_record_kind::root) append_signature(request.patch);
  }
  signature.push_back(-1);
  for (const auto& patch : cut.patches) if (patch.visible) append_signature(patch);
  if (signature == context.render_signature) {
    expected_draw_count = context.frame.expected_draw_count;
    omitted_draw_count = context.frame.omitted_draw_count;
    coverage_draw_count = context.frame.coverage_draw_count;
    coverage_complete = context.frame.coverage_complete;
    return TERRA_STATUS_OK;
  }
  // Protect cached members of the new visible set before admitting any mesh.
  const auto protect = [&context](const terra::frame::lod_patch& patch) {
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      terra_surface_key key;
      key.patch = to_key(patch);
      key.fragment = fragment;
      auto cached = context.surface_cache.find(key);
      if (cached != context.surface_cache.end()) cached->second.last_used_sequence = context.sequence + 1U;
    }
  };
  for (const auto& request : cut.record_requests) {
    if (request.kind == terra::frame::lod_record_kind::root) protect(request.patch);
  }
  for (const auto& patch : cut.patches) if (patch.visible) protect(patch);
  using height_map = std::map<terra_patch_key_v1,
                              terra::codec::height_diamond,
                              patch_key_less>;
  const loaded_record_index loaded_records =
      index_loaded_records(context);
  height_map heights;
  context.draw_ranges.clear();
  context.positions.clear();
  context.texture_uv.clear();
  expected_draw_count = 0U;
  omitted_draw_count = 0U;
  coverage_draw_count = 0U;
  coverage_complete = 0U;

  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    const terra_patch_key_v1 key = to_key(request.patch);
    const std::uint32_t kind =
        request.kind == terra::frame::lod_record_kind::root
            ? TERRA_REQUEST_ROOT
            : TERRA_REQUEST_DETAIL;
    const loaded_record_index::const_iterator loaded =
        loaded_records.find(make_active_record_key(kind, key));
    const terra_loaded_record* record =
        loaded == loaded_records.end() ? nullptr : loaded->second;
    if (record == nullptr) {
      continue;
    }

    if (kind == TERRA_REQUEST_ROOT) {
      terra::codec::height_diamond root;
      const terra::codec::hierarchy_status status =
          terra::codec::make_cbdam_root_height(record->values, root);
      if (status != terra::codec::hierarchy_status::ok) {
        return fail(&context, map_hierarchy_status(status),
                    terra::codec::hierarchy_status_message(status));
      }
      heights[key] = root;
      continue;
    }

    const height_map::iterator parent = heights.find(key);
    if (parent == heights.end()) {
      continue;
    }
    terra::codec::height_refinement refinement;
    const terra::codec::hierarchy_status status =
        terra::codec::refine_cbdam_height(
            parent->second, record->values, refinement);
    if (status != terra::codec::hierarchy_status::ok) {
      return fail(&context, map_hierarchy_status(status),
                  terra::codec::hierarchy_status_message(status));
    }

    const terra::core::grid_diamond parent_diamond =
        to_diamond(request.patch);
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
        terra::codec::height_diamond& child_height = heights[child_key];
        if (child_height.dimension != 0U &&
            child_height.dimension != refinement.dimension) {
          return fail(&context, TERRA_STATUS_INTERNAL_ERROR,
                      "height hierarchy dimension mismatch");
        }
        child_height.dimension = refinement.dimension;
        child_height.fragment_mask |=
            std::uint8_t(1U) << child_fragment;
        child_height.fragments[child_fragment] =
            refinement.children[2U * parent_fragment + child_index];
      }
    }
  }

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
  reserve_frame_output(context.draw_ranges, render_surface_count);
  reserve_frame_output(context.positions, total_vertex_count * 3U);
  reserve_frame_output(context.texture_uv, total_vertex_count * 2U);

  const terra::core::global_geodetic_wmts_selector selector(
      static_cast<int>(context.manifest.texture_matrix_level_offset),
      static_cast<int>(context.manifest.texture_maximum_level));
  const terra::core::bounds2d texture_bounds(
      terra::core::vector2d{{context.manifest.texture_minimum_u,
                             context.manifest.texture_minimum_v}},
      terra::core::vector2d{{context.manifest.texture_maximum_u,
                             context.manifest.texture_maximum_v}});
  const terra::core::planar_tms_selector planar_texture_selector(
      texture_bounds, context.manifest.texture_tile_size,
      static_cast<int>(context.manifest.texture_level_zero_columns),
      static_cast<int>(context.manifest.texture_level_zero_rows),
      static_cast<int>(context.manifest.texture_matrix_level_offset),
      static_cast<int>(context.manifest.texture_maximum_level));
  const auto append_surface =
      [&](const terra::frame::lod_patch& patch, std::uint8_t fragment,
          const terra::codec::height_fragment& fragment_heights,
          std::uint32_t flags) -> terra_status {
    terra_surface_key surface_key;
    surface_key.patch = to_key(patch);
    surface_key.fragment = fragment;
    auto cached = context.surface_cache.find(surface_key);
    terra::frame::patch_surface_mesh generated;
    const terra::frame::patch_surface_mesh* surface = nullptr;
    if (cached == context.surface_cache.end()) {
      const terra::frame::surface_mesh_status mesh_status =
          context.manifest.transform == TERRA_TRANSFORM_PLANAR
            ? terra::frame::make_planar_patch_surface(
                  patch, fragment, fragment_heights,
                  context.manifest.height_scale_factor,
                  terra::core::bounds2d(
                      terra::core::vector2d{{context.manifest.minimum_u,
                                             context.manifest.minimum_v}},
                      terra::core::vector2d{{context.manifest.maximum_u,
                                             context.manifest.maximum_v}}),
                  planar_texture_selector, generated)
            : terra::frame::make_cylindrical_patch_surface(
                  patch, fragment, fragment_heights,
                  context.manifest.height_scale_factor,
                  context.manifest.radius, selector, generated);
      if (mesh_status != terra::frame::surface_mesh_status::ok) {
        const terra_status status =
            mesh_status == terra::frame::surface_mesh_status::resource_limit
                ? TERRA_STATUS_RESOURCE_LIMIT
                : TERRA_STATUS_INTERNAL_ERROR;
        return fail(&context, status,
                    terra::frame::surface_mesh_status_message(mesh_status));
      }
      const std::size_t byte_size = surface_mesh_bytes(generated);
      if (byte_size <= maximum_cached_surface_bytes &&
          prune_surface_cache(context, byte_size)) {
        terra_cached_surface value;
        value.mesh = std::move(generated);
        value.last_used_sequence = context.sequence + 1U;
        value.byte_size = byte_size;
        const auto inserted =
            context.surface_cache.emplace(surface_key, std::move(value));
        cached = inserted.first;
        if (inserted.second) {
          context.surface_cache_bytes += byte_size;
        }
        surface = &cached->second.mesh;
      } else {
        surface = &generated;
      }
    } else {
      cached->second.last_used_sequence = context.sequence + 1U;
      surface = &cached->second.mesh;
    }
    const terra::frame::patch_surface_mesh& mesh = *surface;

    const std::size_t first_vertex = context.positions.size() / 3U;
    const std::size_t vertex_count = mesh.positions_xyz.size() / 3U;
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
        static_cast<std::uint32_t>(mesh.texture_tile.level);
    range.texture.matrix = mesh.texture_tile.matrix;
    range.texture.row = mesh.texture_tile.row;
    range.texture.column = mesh.texture_tile.column;
    range.first_vertex = static_cast<std::uint32_t>(first_vertex);
    range.vertex_count = static_cast<std::uint32_t>(vertex_count);
    range.first_index = 0U;
    range.index_count =
        static_cast<std::uint32_t>(context.index_buffer.size());
    std::copy(mesh.origin.begin(), mesh.origin.end(), range.origin);
    range.flags = flags;
    context.draw_ranges.push_back(range);
    context.positions.insert(context.positions.end(),
                             mesh.positions_xyz.begin(),
                             mesh.positions_xyz.end());
    context.texture_uv.insert(context.texture_uv.end(),
                              mesh.texture_uv.begin(),
                              mesh.texture_uv.end());
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
            request.patch, fragment, height->second.fragments[fragment],
            TERRA_DRAW_FLAG_COVERAGE);
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
          patch, fragment, height->second.fragments[fragment],
          TERRA_DRAW_FLAG_NONE);
      if (status != TERRA_STATUS_OK) {
        return status;
      }
    }
  }
  if (context.manifest.transform == TERRA_TRANSFORM_PLANAR) {
    coverage_complete =
        expected_draw_count > 0U && omitted_draw_count == 0U ? 1U : 0U;
  }
  if (context.draw_ranges.size() > UINT32_MAX ||
      context.positions.size() > UINT32_MAX ||
      context.texture_uv.size() > UINT32_MAX ||
      context.positions.size() / 3U > UINT32_MAX) {
    context.draw_ranges.clear();
    context.positions.clear();
    context.texture_uv.clear();
    return fail(&context, TERRA_STATUS_RESOURCE_LIMIT,
                "frame buffers exceed the C ABI range");
  }
  context.render_signature = std::move(signature);
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
    camera.set_distance(context->camera.distance);
    camera.set_tilt_radians(context->camera.tilt_radians);
    camera.rotate_yaw_radians(context->camera.yaw_radians);
  }
  snapshot = camera.snapshot();
  return TERRA_STATUS_OK;
}

void reset_runtime_state(terra_context& context) {
  context.manifest_loaded = false;
  context.sequence = 0U;
  context.camera_set = false;
  context.globe_target_longitude_degrees = 0.0;
  context.globe_target_latitude_degrees = 0.0;
  context.planar_target_x = 0.0;
  context.planar_target_y = 0.0;
  context.planar_target_set = false;
  context.planar_level = 0U;
  context.globe_lod.clear();
  context.render_signature.clear();
  context.loaded_records.clear();
  context.failed_records.clear();
  context.requests.clear();
  context.patches.clear();
  context.draw_ranges.clear();
  context.positions.clear();
  context.texture_uv.clear();
  context.index_buffer.clear();
  context.surface_cache.clear();
  context.surface_cache_bytes = 0U;
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

template <typename value_t>
terra_status copy_vector(const terra_context* context,
                         const std::vector<value_t>& source,
                         value_t* destination, std::size_t capacity,
                         std::size_t* count) {
  if (context == nullptr || count == nullptr) {
    return TERRA_STATUS_INVALID_ARGUMENT;
  }
  *count = source.size();
  if (source.size() > capacity || (!source.empty() && destination == nullptr)) {
    return fail(context, TERRA_STATUS_BUFFER_TOO_SMALL,
                "caller buffer is too small");
  }
  if (!source.empty()) {
    std::copy(source.begin(), source.end(), destination);
  }
  return succeed(context);
}

#if defined(TERRA_SDK_NO_EXCEPTIONS)
#define TERRA_C_API_TRY
#define TERRA_C_API_CATCH(context, fallback_message)
#else
#define TERRA_C_API_TRY try
#define TERRA_C_API_CATCH(context, fallback_message)                    \
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

std::uint32_t terra_sizeof_manifest_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_manifest_v1));
}

std::uint32_t terra_sizeof_viewport_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_viewport_v1));
}

std::uint32_t terra_sizeof_camera_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_camera_v1));
}

std::uint32_t terra_sizeof_camera_snapshot_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_camera_snapshot_v1));
}

std::uint32_t terra_sizeof_patch_key_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_patch_key_v1));
}

std::uint32_t terra_sizeof_texture_key_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_texture_key_v1));
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

terra_status terra_load_manifest(terra_context* context,
                                 const terra_manifest_v1* manifest) {
  if (context == nullptr || manifest == nullptr ||
      manifest->struct_size < manifest_v1_base_size) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid manifest argument");
  }
  terra_manifest_v1 input{};
  std::memcpy(&input, manifest,
              std::min<std::size_t>(manifest->struct_size, sizeof(input)));
  input.struct_size = sizeof(input);
  if (manifest->struct_size < manifest_v1_tiled_texture_size ||
      input.texture_tile_size == 0U) {
    input.texture_tile_size = 256U;
  }
  if (input.texture_level_zero_columns == 0U) {
    input.texture_level_zero_columns =
        input.transform == TERRA_TRANSFORM_CYLINDRICAL ? 2U : 1U;
  }
  if (input.texture_level_zero_rows == 0U) {
    input.texture_level_zero_rows = 1U;
  }
  if (manifest->struct_size < sizeof(terra_manifest_v1) ||
      !std::isfinite(input.texture_minimum_u) ||
      !std::isfinite(input.texture_minimum_v) ||
      !std::isfinite(input.texture_maximum_u) ||
      !std::isfinite(input.texture_maximum_v) ||
      input.texture_minimum_u >= input.texture_maximum_u ||
      input.texture_minimum_v >= input.texture_maximum_v) {
    input.texture_minimum_u = input.minimum_u;
    input.texture_minimum_v = input.minimum_v;
    input.texture_maximum_u = input.maximum_u;
    input.texture_maximum_v = input.maximum_v;
  }
  if (input.api_version != TERRA_C_API_VERSION) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported C API version");
  }
  if (input.transform != TERRA_TRANSFORM_PLANAR &&
      input.transform != TERRA_TRANSFORM_CYLINDRICAL) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported coordinate transform");
  }
  if (input.texture_matrix_level_offset > 28U ||
      input.texture_maximum_level > 28U ||
      input.texture_minimum_level != 0U ||
      input.texture_tile_size > 16384U ||
      input.texture_level_zero_columns > 1024U ||
      input.texture_level_zero_rows > 1024U) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid texture matrix descriptor");
  }
  TERRA_C_API_TRY {
    const terra::core::metadata_validation validation =
        terra::core::validate_dataset_metadata(to_metadata(input));
    if (!validation.valid()) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                  terra::core::metadata_status_message(validation.status));
    }
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
                              const terra_camera_v1* camera) {
  if (context == nullptr || !valid_input(camera)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid camera argument");
  }
  if (!std::isfinite(camera->distance) || camera->distance <= 0.0 ||
      !std::isfinite(camera->tilt_radians) ||
      !std::isfinite(camera->yaw_radians)) {
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
  if (context != nullptr) context->render_signature.clear();
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
    terra::codec::height_patch_record decoded;
    const terra::codec::decode_status decode_status =
        terra::codec::decode_cbdam_height_record(data, data_size, decoded);
    if (decode_status != terra::codec::decode_status::ok) {
      return fail(context, map_decode_status(decode_status),
                  terra::codec::decode_status_message(decode_status));
    }
    const std::uint32_t expected_dimension =
        kind == TERRA_REQUEST_ROOT
            ? context->manifest.patch_dimension + 1U
            : context->manifest.patch_dimension;
    if (decoded.has_second ||
        decoded.first.rows != expected_dimension ||
        decoded.first.columns != expected_dimension) {
      return fail(context, TERRA_STATUS_DECODE_ERROR,
                  "terrain record shape does not match its request kind");
    }
    if (find_record(*context, kind, *key) == nullptr) {
      terra_loaded_record record;
      record.kind = kind;
      record.key = *key;
      record.values = decoded.first;
      context->loaded_records.push_back(record);
      context->stats.decoded_value_count += record.values.values.size();
      context->stats.loaded_patch_count = context->loaded_records.size();
    }
    static_cast<void>(erase_failed_record(*context, kind, *key));
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected terrain record decode error")
}

terra_status terra_submit_patch(terra_context* context,
                                const terra_patch_key_v1* key,
                                const std::uint8_t* data,
                                std::size_t data_size) {
  if (context == nullptr || key == nullptr || data == nullptr ||
      data_size == 0U || !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid patch submission");
  }
  if (find_request(*context, TERRA_REQUEST_ROOT, *key) == nullptr &&
      find_request(*context, TERRA_REQUEST_DETAIL, *key) == nullptr) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "patch is absent from the current requests");
  }
  TERRA_C_API_TRY {
    terra::codec::height_patch_record decoded;
    const terra::codec::decode_status decode_status =
        terra::codec::decode_cbdam_height_record(data, data_size, decoded);
    if (decode_status != terra::codec::decode_status::ok) {
      return fail(context, map_decode_status(decode_status),
                  terra::codec::decode_status_message(decode_status));
    }
    if (decoded.has_second) {
      return fail(context, TERRA_STATUS_DECODE_ERROR,
                  "terrain record has an unsupported second patch");
    }
    const std::uint32_t root_dimension =
        context->manifest.patch_dimension + 1U;
    const std::uint32_t detail_dimension =
        context->manifest.patch_dimension;
    std::uint32_t kind = 0U;
    if (decoded.first.rows == root_dimension &&
        decoded.first.columns == root_dimension) {
      kind = TERRA_REQUEST_ROOT;
    } else if (decoded.first.rows == detail_dimension &&
               decoded.first.columns == detail_dimension) {
      kind = TERRA_REQUEST_DETAIL;
    } else {
      return fail(context, TERRA_STATUS_DECODE_ERROR,
                  "terrain record shape does not match a patch request");
    }
    return terra_submit_record(context, kind, key, data, data_size);
  }
  TERRA_C_API_CATCH(context, "unexpected patch decode error")
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
    ++context->stats.failed_patch_count;
  }
  context->frame.failed_patch_count =
      static_cast<std::uint32_t>(context->stats.failed_patch_count);
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
  return succeed(context);
}

terra_status terra_fail_patch(terra_context* context,
                              const terra_patch_key_v1* key) {
  if (context == nullptr || key == nullptr || !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid failed patch key");
  }
  const terra_request_v1* request = find_request(*context, *key);
  if (request == nullptr) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "failed patch is absent from the current requests");
  }
  return terra_fail_record(context, request->kind, key);
}

terra_status terra_update(terra_context* context, float lod_threshold) {
  if (context == nullptr || !std::isfinite(lod_threshold) ||
      lod_threshold <= 0.0F) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid LOD threshold");
  }
  if (!context->manifest_loaded || !context->viewport_set) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "manifest and viewport are required before update");
  }
  TERRA_C_API_TRY {
    terra::frame::camera_snapshot snapshot;
    const terra_status camera_status =
        make_camera_snapshot(context, snapshot);
    if (camera_status != TERRA_STATUS_OK) {
      return camera_status;
    }
    terra::frame::lod_cut cut;
    if (context->manifest.transform == TERRA_TRANSFORM_PLANAR) {
      cut = terra::frame::select_fixed_planar_lod(
          context->manifest.patch_dimension, context->planar_level);
    } else {
      terra::frame::lod_resource_state resources;
      resources.available_roots.reserve(context->loaded_records.size());
      resources.available_details.reserve(context->loaded_records.size());
      resources.unavailable_details.reserve(
          context->failed_records.size());
      for (const terra_loaded_record& record : context->loaded_records) {
        terra::frame::lod_detail_key available;
        available.level = record.key.level;
        available.id = {{record.key.i, record.key.j, record.key.k}};
        if (record.kind == TERRA_REQUEST_ROOT) {
          resources.available_roots.push_back(available);
        } else if (record.kind == TERRA_REQUEST_DETAIL) {
          resources.available_details.push_back(available);
        }
      }
      for (const terra_request_v1& failed : context->failed_records) {
        if (failed.kind != TERRA_REQUEST_DETAIL) {
          continue;
        }
        terra::frame::lod_detail_key unavailable;
        unavailable.level = failed.key.level;
        unavailable.id = {{failed.key.i, failed.key.j, failed.key.k}};
        resources.unavailable_details.push_back(unavailable);
      }
      cut = context->globe_lod.update(lod_threshold, snapshot, resources);
    }
    if (!cut.complete) {
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT,
                  "LOD selection exhausted its safety budget");
    }
    const terra::frame::frame_packet packet =
        terra::frame::make_frame_packet(context->sequence + 1U, snapshot,
                                        cut);

    context->requests.clear();
    context->patches.clear();
    context->patches.reserve(packet.patch_decisions.size());
    context->requests.reserve(cut.record_requests.size());
    for (const terra::frame::lod_patch& patch : packet.patch_decisions) {
      terra_patch_decision_v1 decision{};
      decision.struct_size = sizeof(terra_patch_decision_v1);
      decision.visible = patch.visible ? 1U : 0U;
      decision.key = to_key(patch);
      decision.priority = patch.priority;
      context->patches.push_back(decision);
    }
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
      const active_record_key active =
          make_active_record_key(request.kind, request.key);
      if (loaded_records.count(active) == 0U &&
          failed_records.count(active) == 0U) {
        context->requests.push_back(request);
      }
    }
    std::uint32_t expected_draw_count = 0U;
    std::uint32_t omitted_draw_count = 0U;
    std::uint32_t coverage_draw_count = 0U;
    std::uint32_t coverage_complete = 0U;
    const terra_status render_status = build_render_buffers(
        *context, cut, expected_draw_count, omitted_draw_count,
        coverage_draw_count, coverage_complete);
    if (render_status != TERRA_STATUS_OK) {
      return render_status;
    }
    prune_inactive_records(*context, cut);
    context->sequence = packet.sequence;

    context->frame = terra_frame_v1{};
    context->frame.struct_size = sizeof(terra_frame_v1);
    context->frame.api_version = TERRA_C_API_VERSION;
    context->frame.sequence = packet.sequence;
    context->frame.decisions_complete = packet.decisions_complete ? 1U : 0U;
    context->frame.patch_count =
        static_cast<std::uint32_t>(context->patches.size());
    context->frame.request_count =
        static_cast<std::uint32_t>(context->requests.size());
    context->frame.loaded_patch_count =
        static_cast<std::uint32_t>(context->loaded_records.size());
    context->frame.failed_patch_count =
        static_cast<std::uint32_t>(context->failed_records.size());
    std::copy(packet.camera.position.begin(), packet.camera.position.end(),
              context->frame.camera_position);
    std::copy(packet.camera.projection_view.begin(),
              packet.camera.projection_view.end(),
              context->frame.projection_view);
    context->frame.draw_count =
        static_cast<std::uint32_t>(context->draw_ranges.size());
    context->frame.vertex_count =
        static_cast<std::uint32_t>(context->positions.size() / 3U);
    context->frame.position_float_count =
        static_cast<std::uint32_t>(context->positions.size());
    context->frame.texture_float_count =
        static_cast<std::uint32_t>(context->texture_uv.size());
    context->frame.expected_draw_count = expected_draw_count;
    context->frame.omitted_draw_count = omitted_draw_count;
    context->frame.coverage_draw_count = coverage_draw_count;
    context->frame.coverage_complete = coverage_complete;

    ++context->stats.update_count;
    context->stats.current_patch_count = context->frame.patch_count;
    context->stats.current_request_count = context->frame.request_count;
    context->stats.last_sequence = context->frame.sequence;
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected frame update error")
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
  return copy_vector(context, context == nullptr
                                  ? std::vector<terra_request_v1>()
                                  : context->requests,
                     requests, capacity, count);
}

terra_status terra_get_frame(const terra_context* context,
                             terra_frame_v1* frame) {
  if (context == nullptr || frame == nullptr ||
      frame->struct_size < frame_v1_base_size) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid frame output");
  }
  if (context->sequence == 0U) {
    return fail(context, TERRA_STATUS_INVALID_STATE,
                "no frame is available");
  }
  const std::size_t caller_size = frame->struct_size;
  std::memcpy(frame, &context->frame,
              std::min<std::size_t>(caller_size, sizeof(*frame)));
  return succeed(context);
}

terra_status terra_get_frame_patches(const terra_context* context,
                                     terra_patch_decision_v1* patches,
                                     std::size_t capacity,
                                     std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<terra_patch_decision_v1>()
                                  : context->patches,
                     patches, capacity, count);
}

terra_status terra_get_draw_ranges(const terra_context* context,
                                   terra_draw_range_v1* ranges,
                                   std::size_t capacity,
                                   std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<terra_draw_range_v1>()
                                  : context->draw_ranges,
                     ranges, capacity, count);
}

terra_status terra_get_position_buffer(const terra_context* context,
                                       float* positions,
                                       std::size_t capacity,
                                       std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<float>()
                                  : context->positions,
                     positions, capacity, count);
}

const float* terra_get_position_buffer_view(const terra_context* context) {
  return context == nullptr || context->positions.empty()
      ? nullptr
      : context->positions.data();
}

terra_status terra_get_texture_uv_buffer(const terra_context* context,
                                         float* texture_uv,
                                         std::size_t capacity,
                                         std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<float>()
                                  : context->texture_uv,
                     texture_uv, capacity, count);
}

const float* terra_get_texture_uv_buffer_view(const terra_context* context) {
  return context == nullptr || context->texture_uv.empty()
      ? nullptr
      : context->texture_uv.data();
}

terra_status terra_get_index_buffer(const terra_context* context,
                                    std::uint16_t* indices,
                                    std::size_t capacity,
                                    std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<std::uint16_t>()
                                  : context->index_buffer,
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
