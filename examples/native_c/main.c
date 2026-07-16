#include <terra/c_api/terra.h>

#include <stdio.h>
#include <string.h>

static int require_ok(terra_context* context,
                      terra_status status,
                      const char* operation) {
  char message[256];
  size_t required_size = 0U;

  if (status == TERRA_STATUS_OK) {
    return 1;
  }
  memset(message, 0, sizeof(message));
  terra_get_last_error(context, message, sizeof(message), &required_size);
  fprintf(stderr, "%s failed (%d): %s\n", operation, (int)status, message);
  return 0;
}

int main(void) {
  terra_manifest_v1 manifest;
  terra_viewport_v1 viewport;
  terra_camera_v1 camera;
  terra_frame_v1 frame;
  terra_context* context;
  int passed = 1;

  if (terra_abi_version() != TERRA_C_API_VERSION) {
    fprintf(stderr, "Unsupported Terra C ABI\n");
    return 1;
  }

  context = terra_create();
  if (context == NULL) {
    fprintf(stderr, "Unable to create Terra context\n");
    return 1;
  }

  memset(&manifest, 0, sizeof(manifest));
  manifest.struct_size = sizeof(manifest);
  manifest.api_version = TERRA_C_API_VERSION;
  manifest.format_version = 1U;
  manifest.patch_dimension = 64U;
  manifest.transform = TERRA_TRANSFORM_CYLINDRICAL;
  manifest.height_scale_factor = 1.0;
  manifest.minimum_u = -180.0;
  manifest.minimum_v = -90.0;
  manifest.maximum_u = 180.0;
  manifest.maximum_v = 90.0;
  manifest.radius = 6378000.0;
  manifest.texture_maximum_level = 8U;

  memset(&viewport, 0, sizeof(viewport));
  viewport.struct_size = sizeof(viewport);
  viewport.width = 1280U;
  viewport.height = 720U;
  viewport.vertical_fov_radians = 0.5235987755982988;

  memset(&camera, 0, sizeof(camera));
  camera.struct_size = sizeof(camera);
  camera.distance = 19000000.0;

  passed = passed && require_ok(
      context, terra_load_manifest(context, &manifest), "load manifest");
  passed = passed && require_ok(
      context, terra_set_viewport(context, &viewport), "set viewport");
  passed = passed && require_ok(
      context, terra_set_camera(context, &camera), "set camera");
  passed = passed && require_ok(
      context, terra_update(context, 2.0F), "update frame");

  memset(&frame, 0, sizeof(frame));
  frame.struct_size = sizeof(frame);
  passed = passed && require_ok(
      context, terra_get_frame(context, &frame), "get frame");
  if (passed) {
    printf("Terra SDK C example: sequence %llu, %u requests\n",
           (unsigned long long)frame.sequence, frame.request_count);
  }

  terra_destroy(context);
  return passed ? 0 : 1;
}
