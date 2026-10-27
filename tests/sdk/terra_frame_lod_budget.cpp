#include <terra/core/coordinate_transform.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <cmath>
#include <numeric>
#include <set>
#include <stdexcept>
#include <utility>

namespace {

using resource_key = std::pair<std::size_t, terra::core::grid_point>;

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

struct resources {
  std::set<resource_key> roots;
  std::set<resource_key> details;
  std::set<resource_key> failed;
  terra::frame::lod_resource_state state;

  bool receive(const terra::frame::lod_cut& cut, bool reject_details = false) {
    bool changed = false;
    for (const auto& request : cut.record_requests) {
      const resource_key key(request.patch.level, request.patch.id);
      if (failed.count(key) && request.kind == terra::frame::lod_record_kind::detail) continue;
      changed = (request.kind == terra::frame::lod_record_kind::root
          ? roots.insert(key).second
          : (details.count(key) ? false : (reject_details ? failed : details).insert(key).second)) || changed;
    }
    if (changed) {
      ++state.revision;
      state.available_roots.clear();
      state.available_details.clear();
      state.unavailable_details.clear();
      for (const auto& key : roots) {
        state.available_roots.push_back({key.first, key.second});
      }
      for (const auto& key : details) {
        state.available_details.push_back({key.first, key.second});
      }
      for (const auto& key : failed) state.unavailable_details.push_back({key.first, key.second});
    }
    return changed;
  }
};

std::set<resource_key> visible_keys(const terra::frame::lod_cut& cut) {
  std::set<resource_key> result;
  for (const auto& patch : cut.patches) {
    if (patch.visible) {
      result.emplace(patch.level, patch.id);
    }
  }
  return result;
}

float maximum_visible_error(const terra::frame::lod_cut& cut) {
  float result = 0.0F;
  for (const auto& patch : cut.patches) if (patch.visible) result = std::max(result, patch.priority);
  return result;
}

// Check actual generated arrays, including root/normal aliases and independent
// UV layouts. Do not derive the expected cost from the scheduler's counters.
std::size_t visible_payload_bytes(const terra::frame::lod_cut& cut, std::uint32_t dimension = 64U) {
  std::set<std::pair<resource_key, std::uint8_t>> meshes;
  std::set<std::vector<float>> shared_uv;
  std::size_t bytes = 0U;
  const auto append = [&](const terra::frame::lod_patch& patch) {
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!patch.has_fragment(fragment) || !meshes.emplace(resource_key(patch.level, patch.id), fragment).second) continue;
      terra::frame::patch_surface_mesh mesh;
      require(terra::frame::make_cylindrical_patch_surface(patch, fragment, dimension, 6378000.0, mesh) ==
          terra::frame::surface_mesh_status::ok, "cost fixture cannot materialize terrain");
      bytes += mesh.positions_xyz.size() * sizeof(float);
      terra::frame::texture_grid_pattern pattern;
      if (!terra::frame::describe_cylindrical_texture_pattern(patch, fragment, dimension, pattern) ||
          shared_uv.insert(mesh.texture_uv).second) bytes += mesh.texture_uv.size() * sizeof(float);
    }
  };
  for (const auto& request : cut.record_requests) if (request.kind == terra::frame::lod_record_kind::root) append(request.patch);
  for (const auto& patch : cut.patches) if (patch.visible) append(patch);
  return bytes;
}

terra::frame::lod_cut settle(terra::frame::cylindrical_lod_controller& model,
                            float threshold,
                            const terra::frame::camera_snapshot& camera,
                            resources& data,
                            const terra::frame::lod_update_budget& budget,
                            bool reject_details = false) {
  for (std::size_t step = 0U; step < 20000U; ++step) {
    const auto cut = model.update_step(threshold, camera, data.state, budget);
    require(cut.complete, "a bounded step lost the complete display cut");
    require(cut.change_count <= budget.maximum_change_count,
            "dependency refinement exceeded the topology budget");
    require(cut.priority_update_count <= budget.maximum_priority_update_count,
            "a priority scan exceeded its resumable work budget");
    require(std::accumulate(cut.leaf_count_by_level.begin(),
                           cut.leaf_count_by_level.end(), std::size_t(0U)) ==
                cut.patches.size(),
            "a partial step published mismatched leaf accounting");
    const bool received = data.receive(cut, reject_details);
    if (cut.converged && !received) {
      return cut;
    }
  }
  throw std::runtime_error("bounded LOD steps did not converge");
}

}  // namespace

int main() {
  const double radius = 6378000.0;
  // Pausing topology for imagery admission must not revoke its still-needed
  // record frontier. Otherwise every zero-credit publication cancels downloads
  // which the next refinement slice immediately requests again.
  {
    terra::frame::cylindrical_lod_controller waiting;
    waiting.configure(radius, 64U, 4U, 65536U);
    terra::frame::camera_snapshot view;
    view.position = {{0.0, 0.0, radius * 2.0}};
    for (auto& plane : view.clip_planes) plane = {{0.0, 0.0, 0.0, 1.0}};
    terra::frame::lod_resource_state available;
    for (const auto& root : terra::core::cylindrical_roots())
      available.available_roots.push_back({0U, root.id()});
    available.available_details.push_back(available.available_roots.front());
    available.revision = 1U;
    terra::frame::lod_update_budget work;
    work.maximum_elapsed_milliseconds = 0.0;
    const auto pending = [&available](const terra::frame::lod_cut& cut) {
      std::set<resource_key> keys;
      for (const auto& request : cut.record_requests) {
        if (request.kind != terra::frame::lod_record_kind::detail) continue;
        const resource_key key(request.patch.level, request.patch.id);
        const bool loaded = std::any_of(available.available_details.begin(), available.available_details.end(),
            [&key](const terra::frame::lod_detail_key& item) { return key == resource_key(item.level, item.id); });
        if (!loaded) keys.insert(key);
      }
      return keys;
    };
    const auto selected = waiting.update_step(0.0F, view, available, work);
    const auto requested = pending(selected);
    require(selected.change_count > 0U && requested.size() > 1U,
        "record frontier fixture needs changed topology and concurrent missing inputs");
    work.maximum_change_count = 0U;
    for (std::size_t step = 0U; step < 3U; ++step) {
      const auto held = waiting.update_step(0.0F, view, available, work);
      require(held.change_count == 0U && visible_keys(held) == visible_keys(selected),
          "zero topology credit changed the displayed cut");
      require(pending(held) == requested,
          "zero topology credit cancelled still-needed terrain requests");
      ++available.revision; // A cache notification must preserve the same need.
    }
    waiting.update_step(0.0F, view, available, work);
    work.maximum_request_frontier_count = 0U;
    require(pending(waiting.update_step(0.0F, view, available, work)).empty(),
        "an explicit request frontier limit reused stale demand");
    work.maximum_request_frontier_count = 32U;
    require(pending(waiting.update_step(0.0F, view, available, work)) == requested,
        "restoring request discovery did not resume the same dependency frontier");
    auto away = view;
    away.clip_planes[0U] = {{0.0, 0.0, 0.0, -1.0}};
    require(pending(waiting.update_step(0.0F, away, available, work)).empty(),
        "a changed frustum retained obsolete speculative requests");
  }
  // Priority continuations must publish their completed topology checkpoint.
  // With one priority per slice, starting another split immediately after the
  // last dirty node used to keep the old root cut until all roots were split.
  {
    terra::frame::cylindrical_lod_controller checkpoints;
    checkpoints.configure(radius, 64U, 4U, 65536U);
    terra::frame::camera_snapshot view;
    view.position = {{0.0, 0.0, radius * 2.0}};
    for (auto& plane : view.clip_planes) plane = {{0.0, 0.0, 0.0, 1.0}};
    resources data;
    for (const auto& root : terra::core::cylindrical_roots()) {
      data.state.available_roots.push_back({0U, root.id()});
      data.state.available_details.push_back({0U, root.id()});
    }
    data.state.revision = 1U;
    terra::frame::lod_update_budget work;
    work.maximum_elapsed_milliseconds = 0.0;
    work.maximum_priority_update_count = 1U;
    std::size_t mutations = 0U;
    bool published = false;
    for (std::size_t step = 0U; step < 128U; ++step) {
      const auto cut = checkpoints.update_step(0.0F, view, data.state, work);
      require(cut.complete && cut.priority_update_count <= 1U, "checkpoint escaped priority budget");
      mutations += cut.change_count;
      if (cut.patches.size() != 8U) {
        require(mutations == 1U && cut.pending_priority_update_count == 0U,
            "coherent topology waited for unrelated refinements before publication");
        published = true;
        break;
      }
    }
    require(published, "bounded priority continuation starved terrain publication");
  }
  // A mountain can remain visible above a plane which excludes the ellipsoid.
  // Height arrival alone must change visibility without a camera or record change.
  terra::frame::cylindrical_lod_controller mountains;
  mountains.configure(radius, 64U, 30U, 65536U);
  terra::frame::camera_snapshot grazing;
  const auto root_id = terra::core::cylindrical_roots()[0U].id();
  const auto up = terra::core::coordinate_transform::cylindrical(radius).up_from_uvh({{-135.0, 45.0, 0.0}});
  for (std::size_t i = 0U; i < 3U; ++i) grazing.position[i] = up[i] * (radius + 20000.0);
  for (auto& plane : grazing.clip_planes) plane = {{0.0, 0.0, 0.0, 1.0}};
  grazing.clip_planes[0U] = {{up[0], up[1], up[2], -(radius + 5000.0)}};
  const auto root_visible = [&root_id](const terra::frame::lod_cut& cut) {
    return std::any_of(cut.patches.begin(), cut.patches.end(), [&root_id](const terra::frame::lod_patch& patch) {
      return patch.id == root_id && patch.visible;
    });
  };
  terra::frame::lod_resource_state elevation;
  elevation.revision = 1U;
  const auto flat = mountains.update(0.005F, grazing, elevation);
  require(!root_visible(flat), "grazing fixture did not exclude the zero-height root");
  for (const auto& patch : flat.patches) {
    if (patch.id != root_id) continue;
    terra::frame::lod_height_range range;
    range.key = {patch.level, patch.id};
    range.minimum = 0.0;
    range.maximum = 9000.0;
    elevation.height_ranges.push_back(range);
  }
  ++elevation.height_revision;
  const auto elevated = mountains.update(0.005F, grazing, elevation);
  require(root_visible(elevated), "real terrain height was ignored by frustum selection");
  const auto stable_elevated = mountains.update(0.005F, grazing, elevation);
  require(stable_elevated.priority_update_count == 0U, "unchanged elevation rebuilt priorities");
  const float fov = static_cast<float>(45.0 * 3.14159265358979323846 / 180.0);
  terra::frame::globe_camera camera(static_cast<float>(radius), 1740, 958, fov);
  require(camera.set_target_degrees(118.81039, 31.62401),
          "failed to set the regression camera");
  const float threshold = 1.25F / 958.0F * 2.0F * std::tan(fov * 0.5F);
  terra::frame::cylindrical_lod_controller model;
  model.configure(radius, 64U, 30U, 65536U);
  resources data;
  terra::frame::lod_update_budget budget;
  budget.maximum_elapsed_milliseconds = 0.0;
  budget.maximum_priority_update_count = 2U;
  budget.maximum_change_count = 1U;
  const auto partial = model.update_step(threshold, camera.snapshot(),
                                         data.state, budget);
  require(partial.complete && partial.patches.size() == 8U &&
              partial.priority_update_count == 2U &&
              partial.pending_priority_update_count == 6U &&
              partial.budget_exhausted && !partial.converged,
          "an incomplete priority scan did not retain root coverage");
  data.receive(partial);
  budget.maximum_priority_update_count = 17U;
  budget.maximum_change_count = 4U;
  settle(model, threshold, camera.snapshot(), data, budget);

  camera.set_distance(46237.5);
  const auto reference = terra::frame::select_procedural_cylindrical_lod(
      radius, 64U, threshold, camera.snapshot(), 30U, 65536U);
  const auto near = settle(model, threshold, camera.snapshot(), data, budget);
  require(visible_keys(near) == visible_keys(reference),
          "bounded dependency updates differ from the one-shot reference");
  const auto unchanged = model.update_step(threshold, camera.snapshot(),
                                           data.state, budget);
  require(unchanged.converged && unchanged.change_count == 0U &&
              unchanged.priority_update_count == 0U &&
              unchanged.pending_priority_update_count == 0U,
          "a settled view rebuilt priorities instead of retaining its queues");

  camera.set_distance(radius * 1.5);
  budget.maximum_priority_update_count = 3U;
  const auto moving = model.update_step(threshold, camera.snapshot(),
                                        data.state, budget);
  require(moving.budget_exhausted && !moving.converged &&
              visible_keys(moving) == visible_keys(near),
          "a new camera published a partially evaluated terrain cut");
  budget.maximum_priority_update_count = 17U;
  settle(model, threshold, camera.snapshot(), data, budget);
  camera.set_distance(46237.5);
  require(visible_keys(settle(model, threshold, camera.snapshot(), data, budget))
              == visible_keys(reference),
          "coarsening invalidated persistent candidates for a cached return");
  terra::frame::cylindrical_lod_controller bounded;
  bounded.configure(radius, 64U, 30U, 65536U);
  resources bounded_data;
  budget.maximum_node_count = 96U;
  const auto limited = settle(bounded, threshold, camera.snapshot(), bounded_data, budget);
  require(limited.limited_by_capacity && limited.feasible_threshold == threshold &&
              limited.node_count <= budget.maximum_node_count,
          "local admission lost the requested terrain precision or exceeded capacity");
  const auto parked = bounded.update_step(threshold, camera.snapshot(), bounded_data.state, budget);
  require(parked.converged && parked.limited_by_capacity && !parked.budget_exhausted &&
              parked.change_count == 0U && parked.priority_update_count == 0U &&
              visible_keys(parked) == visible_keys(limited) &&
              parked.record_requests.size() == limited.record_requests.size(),
          "an unchanged capacity limit lost its retained demand or quality state");
  const auto limited_visible = visible_keys(limited);
  budget.maximum_node_count = 65536U;
  const auto resumed = settle(bounded, threshold, camera.snapshot(), bounded_data, budget);
  require(!resumed.limited_by_capacity && visible_keys(resumed) == visible_keys(reference) &&
              visible_keys(resumed) != limited_visible,
          "capacity recovery did not resume the original refinement demand");
  budget.maximum_node_count = 96U;
  camera.set_distance(radius * 1.5);
  settle(bounded, threshold, camera.snapshot(), bounded_data, budget);
  camera.set_distance(46237.5);
  const auto returned = settle(bounded, threshold, camera.snapshot(), bounded_data, budget);
  require(returned.node_count <= budget.maximum_node_count &&
              returned.limited_by_capacity && returned.feasible_threshold == threshold,
          "a repeated interaction exceeded capacity or changed the feasible cut");
  terra::frame::cylindrical_lod_controller grazing_model;
  grazing_model.configure(radius, 64U, 30U, 65536U);
  resources grazing_data;
  require(camera.set_target_degrees(116.56230, 40.74863), "invalid reported target");
  camera.set_distance(6378.0);
  camera.set_tilt_radians(-76.3 * 3.14159265358979323846 / 180.0);
  camera.rotate_yaw_radians(14.5 * 3.14159265358979323846 / 180.0);
  budget.maximum_visible_mesh_bytes = 64U * 42900U;
  budget.maximum_node_count = 1024U;
  const auto reported = settle(grazing_model, threshold, camera.snapshot(), grazing_data, budget);
  require(reported.complete && reported.feasible_threshold == threshold && reported.node_count > 8U,
          "a camera inside conservative bounds stopped data-ready local refinement");

  // Reclaim a settled graph without moving the camera. The previous round's
  // protected dependency splits must become eligible when capacity changes.
  // Repeating shrink/grow at tiny work budgets exercises shared child fragments
  // and interrupted priority scans; validate against the returned cut, not the
  // scheduler's private accounting.
  terra::frame::cylindrical_lod_controller resizing;
  resizing.configure(radius, 64U, 30U, 65536U);
  resources resizing_data;
  for (std::size_t round = 0; round < 6U; ++round) {
    budget.maximum_priority_update_count = 3U;
    budget.maximum_change_count = 1U;
    budget.maximum_node_count = round % 2U ? 96U : 1024U;
    budget.maximum_visible_mesh_bytes = (round % 2U ? 40U : 128U) * 42900U;
    budget.maximum_split_count = round % 2U ? 24U : 256U;
    const auto cut = settle(resizing, threshold, camera.snapshot(), resizing_data, budget);
    require(visible_payload_bytes(cut) <= budget.maximum_visible_mesh_bytes,
            "repeated capacity change lost unique mesh accounting");
    require(cut.node_count - cut.patches.size() <= budget.maximum_split_count &&
                cut.node_count <= budget.maximum_node_count,
            "same-view capacity reclamation stalled or lost split accounting");
    if (round % 2U == 0U) require(cut.node_count > 96U,
        "restored capacity did not resume the retained fine demand");
  }

  // A full cache must exchange low-value closures for current demand. An
  // oblique visit used to leave a 9.56px fragment at a view that a cold model
  // covered to 2.55px with the old 196-fragment budget. Keep its byte limit
  // while charging shared UV once. Under pressure, different dependency
  // exchange histories may still produce different valid cuts.
  const double pi = 3.14159265358979323846;
  const float exchange_threshold = static_cast<float>(1.25 / 879.0 * 2.0 * std::tan(pi / 8.0));
  struct viewpoint { double longitude, latitude, distance, tilt; };
  const viewpoint destination{116.5623, 40.74863, radius * 1.5, 0.0};
  const viewpoint approaches[] = {{116.5623, 40.74863, 12000.0, 30.0},
      {2.35, 48.86, 95670.0, 45.0}, {116.5623, 40.74863, 9567.0, 76.3},
      {-120.0, 0.0, radius * 1.5, 0.0}};
  for (std::size_t limit : {64U, 196U}) {
    terra::frame::globe_camera exchange_camera(radius, 1280, 879, pi / 4.0);
    const auto move = [&](const viewpoint& value) {
      require(exchange_camera.set_target_degrees(value.longitude, value.latitude), "invalid exchange target");
      exchange_camera.set_distance(value.distance);
      exchange_camera.set_tilt_radians(-value.tilt * pi / 180.0);
    };
    terra::frame::lod_update_budget exchange_budget;
    exchange_budget.maximum_elapsed_milliseconds = 0.0;
    exchange_budget.maximum_change_count = 16U;
    exchange_budget.maximum_node_count = 1819U;
    exchange_budget.maximum_visible_mesh_bytes = limit * 42900U;
    exchange_budget.maximum_split_count = 976U;
    terra::frame::cylindrical_lod_controller fresh;
    fresh.configure(radius, 64U, 30U, 65536U);
    resources fresh_data;
    move(destination);
    const auto reference_cut = settle(fresh, exchange_threshold, exchange_camera.snapshot(), fresh_data, exchange_budget);
    for (const auto& approach : approaches) {
      terra::frame::cylindrical_lod_controller moving_model;
      moving_model.configure(radius, 64U, 30U, 65536U);
      resources moving_data;
      for (std::size_t round = 0U; round < 3U; ++round) {
        // A one-change step can stop between coarsening and the requesting
        // split. Its victim must not immediately consume the same room again.
        exchange_budget.maximum_change_count = round == 1U ? 1U : 16U;
        exchange_budget.maximum_priority_update_count = round == 1U ? 3U : 256U;
        move(approach);
        settle(moving_model, exchange_threshold, exchange_camera.snapshot(), moving_data, exchange_budget);
        move(destination);
        const auto arrived = settle(moving_model, exchange_threshold, exchange_camera.snapshot(), moving_data, exchange_budget);
        require(arrived.complete && visible_payload_bytes(arrived) <= exchange_budget.maximum_visible_mesh_bytes &&
                    arrived.feasible_threshold == exchange_threshold,
                "capacity exchange lost coverage, exceeded its budget or changed requested error");
        require(maximum_visible_error(arrived) <= maximum_visible_error(reference_cut) * 1.2F,
                "interaction history stranded high-error terrain behind lower-value detail");
        for (std::size_t idle = 0U; idle < 10U; ++idle) {
          const auto parked = moving_model.update_step(exchange_threshold, exchange_camera.snapshot(), moving_data.state, exchange_budget);
          require(parked.converged && parked.change_count == 0U && !parked.budget_exhausted,
                  "capacity exchange oscillated after a limited cut became stable");
        }
      }
    }
    // Delayed and failed records must preserve the display cut. Clearing the
    // failure and delivering data must wake the same camera without increasing
    // its capacity or resetting the persistent model.
    terra::frame::cylindrical_lod_controller interrupted;
    interrupted.configure(radius, 64U, 30U, 65536U);
    resources interrupted_data;
    move(destination);
    settle(interrupted, exchange_threshold, exchange_camera.snapshot(), interrupted_data, exchange_budget);
    move(approaches[2U]);
    exchange_budget.maximum_change_count = 1U;
    exchange_budget.maximum_priority_update_count = 3U;
    for (std::size_t step = 0U; step < 200U; ++step) {
      const auto pending = interrupted.update_step(exchange_threshold, exchange_camera.snapshot(), interrupted_data.state, exchange_budget);
      require(pending.complete && pending.change_count <= 1U && pending.priority_update_count <= 3U,
              "delayed records lost coverage or escaped the work budget");
      if (step % 11U == 0U) interrupted_data.receive(pending);
    }
    const auto failed = settle(interrupted, exchange_threshold, exchange_camera.snapshot(), interrupted_data, exchange_budget, true);
    require(!interrupted_data.failed.empty() && failed.complete,
            "failure fixture did not interrupt the fine demand");
    const auto details_before_recovery = interrupted_data.details.size();
    interrupted_data.failed.clear();
    interrupted_data.state.unavailable_details.clear();
    ++interrupted_data.state.revision;
    const auto recovered = settle(interrupted, exchange_threshold, exchange_camera.snapshot(), interrupted_data, exchange_budget);
    require(recovered.complete && interrupted_data.details.size() > details_before_recovery,
            "data recovery left dependency protection parked at the same view");
    move(destination);
    const auto returned = settle(interrupted, exchange_threshold, exchange_camera.snapshot(), interrupted_data, exchange_budget);
    require(maximum_visible_error(returned) <= maximum_visible_error(reference_cut) * 1.2F,
            "failed data permanently stranded terrain capacity after recovery");
  }
  // Previously refined detail must not consume capacity needed by another
  // visible region that exceeds the target error.
  // Both endpoints fit cold at the same budget; no cache reset or budget growth
  // is permitted when returning from the finer view.
  const float return_threshold = static_cast<float>(1.25 / 519.0 * 2.0 * std::tan(0.5233333333333334 / 2.0));
  // A parent that satisfies the configured error must eventually replace its
  // unnecessary children after a zoom out. This uses ample capacity and no
  // terrain heights: resource pressure and data-dependent bounds cannot explain
  // a history-dependent surplus in this fixed-view production selection.
  for (const double distance : {7406.448180236075, 7584202.936561741}) {
    terra::frame::globe_camera target_camera(radius, 960, 519, 0.5233333333333334);
    require(target_camera.set_target_degrees(116.5623, 40.74863), "invalid normalization target");
    terra::frame::lod_update_budget target_budget;
    target_budget.maximum_elapsed_milliseconds = 0.0;
    terra::frame::cylindrical_lod_controller cold_model, warm_model;
    cold_model.configure(radius, 64U, 40U, 65536U);
    warm_model.configure(radius, 64U, 40U, 65536U);
    resources cold_data, warm_data;
    target_camera.set_distance(distance);
    const auto reference = settle(cold_model, return_threshold, target_camera.snapshot(), cold_data, target_budget);
    for (std::size_t round = 0U; round < 2U; ++round) {
      target_camera.set_distance(distance / 2.0);
      settle(warm_model, return_threshold, target_camera.snapshot(), warm_data, target_budget);
      target_camera.set_distance(distance);
      target_budget.maximum_change_count = round ? 1U : 32U;
      target_budget.maximum_priority_update_count = round ? 3U : 256U;
      const auto returned = settle(warm_model, return_threshold, target_camera.snapshot(), warm_data, target_budget);
      require(maximum_visible_error(returned) <= return_threshold,
              "fixed-error coarsening lost target precision");
      require(visible_keys(returned) == visible_keys(reference),
              "zoom-out retained optional terrain despite a target-compliant parent");
      for (std::size_t idle = 0U; idle < 10U; ++idle) {
        const auto parked = warm_model.update_step(return_threshold, target_camera.snapshot(), warm_data.state, target_budget);
        require(parked.converged && parked.change_count == 0U && !parked.budget_exhausted,
                "fixed-error selection oscillated at a stationary camera");
      }
    }
  }
  for (const double distance : {925.8060225295094, 15168405.873123482}) {
    terra::frame::globe_camera return_camera(radius, 960, 519, 0.5233333333333334);
    require(return_camera.set_target_degrees(116.5623, 40.74863), "invalid return target");
    return_camera.set_tilt_radians(0.0);
    terra::frame::lod_update_budget return_budget;
    return_budget.maximum_elapsed_milliseconds = 0.0;
    return_budget.maximum_visible_mesh_bytes = 8U * 1024U * 1024U;
    return_budget.maximum_node_count = 1819U;
    return_budget.maximum_split_count = 976U;
    terra::frame::cylindrical_lod_controller cold_model, warm_model;
    cold_model.configure(radius, 64U, 40U, 65536U);
    warm_model.configure(radius, 64U, 40U, 65536U);
    resources cold_data, warm_data;
    return_camera.set_distance(distance);
    const auto cold_cut = settle(cold_model, return_threshold, return_camera.snapshot(), cold_data, return_budget);
    require(!cold_cut.limited_by_capacity && maximum_visible_error(cold_cut) <= return_threshold,
            "return reference does not fit its fixed capacity");
    for (std::size_t round = 0U; round < 3U; ++round) {
      return_budget.maximum_change_count = round == 1U ? 1U : 32U;
      return_budget.maximum_priority_update_count = round == 1U ? 3U : 256U;
      return_camera.set_distance(distance / 2.0);
      settle(warm_model, return_threshold, return_camera.snapshot(), warm_data, return_budget);
      return_camera.set_distance(distance);
      const auto warm_cut = settle(warm_model, return_threshold, return_camera.snapshot(), warm_data, return_budget);
      require(!warm_cut.limited_by_capacity && maximum_visible_error(warm_cut) <= return_threshold &&
                  visible_payload_bytes(warm_cut) <= return_budget.maximum_visible_mesh_bytes,
              "retained detail stranded an affordable precision target");
      for (std::size_t idle = 0U; idle < 10U; ++idle) {
        const auto parked = warm_model.update_step(return_threshold, return_camera.snapshot(), warm_data.state, return_budget);
        require(parked.converged && parked.change_count == 0U && !parked.budget_exhausted,
                "target-preserving capacity reclamation oscillated");
      }
    }
  }
  return 0;
}
