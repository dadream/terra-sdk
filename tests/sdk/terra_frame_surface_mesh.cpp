#include <terra/core/coordinate_transform.hpp>
#include <terra/core/wmts.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/surface_mesh.hpp>
#include <terra/frame/height_query.hpp>
#include <terra/core/wmts.hpp>

#include <cmath>
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>

namespace {

constexpr double radius = 6378000.0;
constexpr std::uint32_t patch_dimension = 64U;
std::set<std::uint32_t> texture_patterns_seen;
std::size_t irregular_texture_grids = 0U;

void expect(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

terra::frame::camera_snapshot default_camera() {
  const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
  return terra::frame::globe_camera(
      static_cast<float>(radius), 1280, 720, y_fov).snapshot();
}

void verify_request_contract(const terra::frame::lod_cut& cut,
                             std::size_t root_count,
                             std::size_t detail_count) {
  std::size_t actual_roots = 0U;
  std::size_t actual_details = 0U;
  for (const terra::frame::lod_record_request& request :
       cut.record_requests) {
    expect(request.patch.fragment_mask != 0U,
           "record request lost its fragment contract");
    if (request.kind == terra::frame::lod_record_kind::root) {
      ++actual_roots;
      expect(request.patch.level == 0U,
             "root record request must use a root patch");
    } else if (request.kind == terra::frame::lod_record_kind::detail) {
      ++actual_details;
    } else {
      throw std::runtime_error("unknown record request kind");
    }
  }
  expect(actual_roots == root_count, "root record request count changed");
  expect(actual_details == detail_count,
         "detail record request count changed");
}

void verify_surface(const terra::frame::lod_patch& patch,
                    std::uint8_t fragment,
                    const terra::core::global_geodetic_wmts_selector&
                        /*selector*/) {
  terra::frame::patch_surface_mesh mesh;
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, fragment, patch_dimension, radius, mesh) ==
             terra::frame::surface_mesh_status::ok,
         "unable to build cylindrical patch surface");
  const std::size_t vertex_count =
      (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
  expect(mesh.patch.id == patch.id && mesh.fragment == fragment,
         "surface identity changed");
  expect(mesh.positions_xyz.size() == vertex_count * 3U,
         "surface position layout changed");
  expect(mesh.texture_uv.size() == vertex_count * 2U,
         "surface texture layout changed");
  expect(mesh.texture_node.is_valid() && mesh.texture_node.level == 0,
         "root fragment selected the wrong texture level");

  for (std::size_t vertex = 0U; vertex < vertex_count; ++vertex) {
    const std::size_t position = vertex * 3U;
    const std::size_t texture = vertex * 2U;
    const double x = mesh.origin[0] + mesh.positions_xyz[position];
    const double y = mesh.origin[1] + mesh.positions_xyz[position + 1U];
    const double z = mesh.origin[2] + mesh.positions_xyz[position + 2U];
    const double length = std::sqrt(x * x + y * y + z * z);
    expect(std::isfinite(length) && std::abs(length - radius) < 2.0,
           "surface vertex left the zero-height sphere");
    const float u = mesh.texture_uv[texture];
    const float v = mesh.texture_uv[texture + 1U];
    expect(std::isfinite(u) && std::isfinite(v) && u >= -0.0001F &&
               u <= 1.0001F && v >= -0.0001F && v <= 1.0001F,
           "surface texture coordinate is outside its tile");
  }
}

void verify_height_surface(
    const terra::frame::lod_patch& patch,
    const terra::core::global_geodetic_wmts_selector& /*selector*/) {
  terra::codec::height_fragment heights;
  heights.dimension = patch_dimension;
  const std::size_t vertex_count =
      (patch_dimension + 1U) * (patch_dimension + 2U) / 2U;
  heights.values.assign(vertex_count, 64);

  terra::frame::patch_surface_mesh mesh;
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, 0U, heights, 0.015625, radius, mesh) ==
             terra::frame::surface_mesh_status::ok,
         "unable to build elevated cylindrical patch surface");
  for (std::size_t vertex = 0U; vertex < vertex_count; ++vertex) {
    const std::size_t position = vertex * 3U;
    const double x = mesh.origin[0] + mesh.positions_xyz[position];
    const double y = mesh.origin[1] + mesh.positions_xyz[position + 1U];
    const double z = mesh.origin[2] + mesh.positions_xyz[position + 2U];
    const double length = std::sqrt(x * x + y * y + z * z);
    expect(std::isfinite(length) && std::abs(length - (radius + 1.0)) < 2.0,
           "surface vertex ignored the decoded height");
  }

  terra::frame::patch_surface_mesh boundary;
  expect(terra::frame::make_cylindrical_patch_boundary(patch, 0U, heights, 0.015625, radius, boundary) ==
      terra::frame::surface_mesh_status::ok, "boundary generation failed");
  expect(boundary.origin == mesh.origin && boundary.texture_uv.size() == 6U * patch_dimension,
      "boundary layout is not edge-only");
  std::size_t index = 0U, edge = 0U;
  for (std::uint32_t y = 0U; y <= patch_dimension; ++y)
    for (std::uint32_t x = 0U; x <= patch_dimension-y; ++x, ++index) {
      if (x && y && x+y != patch_dimension) continue;
      for (std::size_t axis = 0U; axis < 3U; ++axis)
        expect(boundary.positions_xyz[edge*3U+axis] == mesh.positions_xyz[index*3U+axis], "boundary position mismatch");
      for (std::size_t axis = 0U; axis < 2U; ++axis)
        expect(boundary.texture_uv[edge*2U+axis] == mesh.texture_uv[index*2U+axis], "boundary UV mismatch");
      ++edge;
    }
  heights.values.pop_back();
  expect(terra::frame::make_cylindrical_patch_surface(
             patch, 0U, heights, 0.015625, radius, mesh) ==
             terra::frame::surface_mesh_status::invalid_height,
         "surface accepted a malformed height fragment");
}

void verify_boundary_layout(const terra::frame::lod_patch& patch, bool global) {
  using namespace terra;
  const core::bounds2d bounds({{10.0,20.0}},{{110.0,220.0}});
  for (const auto dimension : {1U,2U,3U,64U,256U}) for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!patch.has_fragment(fragment)) continue;
    codec::height_fragment heights;
    heights.dimension = dimension;
    heights.values.resize((dimension+1U)*(dimension+2U)/2U);
    for (std::size_t i = 0U; i < heights.values.size(); ++i)
      heights.values[i] = static_cast<std::int32_t>(i % 2003U) - 1001;
    frame::patch_surface_mesh full, edge;
    const auto a = global ? frame::make_cylindrical_patch_surface(patch,fragment,heights,0.25,radius,full)
        : frame::make_planar_patch_surface(patch,fragment,heights,0.25,bounds,full);
    const auto b = global ? frame::make_cylindrical_patch_boundary(patch,fragment,heights,0.25,radius,edge)
        : frame::make_planar_patch_boundary(patch,fragment,heights,0.25,bounds,edge);
    if (a != frame::surface_mesh_status::ok || b != a)
      throw std::runtime_error("boundary layout generation failed: global=" + std::to_string(global) +
          " level=" + std::to_string(patch.level) + " fragment=" + std::to_string(fragment) +
          " dimension=" + std::to_string(dimension) + " status=" + frame::surface_mesh_status_message(a));
    frame::patch_surface_mesh positions;
    const auto position_status = global
        ? frame::make_cylindrical_patch_positions(patch,fragment,heights,0.25,radius,positions)
        : frame::make_planar_patch_positions(patch,fragment,heights,0.25,bounds,positions);
    expect(position_status == a && positions.origin == full.origin &&
        positions.texture_uv.capacity() == 0U && positions.positions_xyz.size() == full.positions_xyz.size() &&
        std::memcmp(positions.positions_xyz.data(), full.positions_xyz.data(),
            full.positions_xyz.size() * sizeof(float)) == 0,
        "position-only production changed vertices or allocated a UV payload");
    expect(full.origin == edge.origin && edge.positions_xyz.size() == 9U*dimension &&
        edge.texture_uv.size() == 6U*dimension, "boundary layout size/origin mismatch");
    std::size_t vertex = 0U, boundary = 0U;
    // Reference scans the complete mesh, independently of the edge-only walk.
    for (std::uint32_t y = 0U; y <= dimension; ++y)
      for (std::uint32_t x = 0U; x <= dimension-y; ++x, ++vertex) {
        if (x && y && x+y != dimension) continue;
        for (std::size_t axis = 0U; axis < 3U; ++axis)
          expect(edge.positions_xyz[3U*boundary+axis] == full.positions_xyz[3U*vertex+axis],
              "edge-only height/position arithmetic changed");
        for (std::size_t axis = 0U; axis < 2U; ++axis)
          expect(edge.texture_uv[2U*boundary+axis] == full.texture_uv[2U*vertex+axis],
              "edge-only UV arithmetic changed");
        ++boundary;
      }
    expect(boundary == 3U*dimension, "boundary vertex order changed");
    const auto total = static_cast<std::uint32_t>(heights.values.size());
    std::vector<float> sampled(full.texture_uv.size(), -999.0F);
    // Odd sizes cross row boundaries, including the final one-vertex row.
    for (std::uint32_t first = 0U; first < total; first += 127U) {
      expect(frame::sample_patch_texture_coordinates(patch, fragment, dimension,
          global, bounds, first, std::min(127U, total - first), sampled.data() + 2U * first) ==
          frame::surface_mesh_status::ok, "chunked UV sampling failed");
    }
    expect(sampled == full.texture_uv, "metadata UV differs from materialized height mesh");
    std::vector<float> sampled_positions(full.positions_xyz.size(), -999.0F);
    for (std::uint32_t first = 0U; first < total; first += 127U)
      expect(frame::sample_patch_positions(patch, fragment, heights, 0.25,
          global, radius, bounds, first, std::min(127U, total - first), sampled_positions.data() + 3U * first) ==
          frame::surface_mesh_status::ok, "chunked position sampling failed");
    expect(std::memcmp(sampled_positions.data(), full.positions_xyz.data(),
        sampled_positions.size() * sizeof(float)) == 0, "sampled positions changed Float32 mesh arithmetic");
    expect(frame::sample_patch_positions(patch, fragment, heights, 0.25,
        global, radius, bounds, total, 0U, nullptr) == frame::surface_mesh_status::ok,
        "empty position range rejected");
    if (global) {
      frame::texture_grid_pattern pattern;
      if (frame::describe_cylindrical_texture_pattern(patch, fragment, dimension, pattern)) {
        texture_patterns_seen.insert(pattern.orientation);
        std::fill(sampled.begin(), sampled.end(), -999.0F);
        for (std::uint32_t first = 0U; first < total; first += 127U)
          expect(pattern.sample(first, std::min(127U, total - first), sampled.data() + 2U * first),
              "shared texture pattern sampling failed");
        expect(std::memcmp(sampled.data(), full.texture_uv.data(), sampled.size() * sizeof(float)) == 0,
            "shared texture identity changed Float32 coordinates");
        float unchanged[2] = {-999.0F,-999.0F};
        expect(!pattern.sample(total, 1U, unchanged) && unchanged[0] == -999.0F && unchanged[1] == -999.0F,
            "invalid pattern range changed output");
        expect(pattern.sample(total, 0U, nullptr), "empty pattern range rejected");
      } else ++irregular_texture_grids;
    }
    expect(frame::sample_patch_texture_coordinates(patch, fragment, dimension,
        global, bounds, total, 0U, nullptr) == frame::surface_mesh_status::ok,
        "empty UV range rejected");
    float sentinel[2] = {-999.0F, -999.0F};
    for (const auto range : {std::array<std::uint32_t,2>{{total,1U}}, {{UINT32_MAX,2U}},
                            {{0U,frame::maximum_surface_sample_vertices+1U}}}) {
      expect(frame::sample_patch_texture_coordinates(patch, fragment, dimension,
          global, bounds, range[0], range[1], sentinel) == frame::surface_mesh_status::invalid_argument,
          "invalid UV range accepted");
      expect(sentinel[0] == -999.0F && sentinel[1] == -999.0F, "rejected UV range wrote output");
    }
    expect(frame::sample_patch_texture_coordinates(patch, fragment, dimension,
        global, bounds, 0U, 1U, nullptr) == frame::surface_mesh_status::invalid_argument,
        "nonempty UV range accepted null output");
    float untouched[9];
    std::fill(untouched, untouched + 9U, -999.0F);
    for (const auto range : {std::array<std::uint32_t,2>{{total,1U}}, {{UINT32_MAX,2U}},
                            {{0U,frame::maximum_surface_sample_vertices+1U}}})
      expect(frame::sample_patch_positions(patch, fragment, heights, 0.25,
          global, radius, bounds, range[0], range[1], untouched) == frame::surface_mesh_status::invalid_argument,
          "invalid position range accepted");
    expect(frame::sample_patch_positions(patch, fragment, heights, 0.25,
        global, radius, bounds, 0U, 1U, nullptr) == frame::surface_mesh_status::invalid_argument,
        "nonempty position range accepted null output");
    for (const auto scale : {0.0, -1.0, std::numeric_limits<double>::infinity()})
      expect(frame::sample_patch_positions(patch, fragment, heights, scale,
          global, radius, bounds, 0U, 3U, untouched) == frame::surface_mesh_status::invalid_height,
          "invalid position scale accepted");
    // A failure at the end of a slice must not expose a partial successful prefix.
    heights.values[0] = 0; heights.values[1] = 0; heights.values[2] = -1;
    if (global)
      expect(frame::sample_patch_positions(patch, fragment, heights, radius,
          true, radius, bounds, 0U, 3U, untouched) == frame::surface_mesh_status::invalid_height,
          "inside-planet height accepted");
    heights.values[2] = 2;
    expect(frame::sample_patch_positions(patch, fragment, heights, std::numeric_limits<double>::max(),
        global, radius, bounds, 0U, 3U, untouched) == frame::surface_mesh_status::invalid_height,
        "overflowing height accepted");
    heights.values.pop_back();
    expect(frame::sample_patch_positions(patch, fragment, heights, 0.25,
        global, radius, bounds, 0U, 3U, untouched) == frame::surface_mesh_status::invalid_height,
        "malformed height input accepted");
    expect(std::all_of(untouched, untouched + 9U, [](float value) { return value == -999.0F; }),
        "rejected position read modified output");
  }
}

void verify_deep_texture_layout(terra::core::grid_diamond diamond, bool global) {
  const auto center = diamond.id();
  for (std::uint32_t level = 1U; level <= 48U; ++level) {
    bool found = false;
    double best_distance = 1e100;
    terra::core::grid_diamond next;
    // Boundary diamonds can have a fragment outside the dataset. Follow a
    // legal child near the root center and preserve its available fragments.
    for (std::uint32_t attempt = 0U; attempt < 4U; ++attempt) {
      const auto child = (level + attempt) % 4U;
      const auto candidate = global ? diamond.cylindrical_child_diamond(child / 2U, child % 2U)
                                    : diamond.planar_child_diamond(child / 2U, child % 2U);
      if (!terra::imagery::terrain_anchor(candidate, level, 0U, global).is_valid() &&
          !terra::imagery::terrain_anchor(candidate, level, 1U, global).is_valid()) continue;
      double distance = 0.0;
      for (std::size_t axis = 0U; axis < 3U; ++axis) {
        const double delta = static_cast<double>(candidate.id()[axis]) - center[axis];
        distance += delta * delta;
      }
      if (distance < best_distance) { next = candidate; best_distance = distance; found = true; }
    }
    if (!found) throw std::runtime_error("deep UV fixture has no interior child: global=" +
        std::to_string(global) + " level=" + std::to_string(level));
    diamond = next;
    if (level != 1U && level != 2U && level != 39U && level != 48U) continue;
    terra::frame::lod_patch patch;
    patch.id = diamond.id(); patch.level = level;
    patch.fragment_mask = (terra::imagery::terrain_anchor(diamond, level, 0U, global).is_valid() ? 1U : 0U) |
                          (terra::imagery::terrain_anchor(diamond, level, 1U, global).is_valid() ? 2U : 0U);
    for (std::size_t i = 0U; i < 4U; ++i) patch.corners[i] = diamond.corner(i);
    verify_boundary_layout(patch, global);
  }
}

}  // namespace

void verify_height_queries() {
  using namespace terra;
  const double g = core::grid_coordinate_max;
  const core::bounds2d bounds({{10.0, 20.0}}, {{110.0, 220.0}});
  auto expected = [g](const core::vector3d& p) {
    return 100.0 + 160.0 * p[0] / g + 80.0 * p[1] / g + 40.0 * p[2] / g;
  };
  auto fragment = [&](const core::grid_diamond& diamond, std::size_t f) {
    codec::height_fragment h;
    h.dimension = 4U;
    const auto& a = diamond.corner((1U + 2U * f) % 4U);
    const auto& b = diamond.corner((2U + 2U * f) % 4U);
    const auto& c = diamond.corner((2U * f) % 4U);
    for (std::uint32_t y = 0; y <= 4; ++y) {
      for (std::uint32_t x = 0; x <= 4 - y; ++x) {
        core::vector3d point;
        for (std::size_t i = 0; i < 3; ++i) {
          point[i] = a[i] + (double(b[i]) - a[i]) * x / 4.0 +
                           (double(c[i]) - a[i]) * y / 4.0;
        }
        h.values.push_back(static_cast<std::int32_t>(std::lround(expected(point))));
      }
    }
    return h;
  };
  const auto roots = core::cylindrical_roots();
  // Includes poles, antimeridian, face edges, vertices and both cell triangles.
  for (double lon = -180.0; lon <= 180.0; lon += 15.0) {
    for (double lat = -90.0; lat <= 90.0; lat += 15.0) {
      const auto point = frame::height_query_grid(lon, lat, true, bounds);
      unsigned found = 0;
      for (const auto& root : roots) for (std::size_t f = 0; f < 2; ++f) {
        double height = 0.0;
        if (frame::sample_height_fragment(root, f, fragment(root, f), point, height)) {
          ++found;
          expect(std::abs(height - expected(point)) < 1e-8, "globe height interpolation/orientation mismatch");
        }
      }
      expect(found != 0, "globe query has a root coverage hole");
    }
  }
  const auto root = core::planar_root();
  for (double u = 10.0; u <= 110.0; u += 2.5) {
    for (double v = 20.0; v <= 220.0; v += 5.0) {
      const auto point = frame::height_query_grid(u, v, false, bounds);
      bool found = false;
      for (std::size_t f = 0; f < 2; ++f) {
        double height;
        if (frame::sample_height_fragment(root, f, fragment(root, f), point, height)) {
          found = true;
          expect(std::abs(height - expected(point)) < 1e-8, "planar height interpolation mismatch");
        }
      }
      expect(found, "planar query has a coverage hole");
    }
  }
  double height;
  expect(!frame::sample_height_fragment(root, 0, fragment(root, 0), {{0, 0, -g}}, height),
         "query projected an unrelated grid plane onto the fragment");
  expect(!frame::sample_height_fragment(root, 0, fragment(root, 0), {{2*g, 0, g}}, height),
         "query returned a nearest vertex outside coverage");
  expect(std::abs(frame::height_sample_spacing(root, 0, 4, false, bounds, 0) -
                  std::hypot(100.0, 200.0) / 4) < 1e-8, "sample spacing is not in dataset metres");
}

int main() {
  verify_height_queries();
  const terra::frame::camera_snapshot camera = default_camera();
  const terra::core::global_geodetic_wmts_selector selector(0, 2);
  const terra::frame::lod_cut root_cut =
      terra::frame::select_procedural_cylindrical_lod(
          radius, patch_dimension, 0.01F, camera);
  expect(root_cut.complete && root_cut.patches.size() == 8U,
         "root LOD cut changed");
  verify_request_contract(root_cut, 8U, 0U);

  std::size_t surface_count = 0U;
  for (const terra::frame::lod_patch& patch : root_cut.patches) {
    expect(patch.fragment_mask != 0U, "root patch lost both fragments");
    verify_boundary_layout(patch,true);
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (patch.has_fragment(fragment)) {
        verify_surface(patch, fragment, selector);
        ++surface_count;
      }
    }
  }
  expect(surface_count == 16U, "root surface fragment count changed");
  verify_height_surface(root_cut.patches.front(), selector);
  terra::frame::lod_patch planar;
  const auto root = terra::core::planar_root();
  planar.fragment_mask = 3U;
  for (std::size_t i = 0U; i < 4U; ++i) planar.corners[i] = root.corner(i);
  verify_boundary_layout(planar,false);
  verify_deep_texture_layout(root, false);
  for (const auto& globe_root : terra::core::cylindrical_roots())
    verify_deep_texture_layout(globe_root, true);

  terra::frame::globe_camera beijing_camera(
      static_cast<float>(radius), 780, 1186,
      static_cast<float>(30.0 * (3.14 / 180.0)));
  expect(beijing_camera.set_target_degrees(116.4074, 39.9042),
         "unable to set Beijing surface test target");
  beijing_camera.set_distance(beijing_camera.distance() * 0.82);
  const terra::frame::lod_cut beijing_zoom_cut =
      terra::frame::select_procedural_cylindrical_lod(
          radius, patch_dimension, 0.004487179487179487F,
          beijing_camera.snapshot());
  const terra::core::global_geodetic_wmts_selector tianditu_selector(1, 17);
  std::size_t beijing_surface_count = 0U;
  for (const terra::frame::lod_patch& patch : beijing_zoom_cut.patches) {
    if (!patch.visible) {
      continue;
    }
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!patch.has_fragment(fragment)) {
        continue;
      }
      terra::frame::patch_surface_mesh mesh;
      expect(terra::frame::make_cylindrical_patch_surface(
                 patch, fragment, patch_dimension, radius,
                 mesh) ==
                 terra::frame::surface_mesh_status::ok,
             "Beijing zoom surface lost antimeridian texture coverage");
      ++beijing_surface_count;
    }
  }
  expect(beijing_surface_count > 0U,
         "Beijing zoom surface test selected no fragments");

  const terra::frame::lod_cut refined_cut =
      terra::frame::select_procedural_cylindrical_lod(
          radius, patch_dimension, 0.005F, camera);
  expect(refined_cut.complete && refined_cut.patches.size() == 28U,
         "refined LOD cut changed");
  verify_request_contract(refined_cut, 8U, 12U);

  terra::frame::patch_surface_mesh rejected;
  expect(terra::frame::make_cylindrical_patch_surface(
             root_cut.patches.front(), 0U, 257U, radius,
             rejected) == terra::frame::surface_mesh_status::invalid_argument,
         "surface allocation limit changed");
  expect(texture_patterns_seen.size() == 8U && irregular_texture_grids > 0U,
      "texture pattern coverage omitted orientations or truncated grids");
  float untouched[2] = {-999.0F,-999.0F};
  expect(!terra::frame::texture_grid_pattern{64U,8U}.sample(0U,1U,untouched) &&
      untouched[0] == -999.0F && untouched[1] == -999.0F, "invalid texture pattern accepted");
  return 0;
}
