#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>

#include <algorithm>
#include <cmath>
#include <numeric>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using resource_key = std::pair<std::size_t, terra::core::grid_point>;

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::size_t leaf_count(const terra::frame::lod_cut& cut) {
  return std::accumulate(cut.leaf_count_by_level.begin(),
                         cut.leaf_count_by_level.end(),
                         std::size_t(0U));
}

bool has_patch(const terra::frame::lod_cut& cut,
               const terra::frame::lod_detail_key& key) {
  return std::any_of(
      cut.patches.begin(), cut.patches.end(),
      [&key](const terra::frame::lod_patch& patch) {
        return patch.level == key.level && patch.id == key.id;
      });
}

bool requests_detail(const terra::frame::lod_cut& cut,
                     const terra::frame::lod_detail_key& key) {
  return std::any_of(
      cut.record_requests.begin(), cut.record_requests.end(),
      [&key](const terra::frame::lod_record_request& request) {
        return request.kind == terra::frame::lod_record_kind::detail &&
               request.patch.level == key.level &&
               request.patch.id == key.id;
      });
}

resource_key make_resource_key(const terra::frame::lod_patch& patch) {
  return std::make_pair(patch.level, patch.id);
}

struct runtime_resource_session {
  std::set<resource_key> root_cache;
  std::set<resource_key> detail_cache;
  terra::frame::lod_resource_state active_resources;
};

std::size_t cache_active_requests(
    const terra::frame::lod_cut& cut,
    runtime_resource_session& session) {
  session.active_resources = terra::frame::lod_resource_state();
  std::size_t added = 0U;
  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    const resource_key key = make_resource_key(request.patch);
    terra::frame::lod_detail_key detail;
    detail.level = request.patch.level;
    detail.id = request.patch.id;
    if (request.kind == terra::frame::lod_record_kind::root) {
      added += session.root_cache.insert(key).second ? 1U : 0U;
      session.active_resources.available_roots.push_back(detail);
    } else {
      added += session.detail_cache.insert(key).second ? 1U : 0U;
      session.active_resources.available_details.push_back(detail);
    }
  }
  return added;
}

terra::frame::lod_cut settle_controller(
    terra::frame::cylindrical_lod_controller& controller,
    float threshold, const terra::frame::camera_snapshot& camera,
    runtime_resource_session& session) {
  const std::size_t maximum_iterations = 256U;
  for (std::size_t iteration = 0U;
       iteration < maximum_iterations; ++iteration) {
    const terra::frame::lod_cut cut =
        controller.update(threshold, camera, session.active_resources);
    const std::size_t added = cache_active_requests(cut, session);
    require(added <= 64U,
            "persistent LOD request frontier exceeded its bounded wave");
    if (cut.complete && cut.converged && added == 0U) {
      return cut;
    }
  }
  throw std::runtime_error(
      "persistent LOD controller did not reach a stable cut");
}

std::set<resource_key> visible_patch_keys(
    const terra::frame::lod_cut& cut) {
  std::set<resource_key> keys;
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (patch.visible) {
      keys.insert(make_resource_key(patch));
    }
  }
  return keys;
}

float maximum_visible_priority(const terra::frame::lod_cut& cut) {
  float maximum = 0.0F;
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (patch.visible) {
      maximum = std::max(maximum, patch.priority);
    }
  }
  return maximum;
}

std::size_t maximum_visible_level(const terra::frame::lod_cut& cut) {
  std::size_t maximum = 0U;
  for (const terra::frame::lod_patch& patch : cut.patches) {
    if (patch.visible) {
      maximum = std::max(maximum, patch.level);
    }
  }
  return maximum;
}

}  // namespace

int main() {
  const float y_fov =
      static_cast<float>(30.0 * (3.14159265358979323846 / 180.0));
  const terra::frame::globe_camera camera(
      static_cast<float>(6378000.0), 1280, 720, y_fov);
  const terra::frame::camera_snapshot snapshot = camera.snapshot();

  terra::frame::cylindrical_lod_controller controller;
  controller.configure(6378000.0, 64U);
  terra::frame::lod_resource_state resources;
  const terra::frame::lod_cut waiting =
      controller.update(0.005F, snapshot, resources);
  require(waiting.complete && waiting.patches.size() == 8U,
          "controller must start from the complete root cut");
  require(!waiting.converged,
          "waiting refinement was reported as converged");
  require(leaf_count(waiting) == waiting.patches.size(),
          "root leaf accounting is inconsistent");

  const auto pending = std::find_if(
      waiting.record_requests.begin(), waiting.record_requests.end(),
      [](const terra::frame::lod_record_request& request) {
        return request.kind == terra::frame::lod_record_kind::detail &&
               request.patch.visible;
      });
  require(pending != waiting.record_requests.end(),
          "visible root refinement was not requested");
  terra::frame::lod_detail_key selected;
  selected.level = pending->patch.level;
  selected.id = pending->patch.id;

  resources.available_roots.push_back(selected);
  resources.available_details.push_back(selected);
  const terra::frame::lod_cut refined =
      controller.update(0.005F, snapshot, resources);
  require(refined.complete && refined.patches.size() > waiting.patches.size(),
          "available detail did not refine the active cut");
  require(!refined.converged && refined.change_count == 1U,
          "refine did not report its bounded topology change");
  require(!has_patch(refined, selected),
          "refined parent remained in the active leaf cut");
  require(leaf_count(refined) == refined.patches.size(),
          "refined leaf accounting is inconsistent");

  const terra::frame::lod_cut coarsened =
      controller.update(1.0F, snapshot, resources);
  require(coarsened.complete && !coarsened.converged &&
              coarsened.change_count == 1U &&
              coarsened.patches.size() == 8U,
          "coarsen did not restore the root cut");
  require(has_patch(coarsened, selected),
          "coarsen did not restore the selected parent leaf");
  const terra::frame::lod_cut settled =
      controller.update(1.0F, snapshot, resources);
  require(settled.complete && settled.converged &&
              settled.change_count == 0U && settled.patches.size() == 8U,
          "unchanged cut did not report convergence");

  terra::frame::cylindrical_lod_controller unavailable_controller;
  unavailable_controller.configure(6378000.0, 64U);
  terra::frame::lod_resource_state unavailable_resources;
  for (const terra::frame::lod_record_request& request :
       waiting.record_requests) {
    terra::frame::lod_detail_key unavailable_key;
    unavailable_key.level = request.patch.level;
    unavailable_key.id = request.patch.id;
    if (request.kind == terra::frame::lod_record_kind::root) {
      unavailable_resources.available_roots.push_back(unavailable_key);
    } else {
      unavailable_resources.unavailable_details.push_back(
          unavailable_key);
    }
  }
  const terra::frame::lod_cut unavailable =
      unavailable_controller.update(0.005F, snapshot,
                                    unavailable_resources);
  require(unavailable.converged && unavailable.change_count == 0U &&
              unavailable.patches.size() == 8U &&
              has_patch(unavailable, selected),
          "unavailable detail removed its parent leaf");
  require(requests_detail(unavailable, selected),
          "active unavailable detail disappeared from the dependency frontier");

  const double radius = 6378000.0;
  const int viewport_height = 958;
  const float transition_fov =
      static_cast<float>(45.0 * (3.14159265358979323846 / 180.0));
  const float transition_threshold =
      1.25F / static_cast<float>(viewport_height) *
      2.0F * std::tan(transition_fov * 0.5F);
  terra::frame::globe_camera transition_camera(
      static_cast<float>(radius), 1740, viewport_height, transition_fov);
  require(transition_camera.set_target_degrees(118.81039, 31.62401),
          "failed to configure transition camera target");

  terra::frame::cylindrical_lod_controller transition_controller;
  transition_controller.configure(radius, 64U, 30U, 65536U);
  runtime_resource_session transition_resources;

  transition_camera.set_distance(radius * 2.5);
  const terra::frame::lod_cut initial_far = settle_controller(
      transition_controller, transition_threshold,
      transition_camera.snapshot(), transition_resources);
  require(maximum_visible_priority(initial_far) <=
              transition_threshold * 1.001F,
          "initial far view stopped above the LOD threshold");

  transition_camera.set_distance(6424237.5);
  const terra::frame::camera_snapshot near_snapshot =
      transition_camera.snapshot();
  const terra::frame::lod_cut reference =
      terra::frame::select_procedural_cylindrical_lod(
          radius, 64U, transition_threshold, near_snapshot, 30U, 65536U);
  const terra::frame::lod_cut near = settle_controller(
      transition_controller, transition_threshold, near_snapshot,
      transition_resources);
  require(maximum_visible_priority(near) <=
              transition_threshold * 1.001F,
          "near view falsely converged above the LOD threshold");
  require(maximum_visible_level(near) >= 20U,
          "near view did not refine to the expected globe scale");
  require(visible_patch_keys(near) == visible_patch_keys(reference),
          "persistent near cut differs from the one-shot LOD reference");

  transition_camera.set_distance(radius * 2.5);
  static_cast<void>(settle_controller(
      transition_controller, transition_threshold,
      transition_camera.snapshot(), transition_resources));
  transition_camera.set_distance(6424237.5);
  const terra::frame::lod_cut repeated_near = settle_controller(
      transition_controller, transition_threshold,
      transition_camera.snapshot(), transition_resources);
  require(visible_patch_keys(repeated_near) == visible_patch_keys(reference),
          "far-near transition did not restore the reference LOD cut");
  return 0;
}
