#include "support/terrain_replay.hpp"
#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/mesh.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>

// A fresh core controller per pose, real codec/hierarchy data, no production
// mesh/cache/transition quotas. This measures terrain demand, not GPU latency
// or an independent proof that the CBDAM selection algorithm is correct.
namespace {
using namespace terra_benchmark;

struct surface_capture {
  std::ofstream file;
  std::size_t bytes = 0U;
  std::map<std::vector<float>, std::size_t> uv_offsets;
  std::ostringstream members;
  std::size_t count = 0U, index_offset = 0U, index_count = 0U;
  explicit surface_capture(const std::string& path, std::uint32_t dimension) {
    if (path.empty()) return;
    const std::uint32_t endian = 1U;
    require(*reinterpret_cast<const unsigned char*>(&endian) == 1U,
            "surface capture requires little-endian storage");
    file.open(path, std::ios::binary);
    require(bool(file), "cannot create surface capture");
    std::vector<std::uint16_t> indices;
    require(terra::frame::make_triangular_patch_strip_indices(dimension, indices) ==
        terra::frame::mesh_index_status::ok, "cannot capture patch indices");
    index_offset = write(indices); index_count = indices.size();
    members << std::setprecision(17);
  }
  template<class T> std::size_t write(const std::vector<T>& values) {
    const std::size_t padding = (4U - bytes % 4U) % 4U;
    const char zero[4] = {};
    file.write(zero, padding); bytes += padding;
    const auto offset = bytes;
    bytes += values.size() * sizeof(T);
    require(bytes <= 128U * 1024U * 1024U, "surface capture safety size exceeded");
    file.write(reinterpret_cast<const char*>(values.data()), values.size() * sizeof(T));
    require(bool(file), "cannot write surface capture");
    return offset;
  }
  void append(const terra::frame::patch_surface_mesh& mesh) {
    if (!file.is_open()) return;
    const auto positions = write(mesh.positions_xyz);
    auto found = uv_offsets.find(mesh.texture_uv);
    if (found == uv_offsets.end())
      found = uv_offsets.emplace(mesh.texture_uv, write(mesh.texture_uv)).first;
    if (count++) members << ',';
    const auto& patch = mesh.patch;
    members << "{\"key\":[" << patch.level;
    for (const auto v : patch.id) members << ',' << v;
    members << "],\"fragment\":" << unsigned(mesh.fragment) << ",\"origin\":["
        << mesh.origin[0] << ',' << mesh.origin[1] << ',' << mesh.origin[2]
        << "],\"textureNode\":{\"level\":" << mesh.texture_node.level
        << ",\"root\":" << mesh.texture_node.root(true) << ",\"row\":" << mesh.texture_node.row
        << ",\"column\":" << mesh.texture_node.column << "},\"positions\":" << positions
        << ",\"uv\":" << found->second << ",\"vertices\":" << mesh.positions_xyz.size() / 3U << '}';
  }
  void print(const terra::frame::camera_snapshot& camera) {
    if (!file.is_open()) return;
    file.close(); require(bool(file), "cannot finish surface capture");
    std::cout << ",\"surfaceSnapshot\":{\"schema\":\"terra.reference-surfaces.v1\",\"bytes\":" << bytes
        << ",\"indices\":{\"offset\":" << index_offset << ",\"count\":" << index_count
        << "},\"projectionView\":[";
    for (std::size_t i = 0U; i < camera.projection_view.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << camera.projection_view[i];
    }
    std::cout << "],\"meshes\":[" << members.str() << "]}";
  }
};

void result(const terra::frame::lod_cut& cut, const data_source& data, double radius,
            float threshold, std::size_t steps, double lod_ms, double maximum_step_ms,
            double data_ms, double wall_ms, const terra::frame::camera_snapshot& camera,
            const std::string& surface_path) {
  surface_capture capture(surface_path, data.dimension);
  std::set<std::pair<key, unsigned>> meshes;
  std::set<std::vector<float>> uv;
  std::size_t position_bytes = 0U, uv_bytes = 0U, visible = 0U, level_limited = 0U;
  float error = 0.0F;
  const auto append = [&](const lod_patch& patch, bool visible_surface) {
    const auto& height = data.heights.at(identity(patch)).samples;
    for (unsigned f = 0U; f < 2U; ++f) {
      if (!patch.has_fragment(f) || !meshes.emplace(identity(patch), f).second) continue;
      require(height.has_fragment(f), "reference cut has missing height coverage");
      terra::frame::patch_surface_mesh mesh;
      require(terra::frame::make_cylindrical_patch_surface(patch, static_cast<std::uint8_t>(f),
          height.fragments[f], data.scale, radius, mesh) == terra::frame::surface_mesh_status::ok,
          "cannot materialize reference surface");
      position_bytes += mesh.positions_xyz.size() * sizeof(float);
      if (uv.insert(mesh.texture_uv).second) uv_bytes += mesh.texture_uv.size() * sizeof(float);
      if (visible_surface) capture.append(mesh);
    }
  };
  for (const auto& patch : cut.patches) if (patch.visible) {
    append(patch, true); error = std::max(error, patch.priority);
    if (patch.level >= 40U) ++level_limited;
  }
  visible = meshes.size();
  for (const auto& request : cut.record_requests)
    if (request.kind == terra::frame::lod_record_kind::root) append(request.patch, false);
  // The current core suppresses priority at its maximum level. Such leaves
  // have no measured error proof; never report their zero priority as success.
  const bool met = !level_limited && !cut.limited_by_capacity && std::isfinite(error) && error <= threshold * 1.001F;
  std::cout << "{\"type\":\"result\",\"targetMet\":" << (met ? "true" : "false")
      << ",\"limitedBySafetyNodes\":" << (cut.limited_by_capacity ? "true" : "false")
      << ",\"unverifiedMaximumLevelLeaves\":" << level_limited
      << ",\"nodes\":" << cut.node_count << ",\"visibleMeshes\":" << visible
      << ",\"meshesWithRoots\":" << meshes.size() << ",\"positionBytes\":" << position_bytes
      << ",\"uniqueUvBytes\":" << uv_bytes << ",\"meshBytesWithRoots\":" << position_bytes + uv_bytes
      << ",\"decodedRecordBytes\":" << data.decoded_bytes << ",\"retainedHeightBytes\":" << data.height_bytes
      << ",\"directNoDataRecords\":" << data.absent.size() << ",\"inheritedNoDataRecords\":" << data.inherited_absent.size()
      << ",\"recordRequests\":" << data.requested << ",\"threshold\":" << threshold << ",\"achievedError\":";
  if (std::isfinite(error)) std::cout << error; else std::cout << "null";
  std::cout << ",\"steps\":" << steps << ",\"lodMs\":" << lod_ms << ",\"maximumLodStepMs\":" << maximum_step_ms
      << ",\"dataAndIOMs\":" << data_ms << ",\"solveWallMs\":" << wall_ms << ",\"visibleKeys\":[";
  bool first = true;
  for (const auto& patch : cut.patches) if (patch.visible) {
    if (!first) std::cout << ',';
    first = false; write_key(identity(patch));
  }
  std::cout << ']';
  capture.print(camera);
  std::cout << '}' << std::endl;
}
}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 14 || argc == 15, "expected radius dimension height-scale width height fov longitude latitude target-height range lod-threshold heading-degrees tilt-degrees [surface-file]");
    const double radius = std::stod(argv[1]), scale = std::stod(argv[3]);
    const auto dimension = static_cast<std::uint32_t>(std::stoul(argv[2]));
    const int width = std::stoi(argv[4]), height = std::stoi(argv[5]);
    const float fov = std::stof(argv[6]);
    const double range = std::stod(argv[10]);
    const float threshold = std::stof(argv[11]);
    const double heading = std::stod(argv[12]), tilt = std::stod(argv[13]);
    require(dimension > 0U && dimension <= 256U && scale > 0.0 && width > 0 && height > 0 &&
        radius > 0.0 && range > 0.0 && std::isfinite(range) &&
        threshold > 0.0F && std::isfinite(threshold) && std::isfinite(heading) &&
        std::isfinite(tilt) && tilt >= 0.0 && tilt < 90.0, "invalid reference configuration");
    terra::frame::globe_camera camera(static_cast<float>(radius), width, height, fov);
    require(camera.is_valid() && camera.set_target_degrees(std::stod(argv[7]), std::stod(argv[8])) &&
        camera.set_target_height(std::stod(argv[9])), "invalid reference camera");
    camera.set_distance(range);
    // Public orbit tilt is positive towards the horizon; native camera pitch
    // uses the opposite sign (TerraGlobeRuntime::assignView).
    camera.set_tilt_radians(-tilt * std::acos(-1.0) / 180.0);
    camera.rotate_yaw_radians(heading * std::acos(-1.0) / 180.0);
    const auto snapshot = camera.snapshot();
    require(std::abs(camera.distance() - range) <= range * 1e-8, "reference camera range constrained");
    terra::frame::cylindrical_lod_controller model;
    model.configure(radius, dimension, 40U, 65536U);
    terra::frame::lod_update_budget budget;
    budget.maximum_change_count = 32U; budget.maximum_priority_update_count = 256U;
    budget.maximum_elapsed_milliseconds = 0.0;
    data_source data; data.dimension = dimension; data.scale = scale;
    double lod_ms = 0.0, maximum_step_ms = 0.0, data_ms = 0.0;
    const auto started = clock_type::now();
    for (std::size_t step = 1U; step <= 20000U; ++step) {
      auto at = clock_type::now();
      const auto cut = model.update_step(threshold, snapshot, data.state, budget);
      const double duration = elapsed(at); lod_ms += duration; maximum_step_ms = std::max(maximum_step_ms, duration);
      require(cut.complete, "reference topology safety limit reached");
      at = clock_type::now(); const bool changed = data.receive(cut); data_ms += elapsed(at);
      if (cut.converged && !changed) {
        std::cout << std::setprecision(17);
        result(cut, data, radius, threshold, step, lod_ms, maximum_step_ms, data_ms, elapsed(started),
               snapshot, argc == 15 ? argv[14] : "");
        return 0;
      }
    }
    throw std::runtime_error("reference iteration safety limit reached");
  } catch (const std::exception& error) {
    std::cerr << "Terrain reference failed: " << error.what() << '\n'; return 1;
  }
}
