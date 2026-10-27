#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <set>
#include <stdexcept>

namespace {
using key = std::pair<std::size_t, terra::core::grid_point>;
using keys = std::set<key>;
struct selection { keys visible; float error = 0.0F; };

selection solve(double radius, double elevation, double distance) {
  const float fov = 0.5233333333333334F;
  terra::frame::globe_camera camera(static_cast<float>(radius), 960, 519, fov);
  camera.set_target_degrees(116.56230, 40.74863);
  camera.set_target_height(elevation);
  camera.set_distance(distance);
  const auto view = camera.snapshot();
  const float threshold = 1.25F / 519.0F * 2.0F * std::tan(fov * 0.5F);
  terra::frame::cylindrical_lod_controller model;
  model.configure(radius, 64U, 40U, 65536U);
  terra::frame::lod_update_budget budget;
  budget.maximum_elapsed_milliseconds = 0.0;
  budget.maximum_change_count = 128U;
  budget.maximum_priority_update_count = 1024U;
  terra::frame::lod_resource_state resources;
  keys roots, details;
  for (const auto& root : terra::core::cylindrical_roots())
    resources.height_ranges.push_back({{0U, root.id()}, elevation, elevation});
  resources.height_revision = 1U;
  for (std::size_t turn = 0U; turn < 5000U; ++turn) {
    const auto cut = model.update_step(threshold, view, resources, budget);
    if (!cut.complete || cut.limited_by_capacity) throw std::runtime_error("elevation equivalence exhausted topology safety limit");
    bool changed = false;
    for (const auto& request : cut.record_requests) {
      const key id{request.patch.level, request.patch.id};
      if (request.kind == terra::frame::lod_record_kind::root) {
        if (roots.insert(id).second) {
          resources.available_roots.push_back({id.first, id.second}); changed = true;
        }
      } else if (details.insert(id).second) {
        resources.available_details.push_back({id.first, id.second}); changed = true;
      }
    }
    if (changed) ++resources.revision;
    if (!cut.converged || changed) continue;
    selection result;
    for (const auto& patch : cut.patches) if (patch.visible) {
      if (patch.level == 40U) throw std::runtime_error("elevation equivalence reached level ceiling");
      result.visible.emplace(patch.level, patch.id);
      result.error = std::max(result.error, patch.priority);
    }
    if (result.error > threshold * 1.001F) throw std::runtime_error("elevation equivalence did not meet error");
    return result;
  }
  throw std::runtime_error("elevation equivalence did not settle");
}

struct height_source {
  terra::frame::lod_resource_state state;
  keys roots, details, measured;

  bool receive(const terra::frame::lod_cut& cut) {
    bool changed = false;
    for (const auto& request : cut.record_requests) {
      const key id{request.patch.level, request.patch.id};
      auto& available = request.kind == terra::frame::lod_record_kind::root ? roots : details;
      if (available.insert(id).second) {
        auto& destination = request.kind == terra::frame::lod_record_kind::root
            ? state.available_roots : state.available_details;
        destination.push_back({id.first, id.second}); changed = true;
      }
      if (measured.insert(id).second) {
        // Fine wavelet detail can reveal relief absent from a coarse mesh.
        // That does not change the coarse node's own reconstructed samples.
        state.height_ranges.push_back({{id.first, id.second}, id.first < 4U ? 0.0 : -250.0,
                                      id.first < 4U ? 0.0 : 6900.0});
        changed = true;
      }
    }
    if (changed) { ++state.revision; ++state.height_revision; }
    return changed;
  }
};

selection settle(terra::frame::cylindrical_lod_controller& model, height_source& source,
                 float threshold, const terra::frame::camera_snapshot& view,
                 const terra::frame::lod_update_budget& budget) {
  for (std::size_t turn = 0U; turn < 20000U; ++turn) {
    const auto cut = model.update_step(threshold, view, source.state, budget);
    if (!cut.complete || cut.limited_by_capacity || cut.change_count > budget.maximum_change_count ||
        cut.priority_update_count > budget.maximum_priority_update_count)
      throw std::runtime_error("height-history replay escaped its work/topology limits");
    const bool changed = source.receive(cut);
    if (!cut.converged || changed) continue;
    selection result;
    for (const auto& patch : cut.patches) if (patch.visible) {
      result.visible.emplace(patch.level, patch.id);
      result.error = std::max(result.error, patch.priority);
    }
    if (result.error > threshold * 1.001F) throw std::runtime_error("height-history replay lost precision");
    return result;
  }
  throw std::runtime_error("height-history replay did not settle");
}

void verify_height_history() {
  const double radius = 6378000.0;
  const float fov = 0.5233333333333334F;
  const float threshold = 1.25F / 497.0F * 2.0F * std::tan(fov * 0.5F);
  terra::frame::globe_camera camera(static_cast<float>(radius), 960, 497, fov);
  camera.set_target_degrees(116.5623, 40.74863); camera.set_target_height(508.131826);
  for (const std::size_t changes : {32U, 1U}) {
    terra::frame::cylindrical_lod_controller retained, fresh;
    retained.configure(radius, 64U, 40U, 65536U); fresh.configure(radius, 64U, 40U, 65536U);
    height_source source;
    terra::frame::lod_update_budget budget;
    budget.maximum_change_count = changes; budget.maximum_priority_update_count = changes == 1U ? 3U : 256U;
    budget.maximum_elapsed_milliseconds = 0.0;
    camera.set_distance(radius * 4.0);
    settle(retained, source, threshold, camera.snapshot(), budget);
    // Intermediate views reveal relief outside the final local footprint.
    // A direct jump to the local view does not exercise that retained history.
    for (double distance = radius * 2.0; distance > 50000.0; distance *= 0.5) {
      camera.set_distance(distance);
      settle(retained, source, threshold, camera.snapshot(), budget);
    }
    camera.set_distance(radius * 4.0);
    const auto returned = settle(retained, source, threshold, camera.snapshot(), budget);
    const auto revision = source.state.height_revision;
    const auto resource_revision = source.state.revision;
    const auto reference = settle(fresh, source, threshold, camera.snapshot(), budget);
    std::cout << "history changes=" << changes << " retained=" << returned.visible.size()
              << " fresh=" << reference.visible.size() << '\n';
    if (source.state.height_revision != revision || source.state.revision != resource_revision)
      throw std::runtime_error("fresh height-history reference changed the resource input");
    if (returned.visible != reference.visible || std::abs(returned.error - reference.error) > 1e-7F)
      throw std::runtime_error("same camera and height input retained a history-dependent terrain cut");
    for (std::size_t idle = 0U; idle < 10U; ++idle) {
      const auto parked = retained.update_step(threshold, camera.snapshot(), source.state, budget);
      if (!parked.converged || parked.change_count || parked.priority_update_count)
        throw std::runtime_error("normalized height-history cut did not stay idle");
    }
  }
}
}  // namespace

int main() {
  try {
    // Both descriptions have exactly the same world-space surface and camera:
    // sphere(R) + constant height(H) == sphere(R+H) + zero height.
    // Terrain bounds must not include an unrelated sea-level column.
    for (const double distance : {5000.0, 2000.0}) {
      const auto elevated = solve(6378000.0, 2048.0, distance);
      const auto shifted = solve(6380048.0, 0.0, distance);
      std::cout << "range=" << distance << " elevated=" << elevated.visible.size()
                << " equivalent=" << shifted.visible.size() << '\n';
      if (elevated.visible != shifted.visible || std::abs(elevated.error - shifted.error) > 1e-7F)
        throw std::runtime_error("equivalent elevated terrain produced different visibility/LOD");
    }
    verify_height_history();
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
  return 0;
}
