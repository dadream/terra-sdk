#include <terra/c_api/terra.h>

#include <terra/codec/cbdam_height.hpp>
#include <terra/core/grid.hpp>
#include <terra/core/metadata.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/frame_packet.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/mesh.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <new>
#include <string>
#include <vector>

struct terra_context {
  terra_manifest_v1 manifest{};
  terra_viewport_v1 viewport{};
  terra_camera_v1 camera{};
  bool manifest_loaded = false;
  bool viewport_set = false;
  bool camera_set = false;
  std::uint64_t sequence = 0U;
  std::vector<terra_patch_key_v1> loaded_keys;
  std::vector<terra_request_v1> requests;
  std::vector<terra_patch_decision_v1> patches;
  std::vector<std::uint16_t> index_buffer;
  terra_frame_v1 frame{};
  terra_stats_v1 stats{};
  mutable std::string last_error;
};

namespace {

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

bool contains_key(const std::vector<terra_patch_key_v1>& keys,
                  const terra_patch_key_v1& key) {
  return std::find_if(keys.begin(), keys.end(), [&key](const auto& current) {
           return same_key(current, key);
         }) != keys.end();
}

bool contains_patch(const terra_context& context,
                    const terra_patch_key_v1& key) {
  return std::find_if(
             context.patches.begin(), context.patches.end(),
             [&key](const terra_patch_decision_v1& patch) {
               return same_key(patch.key, key);
             }) != context.patches.end();
}

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

void reset_runtime_state(terra_context& context) {
  context.manifest_loaded = false;
  context.sequence = 0U;
  context.camera_set = false;
  context.loaded_keys.clear();
  context.requests.clear();
  context.patches.clear();
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

std::uint32_t terra_sizeof_request_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_request_v1));
}

std::uint32_t terra_sizeof_patch_decision_v1(void) {
  return static_cast<std::uint32_t>(sizeof(terra_patch_decision_v1));
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
  if (context == nullptr || !valid_input(manifest)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid manifest argument");
  }
  if (manifest->api_version != TERRA_C_API_VERSION) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported C API version");
  }
  if (manifest->transform != TERRA_TRANSFORM_PLANAR &&
      manifest->transform != TERRA_TRANSFORM_CYLINDRICAL) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "unsupported coordinate transform");
  }
  TERRA_C_API_TRY {
    const terra::core::metadata_validation validation =
        terra::core::validate_dataset_metadata(to_metadata(*manifest));
    if (!validation.valid()) {
      return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                  terra::core::metadata_status_message(validation.status));
    }
    reset_runtime_state(*context);
    const terra::frame::mesh_index_status index_status =
        terra::frame::make_triangular_patch_strip_indices(
            manifest->patch_dimension, context->index_buffer);
    if (index_status != terra::frame::mesh_index_status::ok) {
      const terra_status status =
          index_status == terra::frame::mesh_index_status::index_limit
              ? TERRA_STATUS_UNSUPPORTED
              : TERRA_STATUS_RESOURCE_LIMIT;
      return fail(context, status,
                  terra::frame::mesh_index_status_message(index_status));
    }
    context->manifest = *manifest;
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

terra_status terra_submit_patch(terra_context* context,
                                const terra_patch_key_v1* key,
                                const std::uint8_t* data,
                                std::size_t data_size) {
  if (context == nullptr || key == nullptr || data == nullptr ||
      data_size == 0U || !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid patch submission");
  }
  if (!contains_patch(*context, *key)) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "patch is absent from the current frame");
  }
  TERRA_C_API_TRY {
    terra::codec::height_patch_record decoded;
    const terra::codec::decode_status decode_status =
        terra::codec::decode_cbdam_height_record(data, data_size, decoded);
    if (decode_status != terra::codec::decode_status::ok) {
      return fail(context, map_decode_status(decode_status),
                  terra::codec::decode_status_message(decode_status));
    }
    if (!contains_key(context->loaded_keys, *key)) {
      context->loaded_keys.push_back(*key);
      context->stats.decoded_value_count += decoded.first.values.size();
      if (decoded.has_second) {
        context->stats.decoded_value_count += decoded.second.values.size();
      }
      context->stats.loaded_patch_count = context->loaded_keys.size();
    }
    return succeed(context);
  }
  TERRA_C_API_CATCH(context, "unexpected patch decode error")
}

terra_status terra_fail_patch(terra_context* context,
                              const terra_patch_key_v1* key) {
  if (context == nullptr || key == nullptr || !valid_key(*key)) {
    return fail(context, TERRA_STATUS_INVALID_ARGUMENT,
                "invalid failed patch key");
  }
  if (!contains_patch(*context, *key)) {
    return fail(context, TERRA_STATUS_NOT_FOUND,
                "failed patch is absent from the current frame");
  }
  ++context->stats.failed_patch_count;
  context->frame.failed_patch_count =
      static_cast<std::uint32_t>(context->stats.failed_patch_count);
  return succeed(context);
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
  if (context->manifest.transform != TERRA_TRANSFORM_CYLINDRICAL) {
    return fail(context, TERRA_STATUS_UNSUPPORTED,
                "procedural LOD currently requires a cylindrical dataset");
  }
  TERRA_C_API_TRY {
    terra::frame::globe_camera camera(
        static_cast<float>(context->manifest.radius),
        static_cast<int>(context->viewport.width),
        static_cast<int>(context->viewport.height),
        static_cast<float>(context->viewport.vertical_fov_radians));
    if (!camera.is_valid()) {
      return fail(context, TERRA_STATUS_INVALID_STATE,
                  "unable to construct globe camera");
    }
    if (context->camera_set) {
      camera.set_distance(context->camera.distance);
      camera.set_tilt_radians(context->camera.tilt_radians);
      camera.rotate_yaw_radians(context->camera.yaw_radians);
    }
    const terra::frame::camera_snapshot snapshot = camera.snapshot();
    const terra::frame::lod_cut cut =
        terra::frame::select_procedural_cylindrical_lod(
            context->manifest.radius, context->manifest.patch_dimension,
            lod_threshold, snapshot);
    if (!cut.complete) {
      return fail(context, TERRA_STATUS_RESOURCE_LIMIT,
                  "LOD selection exhausted its safety budget");
    }
    const terra::frame::frame_packet packet =
        terra::frame::make_frame_packet(++context->sequence, snapshot, cut);

    context->requests.clear();
    context->patches.clear();
    context->patches.reserve(packet.patch_decisions.size());
    context->requests.reserve(packet.patch_decisions.size());
    for (const terra::frame::lod_patch& patch : packet.patch_decisions) {
      terra_patch_decision_v1 decision{};
      decision.struct_size = sizeof(terra_patch_decision_v1);
      decision.visible = patch.visible ? 1U : 0U;
      decision.key = to_key(patch);
      decision.priority = patch.priority;
      context->patches.push_back(decision);
      if (!contains_key(context->loaded_keys, decision.key)) {
        terra_request_v1 request{};
        request.struct_size = sizeof(terra_request_v1);
        request.kind = decision.key.level == 0U ? TERRA_REQUEST_ROOT
                                               : TERRA_REQUEST_PATCH;
        request.key = decision.key;
        context->requests.push_back(request);
      }
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
        static_cast<std::uint32_t>(context->loaded_keys.size());
    context->frame.failed_patch_count =
        static_cast<std::uint32_t>(context->stats.failed_patch_count);
    std::copy(packet.camera.position.begin(), packet.camera.position.end(),
              context->frame.camera_position);
    std::copy(packet.camera.projection_view.begin(),
              packet.camera.projection_view.end(),
              context->frame.projection_view);

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
  return copy_vector(context, context == nullptr
                                  ? std::vector<terra_patch_decision_v1>()
                                  : context->patches,
                     patches, capacity, count);
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
