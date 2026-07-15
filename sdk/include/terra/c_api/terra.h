#ifndef TERRA_C_API_TERRA_H
#define TERRA_C_API_TERRA_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TERRA_C_API_VERSION 1U

typedef struct terra_context terra_context;
typedef int32_t terra_status;

enum {
  TERRA_STATUS_OK = 0,
  TERRA_STATUS_INVALID_ARGUMENT = 1,
  TERRA_STATUS_INVALID_STATE = 2,
  TERRA_STATUS_UNSUPPORTED = 3,
  TERRA_STATUS_DECODE_ERROR = 4,
  TERRA_STATUS_RESOURCE_LIMIT = 5,
  TERRA_STATUS_BUFFER_TOO_SMALL = 6,
  TERRA_STATUS_NOT_FOUND = 7,
  TERRA_STATUS_INTERNAL_ERROR = 8
};

enum {
  TERRA_TRANSFORM_PLANAR = 1,
  TERRA_TRANSFORM_CYLINDRICAL = 2
};

enum {
  TERRA_REQUEST_ROOT = 1,
  TERRA_REQUEST_PATCH = 2
};

typedef struct terra_manifest_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  uint32_t format_version;
  uint32_t patch_dimension;
  uint32_t transform;
  uint32_t reserved;
  double height_scale_factor;
  double minimum_u;
  double minimum_v;
  double maximum_u;
  double maximum_v;
  double radius;
} terra_manifest_v1;

typedef struct terra_viewport_v1 {
  uint32_t struct_size;
  uint32_t width;
  uint32_t height;
  uint32_t reserved;
  double vertical_fov_radians;
} terra_viewport_v1;

typedef struct terra_camera_v1 {
  uint32_t struct_size;
  uint32_t reserved;
  double distance;
  double tilt_radians;
  double yaw_radians;
} terra_camera_v1;

typedef struct terra_patch_key_v1 {
  uint32_t level;
  int32_t i;
  int32_t j;
  int32_t k;
} terra_patch_key_v1;

typedef struct terra_request_v1 {
  uint32_t struct_size;
  uint32_t kind;
  terra_patch_key_v1 key;
} terra_request_v1;

typedef struct terra_patch_decision_v1 {
  uint32_t struct_size;
  uint32_t visible;
  terra_patch_key_v1 key;
  float priority;
  uint32_t reserved;
} terra_patch_decision_v1;

typedef struct terra_frame_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  uint64_t sequence;
  uint32_t decisions_complete;
  uint32_t patch_count;
  uint32_t request_count;
  uint32_t loaded_patch_count;
  uint32_t failed_patch_count;
  uint32_t reserved;
  double camera_position[3];
  double projection_view[16];
} terra_frame_v1;

typedef struct terra_stats_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  uint64_t update_count;
  uint64_t loaded_patch_count;
  uint64_t failed_patch_count;
  uint64_t decoded_value_count;
  uint32_t current_patch_count;
  uint32_t current_request_count;
  uint64_t last_sequence;
} terra_stats_v1;

uint32_t terra_abi_version(void);
uint32_t terra_sizeof_manifest_v1(void);
uint32_t terra_sizeof_viewport_v1(void);
uint32_t terra_sizeof_camera_v1(void);
uint32_t terra_sizeof_patch_key_v1(void);
uint32_t terra_sizeof_request_v1(void);
uint32_t terra_sizeof_patch_decision_v1(void);
uint32_t terra_sizeof_frame_v1(void);
uint32_t terra_sizeof_stats_v1(void);

terra_context* terra_create(void);
void terra_destroy(terra_context* context);

terra_status terra_load_manifest(terra_context* context,
                                 const terra_manifest_v1* manifest);
terra_status terra_set_viewport(terra_context* context,
                                const terra_viewport_v1* viewport);
terra_status terra_set_camera(terra_context* context,
                              const terra_camera_v1* camera);
terra_status terra_submit_patch(terra_context* context,
                                const terra_patch_key_v1* key,
                                const uint8_t* data,
                                size_t data_size);
terra_status terra_fail_patch(terra_context* context,
                              const terra_patch_key_v1* key);
terra_status terra_update(terra_context* context, float lod_threshold);

terra_status terra_get_requests(const terra_context* context,
                                terra_request_v1* requests,
                                size_t capacity,
                                size_t* count);
terra_status terra_get_frame(const terra_context* context,
                             terra_frame_v1* frame);
terra_status terra_get_frame_patches(const terra_context* context,
                                     terra_patch_decision_v1* patches,
                                     size_t capacity,
                                     size_t* count);
terra_status terra_get_index_buffer(const terra_context* context,
                                    uint16_t* indices,
                                    size_t capacity,
                                    size_t* count);
terra_status terra_get_stats(const terra_context* context,
                             terra_stats_v1* stats);
terra_status terra_get_last_error(const terra_context* context,
                                  char* buffer,
                                  size_t capacity,
                                  size_t* required_size);

void* terra_alloc(size_t size);
void terra_free(void* memory);

#ifdef __cplusplus
}
#endif

#endif  // TERRA_C_API_TERRA_H
