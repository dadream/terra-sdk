#include <terra/c_api/terra.h>

#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
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
#include <map>
#include <new>
#include <string>
#include <vector>

struct terra_loaded_record {
  std::uint32_t kind = 0U;
  terra_patch_key_v1 key{};
  terra::codec::height_patch values;
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
  terra_frame_v1 frame{};
  terra_stats_v1 stats{};
  mutable std::string last_error;
};

namespace {

constexpr std::size_t manifest_v1_base_size =
    offsetof(terra_manifest_v1, texture_matrix_level_offset);
constexpr std::size_t manifest_v1_tiled_texture_size =
    offsetof(terra_manifest_v1, texture_minimum_u);
constexpr std::size_t frame_v1_base_size =
    offsetof(terra_frame_v1, draw_count);

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

terra_status build_render_buffers(
    terra_context& context, const terra::frame::lod_cut& cut) {
  using height_map = std::map<terra_patch_key_v1,
                              terra::codec::height_diamond,
                              patch_key_less>;
  height_map heights;
  context.draw_ranges.clear();
  context.positions.clear();
  context.texture_uv.clear();

  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    const terra_patch_key_v1 key = to_key(request.patch);
    const std::uint32_t kind =
        request.kind == terra::frame::lod_record_kind::root
            ? TERRA_REQUEST_ROOT
            : TERRA_REQUEST_DETAIL;
    const terra_loaded_record* record = find_record(context, kind, key);
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
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (!patch.visible) {
      continue;
    }
    const terra_patch_key_v1 key = to_key(patch);
    const height_map::const_iterator height = heights.find(key);
    if (height == heights.end()) {
      continue;
    }
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!patch.has_fragment(fragment) ||
          !height->second.has_fragment(fragment)) {
        continue;
      }
      terra::frame::patch_surface_mesh mesh;
      const terra::frame::surface_mesh_status mesh_status =
          context.manifest.transform == TERRA_TRANSFORM_PLANAR
              ? terra::frame::make_planar_patch_surface(
                    patch, fragment, height->second.fragments[fragment],
                    context.manifest.height_scale_factor,
                    terra::core::bounds2d(
                        terra::core::vector2d{{context.manifest.minimum_u,
                                               context.manifest.minimum_v}},
                        terra::core::vector2d{{context.manifest.maximum_u,
                                               context.manifest.maximum_v}}),
                    planar_texture_selector,
                    mesh)
              : terra::frame::make_cylindrical_patch_surface(
                    patch, fragment, height->second.fragments[fragment],
                    context.manifest.height_scale_factor,
                    context.manifest.radius, selector, mesh);
      if (mesh_status != terra::frame::surface_mesh_status::ok) {
        const terra_status status =
            mesh_status == terra::frame::surface_mesh_status::resource_limit
                ? TERRA_STATUS_RESOURCE_LIMIT
                : TERRA_STATUS_INTERNAL_ERROR;
        return fail(&context, status,
                    terra::frame::surface_mesh_status_message(mesh_status));
      }

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
      range.key = key;
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
      context.draw_ranges.push_back(range);
      context.positions.insert(
          context.positions.end(),
          mesh.positions_xyz.begin(), mesh.positions_xyz.end());
      context.texture_uv.insert(
          context.texture_uv.end(),
          mesh.texture_uv.begin(), mesh.texture_uv.end());
    }
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
  context.loaded_records.clear();
  context.failed_records.clear();
  context.requests.clear();
  context.patches.clear();
  context.draw_ranges.clear();
  context.positions.clear();
  context.texture_uv.clear();
  context.index_buffer.clear();
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
    terra::frame::lod_cut cut;
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
      cut = terra::frame::select_fixed_planar_lod(
          context->manifest.patch_dimension, context->planar_level);
    } else {
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
      std::vector<terra::frame::lod_detail_key> unavailable_details;
      unavailable_details.reserve(context->failed_records.size());
      for (const terra_request_v1& failed : context->failed_records) {
        if (failed.kind == TERRA_REQUEST_DETAIL) {
          terra::frame::lod_detail_key unavailable;
          unavailable.level = failed.key.level;
          unavailable.id = {{failed.key.i, failed.key.j, failed.key.k}};
          unavailable_details.push_back(unavailable);
        }
      }
      cut = terra::frame::select_procedural_cylindrical_lod(
          context->manifest.radius, context->manifest.patch_dimension,
          lod_threshold, snapshot, 40U, 65536U, unavailable_details);
    }
    if (!cut.complete) {
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT,
                  "LOD selection exhausted its safety budget");
    }
    const terra::frame::frame_packet packet =
        terra::frame::make_frame_packet(++context->sequence, snapshot, cut);

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
    for (const terra::frame::lod_record_request& record :
         cut.record_requests) {
      terra_request_v1 request{};
      request.struct_size = sizeof(terra_request_v1);
      request.kind =
          record.kind == terra::frame::lod_record_kind::root
              ? TERRA_REQUEST_ROOT
              : TERRA_REQUEST_DETAIL;
      request.key = to_key(record.patch);
      if (find_record(*context, request.kind, request.key) == nullptr &&
          find_failed_record(*context, request.kind,
                             request.key) == nullptr) {
        context->requests.push_back(request);
      }
    }
    const terra_status render_status = build_render_buffers(*context, cut);
    if (render_status != TERRA_STATUS_OK) {
      return render_status;
    }

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
        static_cast<std::uint32_t>(context->stats.failed_patch_count);
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

    ++context->stats.update_count;
    context->stats.current_patch_count = context->frame.patch_count;
    context->stats.current_request_count = context->frame.request_count;
    context->stats.last_sequence = context->frame.sequence;
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected frame update error")
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

terra_status terra_get_texture_uv_buffer(const terra_context* context,
                                         float* texture_uv,
                                         std::size_t capacity,
                                         std::size_t* count) {
  return copy_vector(context, context == nullptr
                                  ? std::vector<float>()
                                  : context->texture_uv,
                     texture_uv, capacity, count);
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
