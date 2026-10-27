#include <terra/imagery/adapter.hpp>
#include <terra/frame/imagery.hpp>
#include <terra/frame/surface_mesh.hpp>
#include <terra/frame/camera.hpp>
#include <cmath>
#include <set>
#include <stdexcept>
#include <iostream>

static void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
int main() {
  using namespace terra;
  imagery::texture_model model;
  imagery::source_descriptor source;
  source.id = "test-world";
  for (int level = 0; level <= 18; ++level) source.matrices.push_back(
      {"matrix-" + std::to_string(level + 1), 2 << level, 1 << level});
  const auto roots = core::cylindrical_roots();
  std::set<std::string> fallback;
  for (unsigned i = 0; i < roots.size(); ++i) {
    const auto node = imagery::terrain_anchor(roots[i], 0, 0, true);
    require(node.root(true) == static_cast<int>(i), "desktop root order changed");
    require(model.contains(node), "invalid global root");
    imagery::texture_binding binding;
    require(imagery::bind_node(model, node, source, 1, binding), "native matrix binding failed");
    require(binding.uv_scale[0] == 1 && binding.resource.matrix == "matrix-2", "root mapped to wrong source resolution");
    require(imagery::bind_node(model, node, source, 0, binding), "coarse root fallback unavailable");
    require(binding.uv_scale[0] == 0.5 && binding.uv_scale[1] == 0.5, "fallback UV scale changed");
    fallback.insert(binding.resource.source + "/" + binding.resource.matrix + "/" + std::to_string(binding.resource.column));
    source.top_left = false;
    require(imagery::bind_node(model, node, source, 1, binding) && binding.resource.row == 1-node.row,
            "TMS south-first row mapping failed");
    source.top_left = true;
    const auto odd = roots[i].cylindrical_child_diamond(0, 0);
    require(imagery::terrain_anchor(odd, 1, 0, true).is_valid() &&
            imagery::terrain_anchor(odd, 1, 1, true).is_valid(), "odd diamond lost a fragment anchor");
  }
  require(fallback.size() == 2, "eight roots did not share two coarse resources");
  auto disjoint = source;
  disjoint.extent = {{{0,0}},{{1e-300,1e-300}}};
  imagery::texture_binding rejected;
  require(!imagery::bind_node(model, {0,0,0}, disjoint, 0, rejected),
          "a disjoint source was converted to an overflowing resource address");
  auto camera = frame::globe_camera(6378000.0F, 1280, 720, 0.8F);
  for (float threshold : {0.04F, 0.01F, 0.005F}) {
    const auto cut = frame::select_procedural_cylindrical_lod(6378000, 4, threshold, camera.snapshot());
    for (const auto& patch : cut.patches) for (unsigned fragment = 0; fragment < 2; ++fragment) {
      if (!patch.has_fragment(fragment)) continue;
      frame::patch_surface_mesh mesh;
      require(frame::make_cylindrical_patch_surface(patch, fragment, 4, 6378000, mesh) == frame::surface_mesh_status::ok,
              "topological mesh anchor failed");
      require(mesh.texture_node.level == static_cast<int>(patch.level/2), "geometry/texture depth relation changed");
      for (float value : mesh.texture_uv) require(std::isfinite(value) && value >= -1e-5 && value <= 1.00001,
          "fragment escaped its fixed anchor");
    }
  }
  frame::measurement_region region;region.flags=3U;
  region.value.pixels_per_uv = 600000;
  region.value.projection = {{-500,1000,0, -500,0,0, 1,0,1000}};
  region.value.triangle = {{{{0,0}},{{1,0}},{{1,1}}}};
  const double far_error = frame::imagery_region_error(region, {{{0.5,0.09375}},{{0.5078125,0.1015625}}});
  require(far_error > 50 && far_error < 80, "near-plane error leaked into a distant texture node");
  const double near_error = frame::imagery_region_error(region, {{{0.5,0}},{{0.501,0.001}}});
  require(near_error > 100000, "node-local projection concealed real near-ground demand");
  region.value.uv = {{{0,0}},{{1,1}}};
  region.value.projection = {{0,0,0,0,0,0,1,0,1000}};
  region.flags|=4U;region.value.numerator_bound = 710000;
  const double envelope_far = frame::imagery_region_error(region, {{{0.5,0.09375}},{{0.5078125,0.1015625}}});
  require(envelope_far >= far_error && envelope_far < 80, "compact envelope lost local depth or underestimates demand");
  require(frame::imagery_region_error(region, {{{0.5,0}},{{0.501,0.001}}}) >= near_error,
          "compact near envelope underestimates demand");
  std::cout << "Unified imagery topology, adapters, coarse sharing and local projection passed\n";
}
