#ifndef TERRA_C_API_TERRA_H
#define TERRA_C_API_TERRA_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TERRA_C_API_VERSION 47U

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
  TERRA_STATUS_INTERNAL_ERROR = 8,
  /* Publication retained: retry only after demand, ownership or capacity changes. */
  TERRA_STATUS_CAPACITY_PENDING = 9,
  /* The selected epoch is retained; resume with credit or yield between slices. */
  TERRA_STATUS_WORK_PENDING = 10
};

enum {
  TERRA_TRANSFORM_PLANAR = 1,
  TERRA_TRANSFORM_CYLINDRICAL = 2
};

enum {
  TERRA_REQUEST_ROOT = 1,
  TERRA_REQUEST_DETAIL = 2,
  TERRA_REQUEST_PATCH = TERRA_REQUEST_DETAIL
};

typedef struct terra_terrain_manifest_v3 {
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
} terra_terrain_manifest_v3;

typedef struct terra_viewport_v1 {
  uint32_t struct_size;
  uint32_t width;
  uint32_t height;
  uint32_t reserved;
  double vertical_fov_radians;
} terra_viewport_v1;

typedef enum terra_camera_model {
  TERRA_CAMERA_ORBIT = 0,
  TERRA_CAMERA_EYE = 1 /* globe only; target is eye, distance must be zero */
} terra_camera_model;

typedef struct terra_camera_v3 {
  uint32_t struct_size;
  uint32_t model;
  double distance; /* orbit range in metres; exactly zero for eye mode */
  double tilt_radians; /* eye mode: -(PI/2 + horizon-relative pitch) */
  double yaw_radians;
  double target_height_metres;
} terra_camera_v3;

typedef struct terra_camera_snapshot_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  double camera_position[3];
  double projection_view[16];
} terra_camera_snapshot_v1;

typedef struct terra_patch_key_v1 {
  uint32_t level;
  int32_t i;
  int32_t j;
  int32_t k;
} terra_patch_key_v1;

typedef struct terra_terrain_sample_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  uint32_t available;
  uint32_t fragment;
  terra_patch_key_v1 key;
  uint32_t data_level; /* finest real residual; synthesis does not improve it */
  uint32_t reserved;
  double height_metres;
  double sample_spacing_metres; /* horizontal bound, not vertical accuracy */
  uint64_t height_revision;
} terra_terrain_sample_v1;

enum {
  TERRA_HEIGHT_PLANNING = 1, TERRA_HEIGHT_WORKING = 2, TERRA_HEIGHT_WAITING = 3,
  TERRA_HEIGHT_READY = 4, TERRA_HEIGHT_LIMITED = 5, TERRA_HEIGHT_UNAVAILABLE = 6,
  TERRA_HEIGHT_FAILED = 7
};
enum {
  TERRA_HEIGHT_NO_DATA = 1, TERRA_HEIGHT_REQUEST_FAILED = 2,
  TERRA_HEIGHT_LEVEL_LIMIT = 4, TERRA_HEIGHT_CAPACITY = 8, TERRA_HEIGHT_INVALID = 16
};
typedef struct terra_height_query_state_v1 {
  uint32_t struct_size, api_version, query_id, state;
  uint32_t reasons, reserved;
  terra_terrain_sample_v1 sample;
  uint64_t payload_bytes, peak_bytes, maximum_bytes;
} terra_height_query_state_v1;
typedef struct terra_height_region_v1 {
  uint32_t struct_size, api_version, dimension, value_count;
  double grid_corners[9]; /* A, B, C: same barycentric triangle as height sampling */
  double geometry_spacing_metres, height_scale;
} terra_height_region_v1;

typedef struct terra_texture_node_v3 {
  uint32_t level;
  int32_t root; /* internal root index; rows/columns are flattened, north first */
  int32_t row;
  int32_t column;
} terra_texture_node_v3;

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

typedef enum terra_draw_flag_v1 {
  TERRA_DRAW_FLAG_NONE = 0,
  TERRA_DRAW_FLAG_COVERAGE = 1
} terra_draw_flag_v1;

typedef struct terra_draw_range_v1 {
  uint32_t struct_size;
  uint32_t fragment;
  terra_patch_key_v1 key;
  terra_texture_node_v3 texture;
  uint32_t first_vertex;
  uint32_t vertex_count;
  uint32_t first_index;
  uint32_t index_count;
  double origin[3];
  uint32_t flags;
  uint32_t reserved;
} terra_draw_range_v1;

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
  uint32_t draw_count;
  uint32_t vertex_count;
  uint32_t position_float_count;
  uint32_t texture_float_count;
  uint32_t expected_draw_count;
  uint32_t omitted_draw_count;
  uint32_t coverage_draw_count;
  uint32_t coverage_complete;
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

/* Incremental update record layout; independently versioned within ABI 24. */
#define TERRA_UPDATE_API_VERSION 2U

typedef struct terra_update_budget_v2 {
  uint32_t struct_size;
  uint32_t api_version;
  uint32_t maximum_change_count;
  uint32_t maximum_priority_update_count;
  double maximum_elapsed_milliseconds;
  uint32_t maximum_node_count;
  /* Unique native position/UV payload, including display, candidate, cache and
   * construction. Zero selects four times the instance terrain capacity,
   * capped at UINT32_MAX. This is not total SDK memory or an allocation grant. */
  uint32_t maximum_mesh_bytes;
  /* Only bounded threshold/capacity coarsening; pending refinement survives. */
  uint32_t coarsening_only;
} terra_update_budget_v2;

typedef struct terra_update_state_v2 {
  uint32_t struct_size;
  uint32_t api_version;
  uint64_t sequence;
  /* Desired model revision, not the identity of a partially produced mesh set.
   * Multiple mixed candidates can share it. Advancing the model never changes
   * published resources; compare immutable mesh IDs for render/imagery reuse. */
  uint64_t model_revision;
  uint64_t mesh_bytes;
  /* Unique decoded payload, including the procedural zero-detail input. */
  uint64_t decoded_record_bytes;
  uint64_t maximum_mesh_bytes; /* limit used to prepare this candidate/model */
  uint32_t priority_update_count;
  uint32_t pending_priority_update_count;
  /* Interrupted runnable work needs another slice. Waiting for terrain I/O
   * alone is not budget exhaustion, even if producing the cut was slow. */
  uint32_t budget_exhausted;
  /* Actual splits/coarsenings in this step, including dependency work whose
   * priority scan has not yet produced a new visible cut. */
  uint32_t topology_change_count;
  uint64_t height_bytes;
  uint32_t height_build_count;
  uint32_t reserved_height;
  float requested_lod_threshold;
  float feasible_lod_threshold;
  uint32_t topology_node_count;
  uint32_t maximum_topology_node_count;
  uint32_t limited_by_capacity;
  /* Unselected boundary dependency groups still retaining old geometry. */
  uint32_t pending_mesh_group_count;
} terra_update_state_v2;

/* One metadata-only prepared candidate with immutable height inputs. Background
 * advancement cannot invalidate it; discard, replacement, consumption and reset
 * do. Nested frame/state describe this plan, not the published candidate. Mesh
 * byte counts charge shared native UV storage once; per-mesh descriptors still
 * expose complete read-only views. They exclude metadata and height inputs.
 * Shared/retired height samples
 * are counted once in update_state.height_bytes and the existing height budget. */
typedef struct terra_mesh_plan_v1 {
  uint32_t struct_size;
  uint32_t api_version;
  uint32_t plan_id;
  uint32_t reserved;
  uint64_t resident_mesh_bytes;
  uint64_t additional_mesh_bytes;
  uint64_t reclaimable_mesh_bytes;
  terra_frame_v1 frame;
  terra_update_state_v2 state;
} terra_mesh_plan_v1;

typedef struct terra_replacement_member_v1 {
  uint32_t group;
  uint32_t after;
  uint32_t resource_id;
} terra_replacement_member_v1;

typedef struct terra_mesh_resource_v3 {
  uint32_t struct_size;
  uint32_t resource_id;
  uint32_t position_float_count;
  uint32_t texture_float_count;
  /* Immutable UV layout identity, scoped to this terrain context. Equal IDs
   * imply bit-identical arrays independent of mesh height and lifetime. */
  uint64_t texture_resource_id;
  terra_draw_range_v1 draw;
} terra_mesh_resource_v3;

typedef struct terra_frame_receipt_v2 {
  uint32_t struct_size;
  uint32_t api_version;
  uint64_t sequence;
} terra_frame_receipt_v2;

typedef struct terra_imagery_options_v4 {
  uint32_t struct_size;
  uint32_t api_version;
  uint32_t tile_size;
  uint32_t maximum_level;
  double requested_pixel_error;
  uint32_t maximum_texture_count;
  uint32_t maximum_draw_count;
  uint32_t source_root_columns;
  uint32_t source_root_rows;
  uint32_t source_maximum_level;
  uint32_t reserved;
} terra_imagery_options_v4;

typedef struct terra_imagery_surface_v3 {
  uint32_t struct_size;
  uint32_t draw_index;
  terra_texture_node_v3 source;
  uint32_t first_region;
  uint32_t region_count;
  uint32_t first_hull_point;
  uint32_t hull_point_count;
  uint32_t resource_id;
  uint32_t reserved;
} terra_imagery_surface_v3;

typedef struct terra_imagery_region_v4 {
  double minimum_u;
  double minimum_v;
  double maximum_u;
  double maximum_v;
  double pixels_per_uv;
  double projection[9];
  double triangle_uv[6];
  double numerator_bound; /* When flags&4: -1 triangle, >=0 depth envelope. */
  uint32_t flags; /* projection=1, triangle=2, numerator_bound=4. */
  uint32_t domain; /* Local measurement provenance, UINT32_MAX when absent. */
} terra_imagery_region_v4;

typedef struct terra_imagery_hull_point_v3 { double u; double v; } terra_imagery_hull_point_v3;

typedef enum terra_surface_measurement_phase {
  TERRA_SURFACE_MEASUREMENT_INSPECTING_PREVIOUS=0,
  TERRA_SURFACE_MEASUREMENT_WAITING_FOR_WORK=1,
  TERRA_SURFACE_MEASUREMENT_MEASURING=2,
  TERRA_SURFACE_MEASUREMENT_WAITING_FOR_INPUT=3,
  TERRA_SURFACE_MEASUREMENT_COPYING=4,
  TERRA_SURFACE_MEASUREMENT_NORMALIZING=5,
  TERRA_SURFACE_MEASUREMENT_READY=6,
  TERRA_SURFACE_MEASUREMENT_CANCELLED=7,
  TERRA_SURFACE_MEASUREMENT_INVALID_INPUT=8,
  TERRA_SURFACE_MEASUREMENT_ALLOCATION_FAILED=9,
  TERRA_SURFACE_MEASUREMENT_INTERNAL_ERROR=10
} terra_surface_measurement_phase;

/* Immutable native model/view work. Model phases are waiting=0, building=1,
 * ready=2. Measurement phases: inspect previous=0, work=1, measuring=2,
 * input=3, copying=4, normalizing=5, ready=6; 7+ are terminal failures.
 * A zero grant observes/advances already funded work. A waiting stage requires
 * its advertised bytes in a later call; short credit never advances/allocates.
 * Numeric rows remain176-byte v4. These handles never expose Wasm heap views. */
typedef struct terra_surface_work_v1 {
  uint32_t struct_size, api_version, id, phase, operations, required_work_bytes;
  uint32_t model_id, resource_id, plan_id, view_revision, source_revision;
  uint32_t region_count, hull_count, copied_regions, copied_hull, normalized_regions;
  uint32_t quote_id; /* Nonzero only at an allocation boundary; task-local, never reused. */
} terra_surface_work_v1;

typedef struct terra_surface_projection_v1 {
  uint32_t struct_size, api_version, model_id, flags; /* tight=1, bounds_only=2 */
  uint32_t view_revision, source_revision, previous_measurement_id, reserved1;
  double matrix[16], scale_x, scale_y;
} terra_surface_projection_v1;

typedef struct terra_surface_summary_v1 {
  uint32_t struct_size, api_version, visible, refinable;
  double minimum_u, minimum_v, maximum_u, maximum_v, pixels_per_uv, center_distance;
} terra_surface_summary_v1;

typedef struct terra_imagery_draw_v3 {
  uint32_t struct_size;
  uint32_t draw_index;
  terra_texture_node_v3 texture;
  double pixel_error;
} terra_imagery_draw_v3;

typedef struct terra_imagery_quality_v4 {
  uint32_t struct_size;
  uint32_t api_version;
  double requested_pixel_error;
  double feasible_pixel_error;
  double maximum_pixel_error;
  uint32_t selected_texture_count;
  uint32_t draw_count;
  uint32_t cached_node_count;
  uint32_t limit_flags; /* 1: textures, 2: draws, 4: source level, 8: projection,
                           16: partition admission, 32: planning in progress,
                           64: rebuilding; root draws are not replacement demand */
  /* Session-local immutable draw identity. Changes on new input/cut, not on
     measurement progress. Never reused after resetting this session. */
  uint64_t draw_revision;
} terra_imagery_quality_v4;

typedef struct terra_atmosphere_parameters_v1 {
  uint32_t struct_size;
  uint32_t flags;
  float sun_azimuth_degrees;
  float sun_zenith_degrees;
  float turbidity;
  float exposure;
  uint32_t texture_width;
  uint32_t texture_height;
} terra_atmosphere_parameters_v1;

typedef struct terra_atmosphere_result_v1 {
  uint32_t struct_size;
  uint32_t texture_width;
  uint32_t texture_height;
  uint32_t sun_visible;
  float sun_direction[3];
  float ambient_color[3];
  float diffuse_color[3];
  float fog_color[3];
  float sea_level_fog_density;
  uint32_t required_rgba_bytes;
} terra_atmosphere_result_v1;

uint32_t terra_abi_version(void);
uint32_t terra_sizeof_terrain_manifest_v3(void);
uint32_t terra_sizeof_viewport_v1(void);
uint32_t terra_sizeof_camera_v3(void);
uint32_t terra_sizeof_camera_snapshot_v1(void);
uint32_t terra_sizeof_patch_key_v1(void);
uint32_t terra_sizeof_texture_node_v3(void);
uint32_t terra_sizeof_request_v1(void);
uint32_t terra_sizeof_patch_decision_v1(void);
uint32_t terra_sizeof_draw_range_v1(void);
uint32_t terra_sizeof_frame_v1(void);
uint32_t terra_sizeof_stats_v1(void);
uint32_t terra_sizeof_atmosphere_parameters_v1(void);
uint32_t terra_sizeof_atmosphere_result_v1(void);

terra_status terra_compute_atmosphere(
    const terra_atmosphere_parameters_v1* parameters,
    terra_atmosphere_result_v1* result,
    uint8_t* rgba,
    uint32_t rgba_capacity);

terra_context* terra_create(void);
void terra_destroy(terra_context* context);

/* Immutable instance capacity, configured before loading terrain. Selected
 * mesh and decoded-record ceilings are mesh_bytes; height ceiling is twice
 * mesh_bytes; default publication ceiling is four times mesh_bytes (uint32
 * capped). Default: 32/32/64/128 MiB. These are not allocation grants: work
 * credit and managed joint admission remain required. Repeating the same
 * capacity is valid; changing it after manifest load is rejected. */
terra_status terra_configure_terrain_capacity(terra_context* context, uint32_t mesh_bytes);

/* Host-funded decoded output per production call. Native hosts start with the
 * 32 MiB pool limit; managed adapters set exact credit and close it after use. */
terra_status terra_set_record_work_limit(terra_context* context, uint32_t bytes);
uint32_t terra_record_payload_bytes(const terra_context* context);
terra_status terra_trim_record_cache(terra_context* context, uint32_t maximum_bytes);

terra_status terra_load_terrain_manifest(terra_context* context,
                                 const terra_terrain_manifest_v3* manifest);
terra_status terra_set_viewport(terra_context* context,
                                const terra_viewport_v1* viewport);
terra_status terra_set_camera(terra_context* context,
                              const terra_camera_v3* camera);
terra_status terra_set_globe_target(terra_context* context,
                                    double longitude_degrees,
                                    double latitude_degrees);
terra_status terra_set_planar_target(terra_context* context,
                                     double x, double y);
terra_status terra_set_planar_level(terra_context* context,
                                    uint32_t target_level);
terra_status terra_submit_record(terra_context* context,
                                 uint32_t kind,
                                 const terra_patch_key_v1* key,
                                 const uint8_t* data,
                                 size_t data_size);
terra_status terra_fail_record(terra_context* context,
                               uint32_t kind,
                               const terra_patch_key_v1* key);
/* Confirmed missing detail uses zero residual synthesis, as desktop NULL_DATA.
 * Missing roots and network failures must continue to use terra_fail_record. */
terra_status terra_no_data_record(terra_context* context,
                                  const terra_patch_key_v1* key);
terra_status terra_set_terrain_mesh_budget(terra_context* context, uint32_t bytes);
terra_status terra_retry_record(terra_context* context,
                                uint32_t kind,
                                const terra_patch_key_v1* key);
terra_status terra_update(terra_context* context, float lod_threshold);
size_t terra_sizeof_update_budget_v2(void);
size_t terra_sizeof_update_state_v2(void);
size_t terra_sizeof_mesh_resource_v3(void);
size_t terra_sizeof_frame_receipt_v2(void);
terra_status terra_update_step(terra_context* context, float lod_threshold,
                               const terra_update_budget_v2* budget);
size_t terra_sizeof_mesh_plan_v1(void);
/* Replaces an earlier unmaterialized plan, without publishing or allocating
 * position/UV arrays. New IDs are reserved and cannot expose array views yet. */
terra_status terra_prepare_mesh_frame(terra_context* context, float lod_threshold,
    const terra_update_budget_v2* budget, terra_mesh_plan_v1* plan);
terra_status terra_get_prepared_mesh_resources(const terra_context* context,
    uint32_t plan_id, terra_mesh_resource_v3* resources, size_t capacity, size_t* count);
#define TERRA_MESH_SAMPLE_LIMIT 1024U
/* Samples exact UVs of a resource in the current (possibly mixed) candidate,
 * before production. Caller owns/credits 2 * vertex_count floats; at most
 * TERRA_MESH_SAMPLE_LIMIT vertices per call. No native payload allocation,
 * height sampling or publication. Invalid input leaves output untouched.
 * Zero count accepts null output, including at the end of a valid resource.
 * Replacement, discard and completed materialization invalidate this read.
 * Resource lookup scans candidate descriptors; this is not a time deadline. */
terra_status terra_get_prepared_mesh_uv(const terra_context* context,
    uint32_t plan_id, uint32_t resource_id, uint32_t first_vertex,
    uint32_t vertex_count, float* output);
/* Same range/lifetime contract as the UV read, for 3 * vertex_count floats.
 * Samples exact relative XYZ positions using the plan's frozen height input;
 * resident members of a mixed/partially produced candidate use their actual
 * payload. Background camera/model/height progress cannot change this result.
 * No native mesh payload allocation, publication or imagery planner mutation.
 * The caller must credit its scratch/output storage before reading. */
terra_status terra_get_prepared_mesh_positions(const terra_context* context,
    uint32_t plan_id, uint32_t resource_id, uint32_t first_vertex,
    uint32_t vertex_count, float* output);
/* Continue an admitted immutable candidate: at most 64 descriptors scanned and
 * one CBDAM fragment generated per call. The fragment dimension is at most 256;
 * allocation and admission are not wall-clock deadlines.
 * The first call requires credit for every new native payload byte, in addition
 * to the plan's resident limit. Repeat the same credit until complete=1 or
 * discard; capacity denial before admission leaves the plan retryable.
 * Group selection is frozen until generation completes; boundary planning may
 * run before generation or after complete=1, never during partial generation. Camera,
 * record and background model changes preserve the prepared height snapshot.
 * Even at complete=1 the published frame/sequence/receipt remain unchanged.
 * Generated resources may be borrowed for candidate evaluation. Commit publishes
 * the selected cut; discard keeps the previous publication. After complete=1,
 * an existing or newly computed boundary proof permits another complete group selection;
 * use its fresh cost description and finish generation again before commit.
 * Failure/cancellation can retain completed cache allocations; query actual
 * native ownership before refunding credit. Error leaves complete untouched. */
terra_status terra_step_mesh_frame(terra_context* context, uint32_t plan_id,
    uint32_t maximum_new_bytes, uint32_t* complete);
/* Publish only a fully generated current selection. Consumes the plan exactly
 * once; rejects incomplete, discarded and already committed plans. No payload
 * generation or copying occurs here. Synchronous update APIs perform this
 * commit internally; prepare/step owners must call it explicitly. */
terra_status terra_commit_mesh_frame(terra_context* context, uint32_t plan_id);
terra_status terra_discard_mesh_plan(terra_context* context, uint32_t plan_id);
/* Unique live position/UV allocation bytes, including cached, prepared and
 * presented owners. Available before the first publication. Not Wasm heap size. */
uint32_t terra_mesh_payload_bytes(const terra_context* context);
/* Releases only cache-exclusive meshes. Prepared/displayed resources remain
 * valid; success need not reach the target. Query actual bytes after completion,
 * including on failure, before refunding external production credit. */
terra_status terra_trim_mesh_cache(terra_context* context, uint32_t maximum_bytes);
/* Native boundary planning uses only edge samples of the prepared target and
 * submitted old IDs. Obtain/credit the bounded work payload before begin. Step
 * does not generate full arrays or publish. End releases scratch on every path;
 * it preserves the metadata plan. Materialization and commit require ending
 * this work. A fully generated unpublished target may begin boundary work;
 * its immutable arrays are read directly without regenerating geometry.
 * Step samples at most min(4, maximum_operations) bounded-size patches, or
 * advances that many edge/event/comparison/output operations. Equal-coordinate
 * event groups can yield; a partial proof is never readable. This work-count
 * bound is not a wall-clock or allocator deadline for begin/end/step.
 * The quote takes the same sorted immutable before_ids as begin, counts shared
 * old/new boundary inputs once, and retains both output memberships. Invalid
 * shape/ID ordering returns zero. The quote neither generates meshes nor allocates work. */
uint32_t terra_mesh_replacement_work_bytes(const terra_context* context, uint32_t plan_id,
    const uint32_t* before_ids, size_t count);
terra_status terra_begin_mesh_replacement(terra_context* context, uint32_t plan_id,
    const uint32_t* before_ids, size_t count, uint32_t maximum_work_bytes);
terra_status terra_step_mesh_replacement(terra_context* context, uint32_t plan_id,
    uint32_t maximum_operations, uint32_t* complete);
terra_status terra_get_mesh_replacement(const terra_context* context, uint32_t plan_id,
    terra_replacement_member_v1* members, size_t capacity, size_t* count);
terra_status terra_end_mesh_replacement(terra_context* context, uint32_t plan_id);
/* Rebase the last completed proof on a submitted cut made of whole old/new
 * groups. A cache miss returns OK with reused=0; callers then plan boundaries.
 * A hit seals a proof readable by get_mesh_replacement, without mesh generation
 * or boundary scratch. before_ids is the complete sorted non-coverage cut. */
terra_status terra_reuse_mesh_replacement(terra_context* context, uint32_t plan_id,
    const uint32_t* before_ids, size_t count, uint32_t* reused);
/* Select complete dependency groups after ending boundary work. Unselected
 * groups keep their presented resources. Repeated selection replaces the prior
 * selection against the same original target; it does not produce arrays.
 * The returned plan reports the mixed candidate's actual production costs. */
terra_status terra_select_mesh_groups(terra_context* context, uint32_t plan_id,
    const uint32_t* groups, size_t count, terra_mesh_plan_v1* plan);
size_t terra_sizeof_replacement_member_v1(void);
/* Per-call height production window. Numeric payload remains charged separately
 * through its final reader. A zero byte grant permits discovery only. A finite
 * build limit also bounds scanning to 64 dependency records per continuation.
 * Native hosts default to a batch window (32 MiB, UINT32_MAX builds).
 * WORK_PENDING leaves output/frame untouched and retains the selection camera,
 * topology and dependency cursor. Repeat the same update operation after
 * granting terra_height_work_bytes(), or discard to select a different epoch.
 * A zero quote can mean metadata scanning still needs another bounded slice.
 * The quote includes output, codec scratch and necessary shared-input copies;
 * no height allocation takes place before the grant covers the whole operation.
 * CAPACITY_PENDING means native retained ownership prevents production; it drops
 * the work cursor (not cached payload), permitting a new/coarsening selection
 * after demand or ownership changes instead of repeatedly resuming a stuck cut. */
terra_status terra_set_height_work_limit(terra_context* context, uint32_t bytes,
    uint32_t maximum_builds);
uint32_t terra_height_work_bytes(const terra_context* context);
uint32_t terra_height_payload_bytes(const terra_context* context);
/* Reclaim only idle unique samples. Active dependency closures and immutable
 * prepared snapshots remain held; read actual bytes after the trim receipt. */
terra_status terra_trim_height_cache(terra_context* context, uint32_t maximum_bytes);
terra_status terra_discard_terrain_work(terra_context* context);
/* Advance CBDAM selection, height preparation and the request frontier without
 * publishing a mesh frame. The current candidate's arrays, sequence and receipt
 * remain valid. progress reports model work; its memory counters are not filled.
 * terra_get_update_state continues to describe the published candidate. */
terra_status terra_advance_terrain(terra_context* context, float lod_threshold,
                                  const terra_update_budget_v2* budget,
                                  terra_update_state_v2* progress);
float terra_get_terrain_error(const terra_context* context);
uint32_t terra_sizeof_terrain_sample_v1(void);
/* Finest resident reconstructed height at u/v (degrees for cylindrical,
 * dataset coordinates for planar). No I/O, mesh publication, cache pinning or
 * LOD mutation. available=0 is a successful query with no resident coverage.
 * Available samples are interpolations, not guaranteed full dataset precision. */
terra_status terra_sample_terrain(const terra_context* context, double u, double v,
                                  terra_terrain_sample_v1* sample);
uint32_t terra_sizeof_height_query_state_v1(void);
uint32_t terra_sizeof_height_region_v1(void);
/* One independent query per context, identified across all async submissions.
 * No viewport, camera, mesh frame or visible-height mutation is required.
 * maximum_bytes caps query decoded payload and refinement scratch (<=32 MiB).
 * Caller also admits 512 KiB metadata and bounded encoded ingress. */
terra_status terra_begin_height_query(terra_context* context, double u, double v,
    double sample_spacing_metres, uint32_t maximum_level, uint32_t maximum_bytes,
    terra_height_query_state_v1* state);
terra_status terra_step_height_query(terra_context* context, uint32_t query_id,
    uint32_t maximum_work, terra_height_query_state_v1* state);
terra_status terra_get_height_query_requests(const terra_context* context,
    uint32_t query_id, terra_request_v1* requests, size_t capacity, size_t* count);
/* For a live query, an exact previously consumed kind/key is an idempotent
 * receipt (including after completion): no decode or precision mutation.
 * Never-requested inputs return NOT_FOUND; ended query IDs remain invalid. */
terra_status terra_submit_height_query_record(terra_context* context, uint32_t query_id,
    uint32_t kind, const terra_patch_key_v1* key, const uint8_t* data, size_t size);
/* Confirmed absent detail uses zero residual with inherited source precision;
 * absent roots remain unavailable. failed=1 never authorizes synthesis.
 * Late failures for consumed inputs acknowledge the original result. */
terra_status terra_height_query_unavailable(terra_context* context, uint32_t query_id,
    uint32_t kind, const terra_patch_key_v1* key, uint32_t failed);
terra_status terra_end_height_query(terra_context* context, uint32_t query_id);
/* Copies a completed target under caller-owned credit. BUFFER_TOO_SMALL still
 * describes the exact required count; unavailable targets return count zero. */
terra_status terra_get_height_query_region(const terra_context* context, uint32_t query_id,
    terra_height_region_v1* region, int32_t* values, size_t capacity, size_t* count);
uint32_t terra_get_no_data_count(const terra_context* context);
terra_status terra_get_update_state(const terra_context* context,
                                    terra_update_state_v2* state);
terra_status terra_get_mesh_resources(const terra_context* context,
                                      terra_mesh_resource_v3* resources,
                                      size_t capacity, size_t* count);
/* Stable content IDs let consumers transfer only previously unseen meshes.
 * Views have the same lifetime as v1 views. Presenting the current sequence
 * retains its resources until local retirement, a later presentation or reset.
 * Consumers must acknowledge a candidate before submitting another candidate.
 */
const float* terra_get_mesh_position_view(const terra_context* context,
                                         uint32_t resource_id);
const float* terra_get_mesh_texture_view(const terra_context* context,
                                        uint32_t resource_id);
/* Read-only native payload loans, independent of presentation ownership. Each
 * acquire must be released once. A loan prevents cache reclamation and manifest
 * reset; destroy ends all loans. Payload pointers remain stable while borrowed.
 * Wasm consumers must rebind typed views after linear-memory growth. */
terra_status terra_acquire_mesh_resource(terra_context* context, uint32_t resource_id);
terra_status terra_release_mesh_resource(terra_context* context, uint32_t resource_id);
terra_status terra_present_frame(terra_context* context,
                                 const terra_frame_receipt_v2* receipt);
/* Replace display ownership with exactly these submitted mesh IDs, drawn from
 * the current candidate and/or previous display owner. IDs must be positive and
 * strictly increasing. Validate the complete set before changing ownership.
 * This can retain a mixed cut independently of future candidate publication;
 * it does not acknowledge the complete candidate frame. Empty releases display. */
terra_status terra_retain_meshes(terra_context* context,
                                 const terra_frame_receipt_v2* receipt,
                                 const uint32_t* resource_ids, size_t count);
size_t terra_sizeof_imagery_options_v4(void);
size_t terra_sizeof_surface_work_v1(void);
size_t terra_sizeof_surface_projection_v1(void);
size_t terra_sizeof_surface_summary_v1(void);
/* plan_id0 borrows a resident mesh; a nonzero current plan freezes its exact
 * candidate sampling. Reuse supplies only a compatible immutable UV layout.
 * Model/source loans end with their last model/active-measurement holder, or
 * manifest replacement. Ready measurement
 * handles contain canonical numbers only, independent of mesh lifetime.
 * ID generations never restart at manifest replacement; late grants fail.
 */
uint32_t terra_surface_model_work_bytes(void);
uint32_t terra_surface_measurement_work_bytes(void);
terra_status terra_open_surface_model(terra_context* context,uint32_t plan_id,uint32_t resource_id,
    uint32_t reuse_model_id,uint32_t maximum_work_bytes,uint32_t* model_id);
terra_status terra_step_surface_model(terra_context* context,uint32_t model_id,uint32_t maximum_operations,
    double maximum_milliseconds,uint32_t quote_id,uint32_t maximum_work_bytes,terra_surface_work_v1* progress);
terra_status terra_close_surface_model(terra_context* context,uint32_t model_id);
/* Source anchor comes from the actual CBDAM model, never from TMS/WMTS IDs.
 * Optional domain codes select explicit model subsets; callers assembling a
 * complete measurement must preserve its other domains. At most256 codes,
 * each in0..335; overlapping or absent model domains are invalid.
 * previous_measurement_id selects complete same-session evidence for this
 * actual resource, exact matrix/pixel scales and source revision. It requires
 * tight=1, no bounds_only or explicit subset. Only its scalar domains are
 * remeasured; existing projective rows form the rest of the complete result.
 * Production and canonical-input stages use the same host input grant lane.
 */
terra_status terra_open_surface_measurement(terra_context* context,uint32_t session_id,
    const terra_surface_projection_v1* request,const uint32_t* domains,uint32_t domain_count,
    uint32_t maximum_work_bytes,uint32_t* measurement_id);
terra_status terra_step_surface_measurement(terra_context* context,uint32_t session_id,uint32_t measurement_id,
    uint32_t maximum_operations,double maximum_milliseconds,uint32_t quote_id,
    uint32_t maximum_work_bytes,terra_surface_work_v1* progress);
terra_status terra_get_surface_measurement_summary(const terra_context* context,uint32_t measurement_id,
    terra_surface_summary_v1* summary);
terra_status terra_get_surface_measurement_regions(const terra_context* context,uint32_t session_id,
    uint32_t measurement_id,uint32_t first,terra_imagery_region_v4* regions,uint32_t capacity,uint32_t* count);
terra_status terra_get_surface_measurement_hull(const terra_context* context,uint32_t session_id,
    uint32_t measurement_id,uint32_t first,terra_imagery_hull_point_v3* points,uint32_t capacity,uint32_t* count);
/* Append the sealed owner to the current input transaction without copying its
 * rows. Same-session only. Closing the measurement cannot refund planner loans.
 */
terra_status terra_append_measured_imagery_surface(terra_context* context,uint32_t session_id,
    uint32_t measurement_id,uint32_t draw_index);
terra_status terra_close_surface_measurement(terra_context* context,uint32_t measurement_id);
size_t terra_sizeof_imagery_surface_v3(void);
size_t terra_sizeof_imagery_region_v4(void);
size_t terra_sizeof_imagery_hull_point_v3(void);
size_t terra_sizeof_imagery_draw_v3(void);
size_t terra_sizeof_imagery_quality_v4(void);
/* All live session trees, measurements, queues and published output capacities.
 * Owned allocation payload only: excludes allocator/account bookkeeping,
 * caller packing buffers, opaque callback captures and JS/Worker copies. This is observation,
 * not a production grant or a process/Wasm-memory limit. */
uint32_t terra_imagery_payload_bytes(const terra_context* context);
/* Input ownership and arrays are a subset of total imagery residency. Quote
 * member storage and its identity registry, new ownership blocks, and the sum
 * of new per-surface region/hull counts (including repeated source ranges). UINT32_MAX
 * means the quote is not representable. A begin/plan grant covers new input
 * production in addition to still-live old input; caller packing is separate.
 * The quote includes commit-stage registry storage, not just arrays currently
 * allocated by staging. Reserved credit is not current payload residency.
 * Refusal happens before conversion or any planner mutation. Tree/queue/output
 * allocations are separate and are not bounded by this input grant. */
uint32_t terra_imagery_input_work_bytes(uint32_t surface_count, uint32_t new_surface_count, uint32_t region_count,
    uint32_t hull_point_count);
uint32_t terra_imagery_input_payload_bytes(const terra_context* context);
/* Filtered region indices are a separate subset of total imagery residency.
 * Work quotes describe the next allocation, including overlap with its old
 * buffer. A zero grant can advance without allocating new indices. On a
 * shortage step preserves its cursor and publishes only a complete cut; query
 * work bytes, obtain credit, then continue. Other tree metadata is separate. */
uint32_t terra_imagery_reference_payload_bytes(const terra_context* context);
uint32_t terra_imagery_reference_work_bytes(const terra_context* context, uint32_t session_id);
/* Immutable draw payload is charged until its last snapshot owner releases it.
 * A pending output quote includes the new snapshot while the old one survives.
 * Other tree/queue metadata is separate. */
uint32_t terra_imagery_output_payload_bytes(const terra_context* context);
uint32_t terra_imagery_output_work_bytes(const terra_context* context, uint32_t session_id);
/* Reclaim consumed/stale index caches, never current or queued child inputs.
 * At most 64 reference/node visits per call across all sessions. Restart begins
 * a new scan; intervening planning also restarts it safely. Pending means that
 * another slice may reclaim more. Released is an actual destruction receipt.
 * Expanded parents reuse measured children. Terminal leaves cannot refine under
 * this revision's budget; a new revision replaces input before reading indices.
 * Output identity, regional error and spatial selection are unchanged. */
terra_status terra_reclaim_imagery_references(terra_context* context, uint32_t needed_bytes,
    uint32_t maximum_visits, uint32_t restart, uint32_t* released_bytes, uint32_t* pending);
/* One displayed cut and one speculative candidate may plan independently.
 * Sessions own persistent trees, input normalization, admission history and
 * output. They share coordinate rules, not mutable planner state. Open requires
 * a manifest; closing a session or loading a manifest invalidates its ID.
 * IDs are context-local and never reused within that context's lifetime.
 * Reset clears one session without changing its ID or the other session.
 * Session count bounds concurrent planners, not their metadata byte usage. */
#define TERRA_IMAGERY_SESSION_LIMIT 2U
terra_status terra_open_imagery(terra_context* context, uint32_t* session_id);
terra_status terra_close_imagery(terra_context* context, uint32_t session_id);
/* Stage converted input with a bounded caller scratch buffer. One stage per
 * session; append one surface then its regions/hull before the next surface.
 * Surface range offsets must be zero and total counts must match the quote.
 * region_count/hull_point_count price only new inputs; retained members keep
 * their existing charge. The complete cut, including retained members, must
 * still fit the 1,048,576-region and 393,216-hull-point shape limits.
 * Each region/hull batch is at most 256 entries. Old input/output remain usable
 * until commit; cancellation frees only staging. Counts and production credit
 * are validated before allocation. reset_history is applied only at commit.
 * begin_only=1 starts bounded planning; 0 also completes synchronous planning.
 * Input residency includes staging; tree initialization at commit is separate. */
terra_status terra_stage_imagery_input(terra_context* context, uint32_t session_id,
    const terra_imagery_options_v4* options, uint32_t surface_count, uint32_t new_surface_count,
    uint32_t region_count, uint32_t hull_point_count, uint32_t maximum_input_work_bytes,
    uint32_t reset_history);
terra_status terra_append_imagery_surface(terra_context* context, uint32_t session_id,
    const terra_imagery_surface_v3* surface);
/* Rebind an immutable input from the session's current cut. It consumes one
 * member but no new-surface/region/hull credit. Source indices must be unique.
 * The held input survives reset and cancellation until its last real owner
 * retires. A missing or ambiguous index is rejected before changing staging. */
terra_status terra_append_retained_imagery_surface(terra_context* context, uint32_t session_id,
    uint32_t previous_draw_index, uint32_t draw_index);
terra_status terra_append_imagery_regions(terra_context* context, uint32_t session_id,
    const terra_imagery_region_v4* regions, uint32_t count);
terra_status terra_append_imagery_hull(terra_context* context, uint32_t session_id,
    const terra_imagery_hull_point_v3* points, uint32_t count);
terra_status terra_commit_imagery_input(terra_context* context, uint32_t session_id, uint32_t begin_only);
terra_status terra_cancel_imagery_input(terra_context* context, uint32_t session_id);
terra_status terra_plan_imagery(terra_context* context, uint32_t session_id,
    const terra_imagery_options_v4* options,
    const terra_imagery_surface_v3* surfaces, size_t surface_count,
    const terra_imagery_region_v4* regions, size_t region_count,
    const terra_imagery_hull_point_v3* hull_points, size_t hull_point_count,
    uint32_t maximum_input_work_bytes);
/* Copy input once, then normalize projections and continue tree priorities
 * under a bounded budget (at most 64 input regions per priority credit).
 * Quality bit 64 marks rebuilding: initialization may return no draws, and
 * callers must retain their prior demand until a usable cut is available.
 * The source-resource base budget is checked after normalization; a step may
 * reject an infeasible input accepted by begin. Bit 32 indicates more work.
 * Completion means admission finished, not that its SSE target fits the
 * capacity or all textures reached the GPU. Synchronous planning is unchanged. */
terra_status terra_begin_imagery(terra_context* context, uint32_t session_id,
    const terra_imagery_options_v4* options,
    const terra_imagery_surface_v3* surfaces, size_t surface_count,
    const terra_imagery_region_v4* regions, size_t region_count,
    const terra_imagery_hull_point_v3* hull_points, size_t hull_point_count,
    uint32_t maximum_input_work_bytes);
terra_status terra_step_imagery(terra_context* context, uint32_t session_id, uint32_t maximum_changes,
    uint32_t maximum_priorities, double maximum_milliseconds,
    uint32_t maximum_reference_work_bytes, uint32_t maximum_output_work_bytes, uint32_t* complete);
/* Convert a bounded snapshot range directly into caller-owned storage, without
 * retaining another native draw array. Capacity zero reports remaining rows;
 * otherwise writes min(capacity, remaining), with at most 256 rows per call. */
terra_status terra_get_imagery_draws(const terra_context* context, uint32_t session_id,
    size_t first, terra_imagery_draw_v3* draws, size_t capacity, size_t* count);
terra_status terra_get_imagery_quality(const terra_context* context, uint32_t session_id,
    terra_imagery_quality_v4* quality);
/* Empty draws update the resource epoch and resume previously denied demand.
   Nonempty draws feed a partition-admitted cut back into the persistent tree. */
terra_status terra_accept_imagery(terra_context* context, uint32_t session_id,
    const terra_imagery_draw_v3* draws, size_t count, uint32_t admission_revision);
terra_status terra_reset_imagery(terra_context* context, uint32_t session_id);

terra_status terra_get_camera_snapshot(const terra_context* context,
                                       terra_camera_snapshot_v1* snapshot);

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
