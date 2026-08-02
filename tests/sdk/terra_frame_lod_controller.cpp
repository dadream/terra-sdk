#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>

#include <algorithm>
#include <numeric>
#include <stdexcept>
#include <string>

namespace {

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
  require(!has_patch(refined, selected),
          "refined parent remained in the active leaf cut");
  require(leaf_count(refined) == refined.patches.size(),
          "refined leaf accounting is inconsistent");

  const terra::frame::lod_cut coarsened =
      controller.update(1.0F, snapshot, resources);
  require(coarsened.complete && coarsened.patches.size() == 8U,
          "coarsen did not restore the root cut");
  require(has_patch(coarsened, selected),
          "coarsen did not restore the selected parent leaf");

  terra::frame::cylindrical_lod_controller unavailable_controller;
  unavailable_controller.configure(6378000.0, 64U);
  terra::frame::lod_resource_state unavailable_resources;
  unavailable_resources.available_roots.push_back(selected);
  unavailable_resources.unavailable_details.push_back(selected);
  const terra::frame::lod_cut unavailable =
      unavailable_controller.update(0.005F, snapshot,
                                    unavailable_resources);
  require(unavailable.patches.size() == 8U &&
              has_patch(unavailable, selected),
          "unavailable detail removed its parent leaf");
  require(!requests_detail(unavailable, selected),
          "unavailable detail remained in the request frontier");
  return 0;
}
