#include "../support/terrain_replay.hpp"
#include "imagery.hpp"

#include <vic/cbdam/base/grid_diamond_graph_incore.hpp>
#include <vic/cbdam/base/diamond_patch_accessor.hpp>
#include <terra/frame/height_session.hpp>

#include <ctime>
#include <functional>
#include <memory>

// Persistent, headless terrain cores. This is the terrain part of the layered
// scheduling benchmark, not an imagery/renderer or production memory gate.
namespace {
using namespace terra_benchmark;

double cpu_ms() { return 1000.0 * std::clock() / CLOCKS_PER_SEC; }

struct configuration {
  double radius, scale, fov, pixels;
  std::uint32_t dimension;
  int width, height;
  float threshold;
  std::size_t mesh_limit = 0U;
  bool imagery = false;
};

imagery_configuration imagery_config(const configuration& c) {
  imagery_configuration result;
  result.surface.dimension=c.dimension; result.surface.height_scale=c.scale;
  result.surface.radius=c.radius; result.surface.cylindrical=true;
  result.surface.bounds={{{-180.0,-90.0}},{{180.0,90.0}}};
  result.width=c.width; result.height=c.height; result.pixels=c.pixels;
  return result;
}

struct pose {
  std::string id;
  double longitude, latitude, height, range, heading, tilt;
};

terra::frame::camera_snapshot camera_at(const configuration& c, const pose& p) {
  require(std::isfinite(p.longitude) && std::isfinite(p.latitude) &&
      std::isfinite(p.height) && std::isfinite(p.range) && std::isfinite(p.heading) &&
      std::isfinite(p.tilt) && std::abs(p.longitude) <= 180.0 &&
      std::abs(p.latitude) <= 90.0 && p.range > 0.0 && p.tilt >= 0.0 && p.tilt < 90.0,
      "invalid pose");
  terra::frame::globe_camera camera(static_cast<float>(c.radius), c.width, c.height,
                                  static_cast<float>(c.fov));
  require(camera.is_valid() && camera.set_target_degrees(p.longitude, p.latitude) &&
      camera.set_target_height(p.height), "invalid camera target");
  camera.set_distance(p.range);
  camera.set_tilt_radians(-p.tilt * std::acos(-1.0) / 180.0);
  camera.rotate_yaw_radians(p.heading * std::acos(-1.0) / 180.0);
  require(std::abs(camera.distance() - p.range) <= p.range * 1e-8,
          "camera range was constrained");
  return camera.snapshot();
}

std::string fragment_key(std::size_t level, const terra::core::grid_point& id,
                         std::size_t fragment) {
  std::ostringstream out;
  out << level;
  for (const auto coordinate : id) out << '/' << coordinate;
  out << '/' << fragment;
  return out.str();
}

struct observation {
  std::vector<std::string> all, visible;
  std::vector<std::string> coarsen_candidates;
  std::size_t nodes = 0U, pending_refines = 0U, pending_coarsens = 0U;
  std::size_t active_height_bytes = 0U, cached_geometry_bytes = 0U;
  std::size_t decoded_record_bytes = 0U, cache_entries = 0U;
  double error = 0.0;
  double minimum_height = std::numeric_limits<double>::infinity();
  double maximum_height = -std::numeric_limits<double>::infinity();
  std::size_t in_frustum_vertices = 0U;
  bool cached_update_return = false;
  std::string resource_input;
  std::string terrain_observation;
  std::string imagery;
  std::vector<std::string> missing_inputs;
  std::vector<lod_patch> visible_patches;
  std::size_t unverified_level_leaves = 0U;
  bool capacity_limited = false;
};

struct measurement {
  double cpu = 0.0, data_cpu = 0.0, maximum_call_cpu = 0.0, maximum_call_wall = 0.0;
  std::size_t steps = 0U, changes = 0U, priorities = 0U;
  std::size_t cached_update_returns = 0U;
  std::size_t completion_coarsens = 0U, completion_calls = 0U;
  double completion_cpu = 0.0;
  double consumer_cpu = 0.0;
  std::size_t logical_publications = 0U;
  bool priorities_observed = false;
};

void inspect_vertex(observation& result, const terra::frame::camera_snapshot& camera,
                    const terra::core::vector3d& position, double height) {
  std::array<double,4> clip{{}};
  for (std::size_t row = 0U; row < 4U; ++row) {
    clip[row] = camera.projection_view[4U * row + 3U];
    for (std::size_t axis = 0U; axis < 3U; ++axis)
      clip[row] += camera.projection_view[4U * row + axis] * position[axis];
  }
  if (clip[3] <= 0.0) return;
  for (std::size_t axis = 0U; axis < 3U; ++axis)
    if (clip[axis] < -clip[3] || clip[axis] > clip[3]) return;
  ++result.in_frustum_vertices;
  result.minimum_height = std::min(result.minimum_height, height);
  result.maximum_height = std::max(result.maximum_height, height);
}

void write_array(const std::vector<std::string>& values) {
  std::cout << '[';
  for (std::size_t i = 0U; i < values.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << std::quoted(values[i]);
  }
  std::cout << ']';
}

void write_mesh_payload(const observation& cut, std::uint32_t dimension) {
  std::set<std::pair<key,std::size_t>> meshes;
  std::set<std::uint32_t> patterns;
  const auto append = [&](const lod_patch& patch) {
    for (std::size_t f = 0U; f < 2U; ++f) if (patch.has_fragment(f) &&
        meshes.emplace(identity(patch),f).second) {
      terra::frame::texture_grid_pattern pattern;
      require(terra::frame::describe_cylindrical_texture_pattern(patch, static_cast<std::uint8_t>(f),
          dimension, pattern), "uncertified UV layout in mesh capacity measurement");
      patterns.insert(pattern.orientation);
    }
  };
  for (const auto& patch : cut.visible_patches) append(patch);
  for (const auto& root : terra::core::cylindrical_roots()) {
    lod_patch patch; patch.id = root.id(); patch.fragment_mask = 3U;
    for (std::size_t i = 0U; i < 4U; ++i) patch.corners[i] = root.corner(i);
    append(patch);
  }
  const std::size_t vertices = (dimension + 1U) * (dimension + 2U) / 2U;
  const std::size_t positions = meshes.size() * vertices * 3U * sizeof(float);
  const std::size_t uv = patterns.size() * vertices * 2U * sizeof(float);
  std::vector<std::uint16_t> strip;
  require(terra::frame::make_triangular_patch_strip_indices(dimension,strip) ==
      terra::frame::mesh_index_status::ok, "cannot measure the shared index strip");
  std::cout << ",\"meshPayload\":{\"fragmentsWithRoots\":" << meshes.size()
      << ",\"positionBytes\":" << positions << ",\"uniqueUvBytes\":" << uv
      << ",\"selectionBytes\":" << positions + uv
      << ",\"sharedIndexBytes\":" << strip.size() * sizeof(std::uint16_t) << '}';
}

void write_result(const char* backend, const pose& p, const configuration& c,
                  const terra::frame::camera_snapshot& camera,
                  const observation& cut, const measurement& m, double wall_ms,
                  const char* status, const char* type = "result") {
  std::cout << "{\"type\":\"" << type << "\",\"backend\":\"" << backend
      << "\",\"id\":" << std::quoted(p.id) << ",\"status\":\"" << status
      << "\",\"threshold\":" << c.threshold << ",\"achievedError\":" << cut.error
      << ",\"targetMet\":" << (!cut.capacity_limited && cut.unverified_level_leaves == 0U && cut.error <= c.threshold * 1.001 ? "true" : "false")
      << ",\"limitedByCapacity\":" << (cut.capacity_limited ? "true" : "false")
      << ",\"unverifiedMaximumLevelLeaves\":" << cut.unverified_level_leaves
      << ",\"nodes\":" << cut.nodes << ",\"pendingRefines\":" << cut.pending_refines
      << ",\"pendingCoarsens\":" << cut.pending_coarsens
      << ",\"steps\":" << m.steps << ",\"topologyChanges\":" << m.changes
      << ",\"priorityUpdates\":";
  if (m.priorities_observed) std::cout << m.priorities;
  else std::cout << "null";
  std::cout << ",\"coreCpuMs\":" << m.cpu
      << ",\"dataCpuMs\":" << m.data_cpu << ",\"wallMs\":" << wall_ms
      << ",\"maximumCallCpuMs\":" << m.maximum_call_cpu
      << ",\"maximumCallWallMs\":" << m.maximum_call_wall
      << ",\"activeHeightBytes\":" << cut.active_height_bytes
      << ",\"cachedGeometryBytes\":" << cut.cached_geometry_bytes
      << ",\"decodedRecordBytes\":" << cut.decoded_record_bytes
      << ",\"geometryCacheEntries\":" << cut.cache_entries
      << ",\"cachedUpdateReturns\":" << m.cached_update_returns
      << ",\"completionCoarsens\":" << m.completion_coarsens
      << ",\"completionCalls\":" << m.completion_calls
      << ",\"completionCpuMs\":" << m.completion_cpu
      << ",\"logicalConsumerCpuMs\":" << m.consumer_cpu
      << ",\"logicalPublications\":" << m.logical_publications
      << ",\"cachedUpdateReturnEligible\":" << (cut.cached_update_return ? "true" : "false")
      << ",\"pendingCoarsenKeys\":";
  write_array(cut.coarsen_candidates);
  std::cout << ",\"missingInputKeys\":"; write_array(cut.missing_inputs);
  std::cout << ",\"resourceInput\":" << (cut.resource_input.empty() ? "null" : cut.resource_input);
  std::cout << ",\"terrainObservation\":" << (cut.terrain_observation.empty() ? "null" : cut.terrain_observation);
  std::cout << ",\"imagery\":" << (cut.imagery.empty() ? "null" : cut.imagery);
  if (!cut.visible_patches.empty()) write_mesh_payload(cut,c.dimension);
  std::cout << ",\"terrainRelief\":{\"inFrustumVertices\":" << cut.in_frustum_vertices
      << ",\"minimumMeters\":";
  if (cut.in_frustum_vertices) std::cout << cut.minimum_height;
  else std::cout << "null";
  std::cout << ",\"maximumMeters\":";
  if (cut.in_frustum_vertices) std::cout << cut.maximum_height;
  else std::cout << "null";
  std::cout << '}'
      << ",\"position\":[" << camera.position[0] << ',' << camera.position[1] << ',' << camera.position[2]
      << "],\"projection\":[";
  for (std::size_t i = 0U; i < 16U; ++i) {
    if (i) std::cout << ',';
    std::cout << camera.projection[i];
  }
  std::cout << "],\"view\":[";
  for (std::size_t i = 0U; i < 16U; ++i) {
    if (i) std::cout << ',';
    std::cout << camera.view[i];
  }
  std::cout << "],\"allKeys\":"; write_array(cut.all);
  std::cout << ",\"visibleKeys\":"; write_array(cut.visible);
  std::cout << '}' << std::endl;
}

observation observe_sdk(const terra::frame::lod_cut& cut, const data_source& data,
                         const terra::frame::camera_snapshot* camera = nullptr, double radius = 0.0) {
  observation result;
  result.nodes = cut.node_count;
  result.capacity_limited = cut.limited_by_capacity;
  result.decoded_record_bytes = data.decoded_bytes;
  if (camera) {
    std::ostringstream input;
    input << std::setprecision(17) << "{\"availableRoots\":[";
    const auto keys = [&](const std::vector<terra::frame::lod_detail_key>& values) {
      for (std::size_t i = 0U; i < values.size(); ++i) {
        if (i) input << ',';
        input << '[' << values[i].level;
        for (auto coordinate : values[i].id) input << ',' << coordinate;
        input << ']';
      }
    };
    keys(data.state.available_roots);
    input << "],\"availableDetails\":["; keys(data.state.available_details);
    input << "],\"heightRanges\":[";
    for (std::size_t i = 0U; i < data.state.height_ranges.size(); ++i) {
      if (i) input << ',';
      const auto& value = data.state.height_ranges[i];
      input << '[' << value.key.level;
      for (auto coordinate : value.key.id) input << ',' << coordinate;
      input << ',' << value.minimum << ',' << value.maximum << ']';
    }
    input << "]}";
    result.resource_input = input.str();
  }
  for (const auto& patch : cut.patches) {
    if (patch.visible) {
      result.error = std::max(result.error, double(patch.priority));
      result.visible_patches.push_back(patch);
      if (patch.level >= 40U) ++result.unverified_level_leaves;
    }
    const auto found = data.heights.find(identity(patch));
    require(found != data.heights.end(), "selected height is unavailable");
    for (std::size_t f = 0U; f < 2U; ++f) if (patch.has_fragment(f)) {
      const auto value = fragment_key(patch.level, patch.id, f);
      result.all.push_back(value);
      if (patch.visible) result.visible.push_back(value);
      result.active_height_bytes += found->second.samples.fragments[f].values.size() * sizeof(std::int32_t);
      if (camera && patch.visible) {
        terra::frame::patch_surface_mesh mesh;
        const auto& samples = found->second.samples.fragments[f];
        require(terra::frame::make_cylindrical_patch_surface(patch, static_cast<std::uint8_t>(f), samples,
            data.scale, radius, mesh) == terra::frame::surface_mesh_status::ok,
            "unable to inspect SDK relief");
        for (std::size_t i = 0U; i < samples.values.size(); ++i) {
          terra::core::vector3d position;
          for (std::size_t axis = 0U; axis < 3U; ++axis)
            position[axis] = mesh.origin[axis] + mesh.positions_xyz[3U * i + axis];
          inspect_vertex(result, *camera, position, samples.values[i] * data.scale);
        }
      }
    }
  }
  std::sort(result.all.begin(), result.all.end());
  std::sort(result.visible.begin(), result.visible.end());
  return result;
}

class sdk_driver {
  configuration config_;
  terra::frame::cylindrical_lod_controller model_;
  data_source data_;
  terra::frame::lod_resource_state frozen_resources_;
  bool frozen_ = false;
  std::unique_ptr<imagery_driver> imagery_;
 public:
  explicit sdk_driver(const configuration& c) : config_(c) {
    model_.configure(c.radius, c.dimension, 40U, 65536U);
    data_.dimension = c.dimension; data_.scale = c.scale;
  }
  void freeze() {
    require(!frozen_ && data_.state.available_roots.size() == 8U, "cannot freeze an incomplete discovery phase");
    frozen_resources_ = data_.state;
    frozen_ = true;
    model_.clear();
    model_.configure(config_.radius, config_.dimension, 40U, 65536U);
    if (config_.imagery) imagery_.reset(new imagery_driver(imagery_config(config_)));
    std::cout << "{\"type\":\"frozen\",\"heightRanges\":" << frozen_resources_.height_ranges.size()
        << ",\"details\":" << frozen_resources_.available_details.size() << '}' << std::endl;
  }
  bool run(const pose& p) {
    const auto camera = camera_at(config_, p);
    terra::frame::lod_update_budget budget;
    budget.maximum_elapsed_milliseconds = 0.0;
    budget.maximum_visible_mesh_bytes = frozen_ ? config_.mesh_limit : 0U;
    measurement m;
    m.priorities_observed = true;
    const auto start = clock_type::now();
    const auto transport_before = data_.transport_ms;
    unsigned stable = 0U;
    std::vector<std::string> previous;
    for (std::size_t step = 1U; step <= 20000U; ++step) {
      const auto wall_start = clock_type::now();
      const auto cpu_start = cpu_ms();
      const auto cut = model_.update_step(config_.threshold, camera, frozen_ ? frozen_resources_ : data_.state, budget);
      const double duration = cpu_ms() - cpu_start;
      m.cpu += duration; m.maximum_call_cpu = std::max(m.maximum_call_cpu, duration);
      m.maximum_call_wall = std::max(m.maximum_call_wall, elapsed(wall_start));
      require(cut.complete, "SDK topology safety limit reached");
      const auto data_start = cpu_ms();
      const bool changed = frozen_ ? false : data_.receive(cut);
      m.data_cpu += cpu_ms() - data_start;
      m.steps = step; m.changes += cut.change_count; m.priorities += cut.priority_update_count;
      if (cut.limited_by_capacity && !cut.budget_exhausted && cut.pending_priority_update_count == 0U) {
        const auto current = observe_sdk(cut,data_,&camera,config_.radius);
        write_result("sdk-native",p,config_,camera,current,m,elapsed(start),"capacity-limited");
        return false;
      }
      if (cut.converged && !changed) {
        const auto current = observe_sdk(cut, data_);
        if (current.unverified_level_leaves) {
          write_result("sdk-native",p,config_,camera,current,m,elapsed(start),"safety-level-limited");
          return false;
        }
        stable = current.all == previous ? stable + 1U : 0U;
        previous = current.all;
        if (stable >= 2U) {
          auto detailed = observe_sdk(cut, data_, &camera, config_.radius);
          const auto terrain_wall=elapsed(start);
          if (imagery_) {
            std::vector<std::pair<lod_patch,std::uint8_t>> fragments;
            for (const auto& patch : detailed.visible_patches)
              for (std::uint8_t f=0U;f<2U;++f) if ((patch.fragment_mask&(1U<<f)) && valid_fragment(diamond(patch),f))
                fragments.emplace_back(patch,f);
            detailed.imagery=imagery_->run(camera,fragments.size(),[&](std::size_t i) {
              const auto& item=fragments[i];
              const auto found=data_.heights.find(identity(item.first));
              require(found!=data_.heights.end(),"imagery terrain heights missing");
              auto mesh=std::make_shared<terra::frame::patch_surface_mesh>();
              require(terra::frame::make_cylindrical_patch_surface(item.first,item.second,
                  found->second.samples.fragments[item.second],config_.scale,config_.radius,*mesh)==
                  terra::frame::surface_mesh_status::ok,"imagery terrain mesh failed");
              return mesh;
            });
          }
          write_result("sdk-native", p, config_, camera, detailed, m, terrain_wall, "ready");
          return true;
        }
      } else stable = 0U;
      if (frozen_ && !cut.converged && !cut.budget_exhausted &&
          cut.pending_priority_update_count == 0U && cut.change_count == 0U) {
        auto current = observe_sdk(cut, data_, &camera, config_.radius);
        for (const auto& pending : cut.record_requests) {
          const auto& available = pending.kind == terra::frame::lod_record_kind::root ?
              frozen_resources_.available_roots : frozen_resources_.available_details;
          const bool found = std::any_of(available.begin(), available.end(), [&](const terra::frame::lod_detail_key& v) {
            return v.level == pending.patch.level && v.id == pending.patch.id;
          });
          if (!found) current.missing_inputs.push_back(fragment_key(pending.patch.level, pending.patch.id, 0U));
        }
        if (!current.missing_inputs.empty()) {
          current.pending_refines = current.missing_inputs.size();
          write_result("sdk-native", p, config_, camera, current, m, elapsed(start), "input-incomplete");
          return false;
        }
      }
      if (elapsed(start) - (data_.transport_ms - transport_before) > 30000.0) {
        write_result("sdk-native", p, config_, camera, observe_sdk(cut, data_), m,
                     elapsed(start), "timeout");
        return false;
      }
    }
    throw std::runtime_error("SDK iteration safety limit reached");
  }
};

void sample_ground(const configuration& c, double longitude, double latitude) {
  terra::frame::height_demand_request request;
  request.radius = c.radius; request.patch_dimension = c.dimension;
  request.u = longitude; request.v = latitude; request.sample_spacing_metres = 10.0;
  request.bounds = terra::core::bounds2d({{-180.0,-90.0}}, {{180.0,90.0}});
  terra::frame::height_session session;
  session.begin(request, c.scale, 32U * 1024U * 1024U);
  data_source data; data.dimension = c.dimension; data.scale = c.scale;
  for (std::size_t step = 0U; step < 20000U; ++step) {
    const auto state = session.step(32U);
    if (state == terra::frame::height_session_state::ready ||
        state == terra::frame::height_session_state::limited) {
      const auto& sample = session.sample();
      require(sample.available && !(sample.reasons & terra::frame::height_request_failed),
              "ground sample unavailable");
      std::cout << "{\"type\":\"ground\",\"heightMeters\":" << sample.height_metres
          << ",\"level\":" << sample.level << ",\"dataLevel\":" << sample.data_level
          << ",\"reasons\":" << sample.reasons << ",\"sampleSpacingMeters\":"
          << sample.sample_spacing_metres << '}' << std::endl;
      return;
    }
    require(state == terra::frame::height_session_state::planning ||
        state == terra::frame::height_session_state::working ||
        state == terra::frame::height_session_state::waiting, "ground query failed");
    const auto requests = session.requests();
    for (const auto& pending : requests) {
      lod_patch patch; patch.level = pending.level; patch.id = pending.id;
      const auto* record = data.record(pending.root ? 1U : 2U, patch);
      if (!record) require(session.unavailable(pending, false), "ground no-data rejected");
      else {
        require(session.can_decode(pending), "ground query capacity reached");
        auto input = *record;
        require(session.submit(pending, std::move(input)), "ground record rejected");
      }
    }
  }
  throw std::runtime_error("ground query iteration safety limit reached");
}

// Synchronous encoded fixture access deliberately excludes executor/network
// queues. It uses the original desktop decoder, not SDK height conversion.
class desktop_fetcher : public cbdam::cbdam_diamond_fetcher {
  const configuration config_;
 public:
  double data_cpu = 0.0;
  double transport_ms = 0.0;
  std::size_t requests = 0U;
  std::function<std::size_t(const key_t&)> level_of;
  explicit desktop_fetcher(const configuration& c) : cbdam::cbdam_diamond_fetcher("headless-fixture"), config_(c) {
    cbdam::cylindrical_coordinate_transform transform(c.radius);
    repository_parameters_ = cbdam::repository_parameters(c.dimension, c.scale, &transform,
                                                         "EPSG:4326", "headless fixture");
    is_connected_ = true;
  }
  status_data_pair_t load(unsigned kind, std::size_t level, const key_t& id) {
    const auto transport_start = clock_type::now();
    std::cout << "{\"type\":\"request\",\"kind\":" << kind << ",\"key\":[" << level
        << ',' << id[0] << ',' << id[1] << ',' << id[2] << "]}" << std::endl;
    ++requests;
    unsigned status = 0U;
    require(bool(std::cin >> status), "desktop record input ended");
    if (status == 404U && kind == 2U) {
      transport_ms += elapsed(transport_start); return {NULL_DATA, nullptr};
    }
    require(status == 200U, "desktop record failed or uncaptured");
    std::string path;
    std::size_t offset = 0U, count = 0U;
    require(bool(std::cin >> std::quoted(path) >> offset >> count), "invalid desktop record input");
    transport_ms += elapsed(transport_start);
    const std::size_t n = config_.dimension + (kind == 1U ? 1U : 0U);
    require(count > 0U && count <= n * n * 16U + 4096U, "desktop encoded envelope exceeded");
    const auto start = cpu_ms();
    std::vector<std::uint8_t> bytes(count);
    std::ifstream input(path, std::ios::binary);
    input.seekg(static_cast<std::streamoff>(offset));
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(count));
    require(bool(input), "desktop record read failed");
    value_t* value = decoded(bytes.data(), bytes.size());
    require(value && value->extent()[0] == n && value->extent()[1] == n,
            "desktop decoded dimensions differ");
    data_cpu += cpu_ms() - start;
    return {DONE, value};
  }
  status_data_pair_t fetch(const key_t& id, const cbdam::aabox2d_t&) override {
    return load(2U, level_of(id), id);
  }
  void prefetch(const key_t&, const cbdam::aabox2d_t&) override {}
  void receive() override {}
};

class desktop_graph : public cbdam::grid_diamond_graph_incore {
 public:
  std::shared_ptr<const terra::frame::patch_surface_mesh> surface(
      const lod_patch& patch,std::uint8_t fragment,const configuration& c) const {
    const auto found=diamond_at(patch.level,cbdam::grid_point_t(patch.id[0],patch.id[1],patch.id[2]));
    require(found.first,"desktop imagery terrain missing");
    const auto* data=found.second->second.reference_counted_patch_data(fragment);
    require(data!=nullptr,"desktop imagery positions missing");
    auto mesh=std::make_shared<terra::frame::patch_surface_mesh>();
    require(terra::frame::describe_patch_surface(patch,fragment,c.dimension,true,c.radius,
        imagery_config(c).surface.bounds,*mesh)==terra::frame::surface_mesh_status::ok,
        "desktop imagery mesh metadata failed");
    mesh->positions_xyz.resize(data->gl_points().size()*3U);
    for (std::size_t i=0U;i<data->gl_points().size();++i) for (std::size_t a=0U;a<3U;++a)
      mesh->positions_xyz[i*3U+a]=static_cast<float>(
          data->diamond_center()[a]+data->gl_points()[i][a]-mesh->origin[a]);
    return mesh;
  }
  using logical_cut = std::vector<std::unique_ptr<cbdam::diamond_patch_accessor>>;
  logical_cut consume() const {
    logical_cut result;
    // terrain_model::fill_data_cut's no-texture path: all leaf accessors,
    // including invisible fragments, own their original reference-counted data.
    // New accessors are acquired before the previous logical cut is released.
    for (auto it = refinement_heap_.begin(); it != refinement_heap_.end(); ++it) {
      const auto found = diamond_at(it->first.level(), it->second);
      require(found.first, "desktop output references a missing diamond");
      const auto& state = found.second->second;
      for (std::size_t f = 0U; f < 2U; ++f) if (state.has_fragment(f))
        result.emplace_back(new cbdam::diamond_patch_accessor(state, f, it->first.visible(),
            nullptr, cbdam::grid_point_t(0,0,0), sl::linear_map_factory3d::identity()));
    }
    return result;
  }
  // Fixture initialization mirrors open/read_roots without a repository or
  // network connection. Refinement, coarsening, codec and bounds are untouched.
  void open_fixture(desktop_fetcher& fetcher) {
    geometry_fetcher_ = &fetcher;
    height_repository_parameters_ = &fetcher.get_repository_parameters();
    delta_height_codec_.init(height_patch_dim(), height_scale_factor(), uvh_xyz_transform());
    procedural_height_.resize(sl::index<2>(height_patch_dim(), height_patch_dim()));
    for (std::size_t i = 0U; i < 8U; ++i) {
      const auto root = cbdam::grid_diamond::cylindrical_canonical_root(i);
      const auto loaded = fetcher.load(1U, 0U, root.id());
      require(loaded.first == desktop_fetcher::DONE, "desktop root unavailable");
      std::unique_ptr<array2_height_t> height(loaded.second);
      build_canonical_root(root, height.get());
    }
    is_open_ = true;
    set_cache_capacity(2048U);
    set_decoded_diamond_budget(32U);
    // Compare the effective geometric threshold. terrain_model normally scales
    // it by texture width / patch dimension; this core has no texture layer.
    set_texture_tile_width(0U);
    init_heaps();
  }
  bool cached_return(float threshold, const projective_map_t& projection, const rigid_body_map_t& view) const {
    return camera_pv_ == projection * view && data_missing_fraction_ == 0.0 && threshold == previous_threshold_;
  }
  // Target-set adapter only: finish candidates skipped by extract_cut's cached
  // return. Use the original heap order and original public topology operation;
  // never invalidate camera/threshold/data_missing_fraction to force an update.
  // This is explicitly not the original runtime's continuation or its timing.
  std::size_t complete_coarsening(float threshold) {
    std::size_t count = 0U;
    while (count < 32U && !coarsening_heap_.empty() &&
           coarsening_heap_.top().first.priority() < threshold) {
      const auto candidate = coarsening_heap_.top();
      coarsen(candidate.first.level(), candidate.second);
      ++count;
    }
    require(check_heap_consistency(), "desktop completion corrupted heaps");
    return count;
  }
  observation observe(float threshold, const terra::frame::camera_snapshot* camera = nullptr) const {
    observation result;
    std::ostringstream state_json;
    state_json << std::setprecision(17) << "{\"schema\":\"terra.desktop-leaf-observation.v1\",\"leaves\":[";
    bool first_leaf = true;
    result.nodes = diamond_count();
    result.cached_update_return = data_missing_fraction_ == 0.0 && threshold == previous_threshold_;
    for (std::size_t l = 0U; l < level_count(); ++l) {
      for (auto it = level_begin(l); it != level_end(l); ++it) {
        const auto& state = it->second;
        if (!state.is_leaf()) continue;
        const bool visible = is_visible(state.bounding_volume());
        if (visible) result.error = std::max(result.error, diamond_projected_error(state.bounding_volume()));
        const auto& id = it->first.id();
        if (camera) {
          double active_min = std::numeric_limits<double>::infinity(), active_max = -active_min;
          double retained_min = active_min, retained_max = active_max;
          unsigned mask = 0U;
          for (std::size_t f = 0U; f < 2U; ++f) {
            if (state.has_fragment(f)) mask |= 1U << f;
            const auto* samples = state.reference_counted_patch_data(f);
            if (!samples) continue;
            for (auto h : samples->values()) {
              const double meters = h * height_scale_factor();
              retained_min = std::min(retained_min, meters); retained_max = std::max(retained_max, meters);
              if (state.has_fragment(f)) {
                active_min = std::min(active_min, meters); active_max = std::max(active_max, meters);
              }
            }
          }
          require(mask && std::isfinite(active_min), "desktop leaf has no active heights");
          if (!first_leaf) state_json << ',';
          first_leaf = false;
          state_json << "{\"key\":[" << l << ',' << id[0] << ',' << id[1] << ',' << id[2]
              << "],\"fragmentMask\":" << mask << ",\"activeHeightRange\":[" << active_min << ',' << active_max
              << "],\"retainedHeightRange\":[" << retained_min << ',' << retained_max
              << "],\"visible\":" << (visible ? "true" : "false")
              << ",\"projectedError\":" << diamond_projected_error(state.bounding_volume()) << '}';
        }
        if (visible) {
          lod_patch patch;
          patch.level = l; patch.id = {{id[0],id[1],id[2]}}; patch.visible = true;
          for (std::size_t i = 0U; i < 4U; ++i) {
            const auto& corner = it->first.corner(i);
            patch.corners[i] = {{corner[0],corner[1],corner[2]}};
          }
          for (std::size_t f = 0U; f < 2U; ++f) if (state.has_fragment(f)) patch.fragment_mask |= std::uint8_t(1U << f);
          result.visible_patches.push_back(patch);
          if (l >= 40U) ++result.unverified_level_leaves;
        }
        for (std::size_t f = 0U; f < 2U; ++f) if (state.has_fragment(f)) {
          const auto value = fragment_key(l, {{id[0], id[1], id[2]}}, f);
          result.all.push_back(value);
          if (visible) result.visible.push_back(value);
          const auto* data = state.reference_counted_patch_data(f);
          require(data != nullptr, "desktop selected height unavailable");
          result.active_height_bytes += data->values().size() * sizeof(std::int32_t);
          if (camera && visible) {
            for (std::size_t i = 0U; i < data->values().size(); ++i) {
              terra::core::vector3d position;
              for (std::size_t axis = 0U; axis < 3U; ++axis)
                position[axis] = data->diamond_center()[axis] + data->gl_points()[i][axis];
              inspect_vertex(result, *camera, position, data->values()[i] * height_scale_factor());
            }
          }
        }
      }
    }
    for (auto it = refinement_heap_.begin(); it != refinement_heap_.end(); ++it)
      if (it->first.priority() > threshold) ++result.pending_refines;
    for (auto it = coarsening_heap_.begin(); it != coarsening_heap_.end(); ++it)
      if (it->first.priority() < threshold) {
        ++result.pending_coarsens;
        const auto& id = it->second;
        std::ostringstream description;
        description << std::setprecision(9) << it->first.level() << '/' << id[0] << '/' << id[1] << '/' << id[2]
            << " priority=" << it->first.priority();
        result.coarsen_candidates.push_back(description.str());
      }
    result.cache_entries = geometry_cache_.size();
    for (auto it = geometry_cache_.map_begin(); it != geometry_cache_.map_end(); ++it) {
      const auto* data = it->second;
      result.cached_geometry_bytes += data->values().capacity() * sizeof(std::int32_t) +
          data->gl_points().capacity() * sizeof(cbdam::diamond_vertices::point3_t) +
          data->gl_normals().capacity() * sizeof(cbdam::diamond_vertices::normal_t);
    }
    std::sort(result.all.begin(), result.all.end());
    std::sort(result.visible.begin(), result.visible.end());
    if (camera) {state_json << "]}"; result.terrain_observation = state_json.str();}
    return result;
  }
};

sl::matrix4d desktop_matrix(const terra::frame::matrix4d& input) {
  sl::matrix4d output;
  for (std::size_t row = 0U; row < 4U; ++row)
    for (std::size_t column = 0U; column < 4U; ++column)
      output(row, column) = input[row * 4U + column];
  return output;
}

class desktop_driver {
  configuration config_;
  desktop_fetcher fetcher_;
  desktop_graph graph_;
  desktop_graph::logical_cut consumed_;
  bool complete_target_;
  std::unique_ptr<imagery_driver> imagery_;
 public:
  explicit desktop_driver(const configuration& c, bool complete_target) :
      config_(c), fetcher_(c), complete_target_(complete_target) {
    fetcher_.level_of = [this](const cbdam::grid_point_t& id) { return graph_.level(id); };
    graph_.open_fixture(fetcher_);
    consumed_ = graph_.consume();
    if (c.imagery) imagery_.reset(new imagery_driver(imagery_config(c),&graph_));
  }
  bool run(const pose& p) {
    const auto camera = camera_at(config_, p);
    const sl::projective_map3d projection(desktop_matrix(camera.projection));
    const sl::rigid_body_map3d view(desktop_matrix(camera.view));
    const auto pv = (projection * view).as_matrix();
    for (std::size_t r = 0U; r < 4U; ++r) for (std::size_t c = 0U; c < 4U; ++c)
      require(std::abs(pv(r,c) - camera.projection_view[4U*r+c]) <=
          1e-10 * std::max(1.0, std::abs(pv(r,c))), "desktop camera matrix conversion differs");
    measurement m;
    const auto start = clock_type::now();
    const auto data_cpu_before = fetcher_.data_cpu;
    const auto transport_before = fetcher_.transport_ms;
    std::vector<std::string> previous;
    unsigned quiet = 0U;
    for (std::size_t step = 1U; step <= 20000U; ++step) {
      int changes = 0;
      const bool cached = graph_.cached_return(config_.threshold, projection, view);
      if (cached) ++m.cached_update_returns;
      const auto wall_start = clock_type::now();
      const auto cpu_start = cpu_ms();
      graph_.extract_cut(config_.threshold, projection, view, changes);
      if (cached && complete_target_) {
        const auto completion_start = cpu_ms();
        const auto count = graph_.complete_coarsening(config_.threshold);
        m.completion_cpu += cpu_ms() - completion_start;
        if (count) ++m.completion_calls;
        m.completion_coarsens += count;
        changes += static_cast<int>(count);
      }
      const auto duration = cpu_ms() - cpu_start;
      m.cpu += duration;
      m.maximum_call_cpu = std::max(m.maximum_call_cpu, duration);
      m.maximum_call_wall = std::max(m.maximum_call_wall, elapsed(wall_start));
      if (changes) {
        const auto consumer_start = cpu_ms();
        auto next = graph_.consume();
        consumed_.swap(next);
        next.clear();
        m.consumer_cpu += cpu_ms() - consumer_start;
        ++m.logical_publications;
      }
      m.steps = step; m.changes += static_cast<std::size_t>(changes);
      const auto current = graph_.observe(config_.threshold);
      require(current.nodes <= 65536U, "desktop topology safety limit reached");
      quiet = changes == 0 && current.all == previous ? quiet + 1U : 0U;
      previous = current.all;
      // Covers two complete opportunities of the original periodic coarsener.
      // Outstanding executable work is a stall, never a successful quiet cut.
      if (quiet >= 20U || elapsed(start) - (fetcher_.transport_ms - transport_before) > 30000.0) {
        m.data_cpu = fetcher_.data_cpu - data_cpu_before;
        m.cpu = std::max(0.0, m.cpu - m.data_cpu);
        const bool ready = quiet >= 20U && current.pending_refines == 0U && current.pending_coarsens == 0U &&
            current.unverified_level_leaves == 0U;
        auto detailed = graph_.observe(config_.threshold, &camera);
        const auto terrain_wall=elapsed(start);
        if (ready && imagery_) {
          std::vector<std::pair<lod_patch,std::uint8_t>> fragments;
          for (const auto& patch : detailed.visible_patches)
            for (std::uint8_t f=0U;f<2U;++f) if ((patch.fragment_mask&(1U<<f)) && valid_fragment(diamond(patch),f))
              fragments.emplace_back(patch,f);
          detailed.imagery=imagery_->run(camera,fragments.size(),[&](std::size_t i) {
            return graph_.surface(fragments[i].first,fragments[i].second,config_);
          });
        }
        write_result(complete_target_ ? "desktop-native-target" : "desktop-native", p, config_, camera, detailed, m, terrain_wall,
                     ready ? "ready" : current.unverified_level_leaves ? "safety-level-limited" :
                       quiet >= 20U ? "stalled" : "timeout");
        return ready;
      }
    }
    throw std::runtime_error("desktop iteration safety limit reached");
  }
};
}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc >= 9 && argc <= 11, "usage: terra_benchmark_terrain desktop|sdk radius patch_dim height_scale width height fov pixel_error [frozen_mesh_bytes [imagery-demand]]");
    const std::string backend = argv[1];
    configuration c;
    c.radius = std::stod(argv[2]); c.dimension = static_cast<std::uint32_t>(std::stoul(argv[3]));
    c.scale = std::stod(argv[4]); c.width = std::stoi(argv[5]); c.height = std::stoi(argv[6]);
    c.fov = std::stod(argv[7]); c.pixels = std::stod(argv[8]);
    if (argc >= 10) c.mesh_limit = static_cast<std::size_t>(std::stoull(argv[9]));
    if (argc == 11) { require(std::string(argv[10])=="imagery-demand","unknown imagery profile"); c.imagery=true; }
    require((backend == "desktop" || backend == "desktop-target" || backend == "sdk" || backend == "height" || backend == "camera") && std::isfinite(c.radius) && c.radius > 0.0 &&
        c.dimension >= 2U && c.dimension <= 128U && std::isfinite(c.scale) && c.scale > 0.0 &&
        c.width > 0 && c.height > 0 && std::isfinite(c.fov) && c.fov > 0.0 && c.fov < std::acos(-1.0) &&
        std::isfinite(c.pixels) && c.pixels > 0.0, "invalid configuration");
    c.threshold = static_cast<float>(c.pixels * 2.0 * std::tan(c.fov / 2.0) / c.height);
    std::cout << std::setprecision(17);
    std::unique_ptr<sdk_driver> sdk;
    std::unique_ptr<desktop_driver> desktop;
    if (backend == "sdk") sdk.reset(new sdk_driver(c));
    else if (backend == "desktop" || backend == "desktop-target") desktop.reset(new desktop_driver(c, backend == "desktop-target"));
    std::cout << "{\"type\":\"ready\",\"scope\":\"terrain-core-only\",\"maximumChanges\":32}" << std::endl;
    std::string command;
    std::size_t stages = 0U;
    while (std::cin >> command) {
      if (command == "end") {
        std::cout << "{\"type\":\"complete\",\"stages\":" << stages << '}' << std::endl;
        return 0;
      }
      if (command == "sample" && backend == "height") {
        double longitude = 0.0, latitude = 0.0;
        require(bool(std::cin >> longitude >> latitude), "invalid ground coordinates");
        sample_ground(c, longitude, latitude);
        ++stages;
        continue;
      }
      if (command == "freeze" && sdk) {
        sdk->freeze();
        ++stages;
        continue;
      }
      require(command == "pose", "invalid headless command");
      require(backend != "height", "height backend cannot run a pose");
      pose p;
      require(bool(std::cin >> std::quoted(p.id) >> p.longitude >> p.latitude >> p.height >>
          p.range >> p.heading >> p.tilt) && !p.id.empty() && p.id.size() <= 100U &&
          p.id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") ==
              std::string::npos, "invalid pose input");
      if (backend == "camera") {
        const auto camera = camera_at(c, p);
        write_result("shared-camera", p, c, camera, observation(), measurement(), 0.0, "ready", "camera");
        ++stages;
        continue;
      }
      if (sdk ? !sdk->run(p) : !desktop->run(p)) return 2;
      ++stages;
    }
    throw std::runtime_error("headless input ended before end command");
  } catch (const std::exception& error) {
    std::cerr << "Headless terrain benchmark failed: " << error.what() << '\n';
    return 1;
  }
}
