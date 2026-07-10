#include <vic/cbdam/base/byte_array_accessor.hpp>
#include <vic/cbdam/base/color_rgb.hpp>
#include <vic/cbdam/base/coordinate_transform.hpp>
#include <vic/cbdam/base/delta_codec.hpp>
#include <vic/cbdam/base/diamond_operator.hpp>
#include <vic/cbdam/base/diamond_vertices.hpp>
#include <vic/cbdam/base/grid_diamond.hpp>
#include <vic/cbdam/base/grid_diamond_state.hpp>
#include <vic/cbdam/base/null_compressor.hpp>
#include <vic/cbdam/base/priority_diamond.hpp>
#include <vic/cbdam/base/raw_image.hpp>
#include <vic/cbdam/base/ray.hpp>
#include <vic/cbdam/base/reference_counted_cache.hpp>
#include <vic/cbdam/base/repository_parameters.hpp>
#include <vic/cbdam/base/triangulate.hpp>

#include <sl/buffer_serializer.hpp>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

int fail(const std::string& message) {
  std::cerr << "CBDAM SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected) {
  return std::fabs(actual - expected) < 1e-9;
}

bool near_point(const cbdam::coordinate_transform::point3d_t& actual,
                double x, double y, double z) {
  return near(actual[0], x) && near(actual[1], y) && near(actual[2], z);
}

bool near_vector(const cbdam::coordinate_transform::vector3d_t& actual,
                 double x, double y, double z) {
  return near(actual[0], x) && near(actual[1], y) && near(actual[2], z);
}

bool same_grid_point(const cbdam::grid_point_t& actual,
                     cbdam::grid_value_t x,
                     cbdam::grid_value_t y,
                     cbdam::grid_value_t z) {
  return actual[0] == x && actual[1] == y && actual[2] == z;
}

template <class Point>
double triangle_area(const Point& a, const Point& b, const Point& c) {
  return 0.5 * std::fabs((b[0] - a[0]) * (c[1] - a[1]) -
                         (b[1] - a[1]) * (c[0] - a[0]));
}

int check_grid_diamond_topology() {
  const cbdam::grid_value_t lo = cbdam::min_grid_coord();
  const cbdam::grid_value_t hi = cbdam::max_grid_coord();

  if (!same_grid_point(cbdam::midpoint(cbdam::min_grid_point(),
                                       cbdam::max_grid_point()),
                       0, 0, 0)) {
    return fail("grid midpoint contract changed");
  }

  cbdam::grid_diamond root = cbdam::grid_diamond::canonical_root(0);
  if (!root.is_valid() ||
      root.corner(0) != cbdam::grid_canonical_point(0) ||
      root.corner(1) != cbdam::grid_canonical_point(1) ||
      root.corner(2) != cbdam::grid_canonical_point(2) ||
      root.corner(3) != cbdam::grid_canonical_point(3)) {
    return fail("grid diamond canonical root changed");
  }
  if (!same_grid_point(root.id(), 0, 0, hi) ||
      root.parent_id(0) != cbdam::grid_canonical_point(1) ||
      root.parent_id(1) != cbdam::grid_canonical_point(3)) {
    return fail("grid diamond root id/parent id changed");
  }
  if (!root.subdividable() || root.key() != root) {
    return fail("grid diamond subdividable/key contract changed");
  }

  const cbdam::grid_point_t child00 = root.child_id(0, 0);
  const cbdam::grid_point_t child01 = root.child_id(0, 1);
  const cbdam::grid_point_t child10 = root.child_id(1, 0);
  const cbdam::grid_point_t child11 = root.child_id(1, 1);
  if (!same_grid_point(child00, lo, 0, hi) ||
      !same_grid_point(child01, 0, hi, hi) ||
      !same_grid_point(child10, hi, 0, hi) ||
      !same_grid_point(child11, 0, lo, hi)) {
    return fail("grid diamond child id contract changed");
  }

  int child_i = -1;
  int child_j = -1;
  if (!root.child_ij_from_child_id(child10, child_i, child_j) ||
      child_i != 1 || child_j != 0) {
    return fail("grid diamond child id reverse lookup changed");
  }

  cbdam::grid_diamond child = root.canonical_planar_child_diamond(0, 1);
  if (child.id() != child01 ||
      child.fragment_id_deriving_from_parent(root.id()) != 1 ||
      !child.is_valid_fragment(1)) {
    return fail("grid diamond planar child contract changed");
  }

  cbdam::grid_diamond cylindrical =
      cbdam::grid_diamond::cylindrical_canonical_root(0);
  if (!cylindrical.is_valid() ||
      cylindrical.corner(0) != cbdam::grid_cylindrical_canonical_point(2) ||
      cylindrical.corner(2) != cbdam::grid_cylindrical_canonical_point(5)) {
    return fail("grid diamond cylindrical root contract changed");
  }

  return 0;
}

int check_simple_polygon_triangulation() {
  typedef sl::simple_polygon_triangulator<double> triangulator_t;
  typedef triangulator_t::point2_t point2_t;

  std::vector<point2_t> square;
  square.push_back(point2_t(0.0, 0.0));
  square.push_back(point2_t(1.0, 0.0));
  square.push_back(point2_t(1.0, 1.0));
  square.push_back(point2_t(0.0, 1.0));

  if (!near(triangulator_t::area(square), 1.0)) {
    return fail("triangulator polygon area changed");
  }

  std::vector<uint32_t> indices;
  triangulator_t::process(square, indices);
  if (indices.size() != 6) {
    return fail("triangulator convex quad triangle count changed");
  }

  bool used[4] = {false, false, false, false};
  double area_sum = 0.0;
  for (std::size_t i = 0; i < indices.size(); i += 3) {
    if (indices[i] >= square.size() ||
        indices[i + 1] >= square.size() ||
        indices[i + 2] >= square.size()) {
      return fail("triangulator emitted an out-of-range vertex index");
    }
    if (indices[i] == indices[i + 1] ||
        indices[i] == indices[i + 2] ||
        indices[i + 1] == indices[i + 2]) {
      return fail("triangulator emitted a degenerate triangle");
    }
    used[indices[i]] = true;
    used[indices[i + 1]] = true;
    used[indices[i + 2]] = true;
    area_sum += triangle_area(square[indices[i]],
                              square[indices[i + 1]],
                              square[indices[i + 2]]);
  }
  if (!used[0] || !used[1] || !used[2] || !used[3] ||
      !near(area_sum, 1.0)) {
    return fail("triangulator convex quad coverage changed");
  }

  std::vector<point2_t> reversed;
  reversed.push_back(square[3]);
  reversed.push_back(square[2]);
  reversed.push_back(square[1]);
  reversed.push_back(square[0]);
  if (!near(triangulator_t::area(reversed), -1.0)) {
    return fail("triangulator clockwise polygon area changed");
  }

  indices.clear();
  triangulator_t::process(reversed, indices);
  if (indices.size() != 6) {
    return fail("triangulator clockwise quad triangle count changed");
  }

  std::vector<point2_t> too_small;
  too_small.push_back(point2_t(0.0, 0.0));
  too_small.push_back(point2_t(1.0, 0.0));
  triangulator_t::process(too_small, indices);
  if (!indices.empty()) {
    return fail("triangulator accepted a polygon with fewer than 3 vertices");
  }

  return 0;
}

int check_reference_counted_cache_lifecycle() {
  typedef cbdam::reference_counted_object<int> data_t;
  typedef cbdam::reference_counted_cache_base<int, data_t> cache_t;
  typedef cbdam::reference_counted_pointer<data_t> pointer_t;

  cache_t cache;
  cache.set_capacity(1);
  if (cache.capacity() != 1 || cache.size() != 0) {
    return fail("reference_counted_cache initial state changed");
  }

  data_t* first = new data_t(&cache, new int(7), 11);
  cache.insert(1, first);
  if (cache.size() != 1 || cache[1] != first ||
      !cache[1]->object() || *cache[1]->object() != 7 ||
      cache[1]->global_time_stamp() != 11) {
    return fail("reference_counted_cache insert/access changed");
  }

  {
    pointer_t held(cache[1]);
    if (!held || held.raw_pointer() != first ||
        held.use_count() != 1 || !held.is_unique()) {
      return fail("reference_counted_pointer first reference changed");
    }
    {
      pointer_t copy(held);
      if (held.use_count() != 2 || copy.use_count() != 2 ||
          copy.raw_pointer() != held.raw_pointer()) {
        return fail("reference_counted_pointer copy semantics changed");
      }
    }
    if (held.use_count() != 1 || !held.is_unique()) {
      return fail("reference_counted_pointer copy release changed");
    }

    data_t* replacement = new data_t(&cache, new int(8), 12);
    cache.insert(1, replacement);
    if (cache.size() != 1 || cache[1] != replacement ||
        *cache[1]->object() != 8 || cache[1]->global_time_stamp() != 12) {
      return fail("reference_counted_cache replacement changed");
    }
    if (held.raw_pointer() != first || !held->object() ||
        *held->object() != 7 || held.use_count() != 1) {
      return fail("reference_counted_cache delayed release changed");
    }

    cache.minimize_footprint();
    if (cache.size() != 0 || !held->object() ||
        *held->object() != 7 || held.use_count() != 1) {
      return fail("reference_counted_cache footprint minimization changed");
    }
  }

  cache.minimize_footprint();
  if (cache.size() != 0) {
    return fail("reference_counted_cache final cleanup changed");
  }

  return 0;
}

int check_diamond_operator_and_color_arithmetic() {
  if (cbdam::average(1, 2, 3, 4) != 3 ||
      cbdam::average(-1, -2, -3, -4) != -3 ||
      cbdam::half_average(4, 4, 4, 4) != 2 ||
      cbdam::median(1, 100, 3, 4) != 4 ||
      cbdam::half_median(1, 100, 3, 4) != 2 ||
      cbdam::half_cisl_inf(-6, -2, 8, 4) != 0) {
    return fail("diamond_operator scalar rounding helpers changed");
  }

  if (cbdam::neville4(0, 1, 2, 0,
                      3, 4, 5, 6,
                      7, 8, 9, 10,
                      0, 11, 12, 0) != 7 ||
      cbdam::half_neville4(0, 1, 2, 0,
                           3, 4, 5, 6,
                           7, 8, 9, 10,
                           0, 11, 12, 0) != 3) {
    return fail("diamond_operator neville4 helpers changed");
  }

  cbdam::color_rgb base(250, 10, 100);
  cbdam::delta_color3_t delta(10, -20, 200);
  cbdam::color_rgb clamped = base + delta;
  if (clamped[0] != 255 || clamped[1] != 0 || clamped[2] != 255) {
    return fail("color_rgb delta clamp addition changed");
  }

  cbdam::color_rgb sum = cbdam::color_rgb(200, 30, 100) +
                         cbdam::color_rgb(100, 40, 200);
  if (sum[0] != 255 || sum[1] != 70 || sum[2] != 255) {
    return fail("color_rgb color clamp addition changed");
  }

  cbdam::delta_color3_t difference =
      cbdam::color_rgb(20, 40, 60) - cbdam::color_rgb(10, 50, 80);
  if (difference[0] != 10 || difference[1] != -10 || difference[2] != -20) {
    return fail("color_rgb color difference changed");
  }

  cbdam::color_rgb scaled = cbdam::color_rgb(20, 100, 200) * 1.5f;
  if (scaled[0] != 30 || scaled[1] != 150 || scaled[2] != 255) {
    return fail("color_rgb scalar clamp multiplication changed");
  }

  cbdam::color_rgba_t rgba = static_cast<cbdam::color_rgba_t>(
      cbdam::color_rgb(1, 2, 3));
  if (rgba[0] != 1 || rgba[1] != 2 || rgba[2] != 3 || rgba[3] != 255) {
    return fail("color_rgb RGBA conversion changed");
  }

  return 0;
}

int check_diamond_operator_analysis_synthesis_roundtrip() {
  typedef cbdam::height_operator operator_t;
  typedef operator_t::array2_t array2_t;

  array2_t p(4, 4);
  array2_t q(3, 3);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      p(y, x) = 10 * y + x;
    }
  }
  for (int y = 0; y < 3; ++y) {
    for (int x = 0; x < 3; ++x) {
      q(y, x) = 100 + 10 * y + x;
    }
  }

  array2_t l(4, 4);
  array2_t h(3, 3);
  operator_t::analysis_in(l, h, p, q);

  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      if ((y == 0 || x == 0 || y == 3 || x == 3) &&
          l(y, x) != p(y, x)) {
        return fail("diamond_operator low-pass boundary contract changed");
      }
    }
  }
  if (h(0, 0) != q(0, 0) - operator_t::quincunx_predict(p, 0, 0) ||
      l(1, 1) != p(1, 1) + operator_t::quincunx_half_update(h, 1, 1)) {
    return fail("diamond_operator analysis coefficients changed");
  }

  array2_t restored_p(4, 4);
  array2_t restored_q(3, 3);
  operator_t::synthesis_in(restored_p, restored_q, l, h);

  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      if (restored_p(y, x) != p(y, x)) {
        return fail("diamond_operator synthesis low-pass roundtrip changed");
      }
    }
  }
  for (int y = 0; y < 3; ++y) {
    for (int x = 0; x < 3; ++x) {
      if (restored_q(y, x) != q(y, x)) {
        return fail("diamond_operator synthesis high-pass roundtrip changed");
      }
    }
  }

  return 0;
}

int check_grid_diamond_state_flags_and_serialization() {
  cbdam::grid_diamond_state state;
  if (state.is_leaf() || state.has_fragment(0) || state.has_fragment(1)) {
    return fail("grid_diamond_state default flags changed");
  }

  state.set_is_leaf(true);
  state.set_has_fragment(0, true);
  state.set_has_fragment(1, false);
  if (!state.is_leaf() || !state.has_fragment(0) || state.has_fragment(1)) {
    return fail("grid_diamond_state flag setters changed");
  }

  state.set_is_leaf(false);
  state.set_has_fragment(1, true);
  if (state.is_leaf() || !state.has_fragment(0) || !state.has_fragment(1)) {
    return fail("grid_diamond_state flag update contract changed");
  }

  if (!(cbdam::grid_diamond_state(false, false, false) <
        cbdam::grid_diamond_state(true, false, false)) ||
      !(cbdam::grid_diamond_state(true, false, false) <
        cbdam::grid_diamond_state(false, true, false)) ||
      !(cbdam::grid_diamond_state(false, true, false) <
        cbdam::grid_diamond_state(false, false, true))) {
    return fail("grid_diamond_state flag ordering changed");
  }

  sl::output_buffer_serializer out;
  state.store_to(out);
  if (out.buffer_size() != 1) {
    return fail("grid_diamond_state serialized size changed");
  }

  sl::input_buffer_serializer in;
  in.buffer() = out.buffer();
  cbdam::grid_diamond_state restored;
  restored.retrieve_from(in);
  if (restored.is_leaf() != state.is_leaf() ||
      restored.has_fragment(0) != state.has_fragment(0) ||
      restored.has_fragment(1) != state.has_fragment(1) ||
      !in.off()) {
    return fail("grid_diamond_state serialization roundtrip changed");
  }

  return 0;
}

int check_delta_codec_root_distribution() {
  typedef cbdam::delta_codec<cbdam::height_operator,
                             cbdam::diamond_vertices> codec_t;

  codec_t codec;
  codec.init(2);

  codec_t::array2_t offset(3, 3);
  for (int y = 0; y < 3; ++y) {
    for (int x = 0; x < 3; ++x) {
      offset(y, x) = 10 * y + x;
    }
  }

  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices root0(&owner, 6, false);
  cbdam::diamond_vertices root1(&owner, 6, false);
  codec.distribute_data_to_root(offset,
                                cbdam::grid_diamond::canonical_root(0),
                                &root0,
                                &root1);

  const int32_t expected_root0[] = {0, 1, 2, 10, 11, 20};
  const int32_t expected_root1[] = {22, 21, 20, 12, 11, 2};
  for (std::size_t i = 0; i < 6; ++i) {
    if (root0.values()[i] != expected_root0[i]) {
      return fail("delta_codec root0 patch distribution changed");
    }
    if (root1.values()[i] != expected_root1[i]) {
      return fail("delta_codec root1 patch distribution changed");
    }
  }

  return 0;
}

int check_null_compressor_patch_roundtrip() {
  typedef cbdam::null_compressor<int32_t> compressor_t;

  compressor_t compressor;
  compressor_t::array2_t input(2, 3);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 3; ++x) {
      input(y, x) = 100 * y + x;
    }
  }

  compressor_t::data_buffer_t compressed;
  compressor.compress_to(compressed, input);
  if (compressed.size() != 2 * sizeof(uint32_t) + 6 * sizeof(int32_t)) {
    return fail("null_compressor serialized size changed");
  }

  const uint8_t* cursor = &compressed[0];
  uint32_t height = 0;
  uint32_t width = 0;
  std::memcpy(&height, cursor, sizeof(uint32_t));
  cursor += sizeof(uint32_t);
  std::memcpy(&width, cursor, sizeof(uint32_t));
  cursor += sizeof(uint32_t);
  if (height != 2 || width != 3) {
    return fail("null_compressor serialized dimensions changed");
  }

  const int32_t expected_values[] = {0, 1, 2, 100, 101, 102};
  for (std::size_t i = 0; i < 6; ++i) {
    int32_t value = 0;
    std::memcpy(&value, cursor, sizeof(int32_t));
    cursor += sizeof(int32_t);
    if (value != expected_values[i]) {
      return fail("null_compressor serialized row-major layout changed");
    }
  }

  compressor_t::array2_t output;
  compressor.decompress_to(
      output, &compressed[0], static_cast<uint32_t>(compressed.size()));
  if (output.extent()[0] != 2 || output.extent()[1] != 3) {
    return fail("null_compressor decompressed dimensions changed");
  }
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 3; ++x) {
      if (output(y, x) != input(y, x)) {
        return fail("null_compressor decompressed values changed");
      }
    }
  }

  return 0;
}

int check_diamond_vertices_ray_intersection() {
  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices vertices(&owner, 3);
  vertices.diamond_center() = cbdam::point3d_t(0.0, 0.0, 0.0);
  vertices.gl_points()[0] = cbdam::diamond_vertices::point3_t(0.0f, 0.0f, 0.0f);
  vertices.gl_points()[1] = cbdam::diamond_vertices::point3_t(1.0f, 0.0f, 0.0f);
  vertices.gl_points()[2] = cbdam::diamond_vertices::point3_t(0.0f, 1.0f, 0.0f);

  cbdam::normald_t normal;
  const std::pair<bool, double> hit = vertices.patch_ray_intersection(
      cbdam::point3d_t(0.25, 0.25, 1.0),
      cbdam::point3d_t(0.25, 0.25, -1.0),
      1,
      &normal);
  if (!hit.first || !near(hit.second, 0.5) ||
      !near(std::fabs(normal[2]), 1.0)) {
    return fail("diamond_vertices ray hit contract changed");
  }

  const std::pair<bool, double> miss = vertices.patch_ray_intersection(
      cbdam::point3d_t(1.25, 1.25, 1.0),
      cbdam::point3d_t(1.25, 1.25, -1.0),
      1,
      0);
  if (miss.first) {
    return fail("diamond_vertices ray miss contract changed");
  }

  return 0;
}

int check_ray_intersections() {
  cbdam::ray point_ray(cbdam::point3d_t(1.0, 2.0, 3.0),
                       cbdam::vector3d_t(0.5, -1.0, 2.0),
                       0.0,
                       10.0);
  if (!near_point(point_ray.point_at(2.0), 2.0, 0.0, 7.0)) {
    return fail("ray point_at contract changed");
  }

  cbdam::ray triangle_ray(cbdam::point3d_t(0.25, 0.25, 1.0),
                          cbdam::vector3d_t(0.0, 0.0, -1.0),
                          0.0,
                          10.0);
  bool hit = false;
  double t = 0.0;
  double u = 0.0;
  double v = 0.0;
  cbdam::normald_t normal;
  triangle_ray.closest_triangle_intersection(cbdam::point3d_t(0.0, 0.0, 0.0),
                                             cbdam::point3d_t(1.0, 0.0, 0.0),
                                             cbdam::point3d_t(0.0, 1.0, 0.0),
                                             hit,
                                             t,
                                             u,
                                             v,
                                             &normal);
  if (!hit || !near(t, 1.0) || !near(u, 0.25) || !near(v, 0.25) ||
      !near(triangle_ray.t_far(), 1.0) || !near(std::fabs(normal[2]), 1.0)) {
    return fail("ray triangle intersection contract changed");
  }

  cbdam::ray short_ray(cbdam::point3d_t(0.25, 0.25, 1.0),
                       cbdam::vector3d_t(0.0, 0.0, -1.0),
                       0.0,
                       0.5);
  short_ray.closest_triangle_intersection(cbdam::point3d_t(0.0, 0.0, 0.0),
                                          cbdam::point3d_t(1.0, 0.0, 0.0),
                                          cbdam::point3d_t(0.0, 1.0, 0.0),
                                          hit,
                                          t,
                                          u,
                                          v);
  if (hit || !near(short_ray.t_far(), 0.5)) {
    return fail("ray triangle distance rejection changed");
  }

  cbdam::ray sphere_ray(cbdam::point3d_t(0.0, 0.0, 0.0),
                        cbdam::vector3d_t(1.0, 0.0, 0.0),
                        0.0,
                        10.0);
  if (!sphere_ray.sphere_intersection(cbdam::point3d_t(5.0, 0.0, 0.0),
                                      1.0,
                                      t) ||
      !near(t, 4.0)) {
    return fail("ray sphere outside intersection changed");
  }
  if (!sphere_ray.sphere_intersection(cbdam::point3d_t(0.0, 0.0, 0.0),
                                      2.0,
                                      t) ||
      !near(t, 2.0)) {
    return fail("ray sphere inside intersection changed");
  }
  if (sphere_ray.sphere_intersection(cbdam::point3d_t(0.0, 3.0, 0.0),
                                     1.0,
                                     t)) {
    return fail("ray sphere miss contract changed");
  }

  return 0;
}

int check_priority_diamond_ordering() {
  typedef std::pair<cbdam::priority_diamond, cbdam::grid_point_t> queue_item_t;

  cbdam::refine_less refine_less;
  cbdam::coarsen_less coarsen_less;

  const cbdam::grid_point_t id0(0, 0, 0);
  const cbdam::grid_point_t id1(1, 0, 0);

  const queue_item_t hidden_high(
      cbdam::priority_diamond(10.0f, false, 2), id0);
  const queue_item_t visible_low(
      cbdam::priority_diamond(1.0f, true, 2), id0);
  if (!refine_less(hidden_high, visible_low) ||
      refine_less(visible_low, hidden_high)) {
    return fail("priority_diamond visibility ordering changed");
  }

  const queue_item_t visible_lower(
      cbdam::priority_diamond(1.0f, true, 2), id0);
  const queue_item_t visible_higher(
      cbdam::priority_diamond(2.0f, true, 2), id0);
  if (!refine_less(visible_lower, visible_higher) ||
      refine_less(visible_higher, visible_lower)) {
    return fail("priority_diamond refine priority ordering changed");
  }
  if (coarsen_less(visible_lower, visible_higher) !=
          refine_less(visible_higher, visible_lower) ||
      coarsen_less(visible_higher, visible_lower) !=
          refine_less(visible_lower, visible_higher)) {
    return fail("priority_diamond coarsen reverse ordering changed");
  }

  const queue_item_t tie0(cbdam::priority_diamond(1.0f, true, 2), id0);
  const queue_item_t tie1(cbdam::priority_diamond(1.0f, true, 2), id1);
  if (refine_less(tie0, tie1) != (id0 < id1) ||
      refine_less(tie1, tie0) != (id1 < id0)) {
    return fail("priority_diamond grid id tie-break ordering changed");
  }

  return 0;
}

int check_planar_coordinate_transform() {
  cbdam::coordinate_transform::aabox_t box(
      cbdam::coordinate_transform::point2d_t(10.0, 20.0),
      cbdam::coordinate_transform::point2d_t(110.0, 220.0));
  cbdam::planar_coordinate_transform transform(box);

  if (!transform.is_planar() || transform.root_count() != 1) {
    return fail("planar coordinate transform identity changed");
  }

  cbdam::coordinate_transform::point3d_t uvh(30.0, 40.0, 5.0);
  if (!near_point(transform.xyz_from_uvh(uvh), 30.0, 40.0, 5.0) ||
      !near_point(transform.uvh_from_xyz(uvh), 30.0, 40.0, 5.0)) {
    return fail("planar coordinate transform uvh/xyz roundtrip changed");
  }
  if (!near_point(transform.xyz_on_ground(uvh), 30.0, 40.0, 0.0) ||
      !near(transform.altitude_from_xyz(uvh), 5.0)) {
    return fail("planar coordinate transform altitude/ground changed");
  }
  if (!near_vector(transform.up_from_uvh(uvh), 0.0, 0.0, 1.0) ||
      !near_vector(transform.north_from_uvh(uvh), 0.0, 1.0, 0.0) ||
      !near_vector(transform.east_from_uvh(uvh), 1.0, 0.0, 0.0)) {
    return fail("planar coordinate transform orientation vectors changed");
  }

  cbdam::coordinate_transform::point2d_t uv_min =
      transform.uv_from_grid(cbdam::min_grid_point());
  cbdam::coordinate_transform::point2d_t uv_max =
      transform.uv_from_grid(cbdam::max_grid_point());
  if (!near(uv_min[0], 10.0) || !near(uv_min[1], 20.0) ||
      !near(uv_max[0], 110.0) || !near(uv_max[1], 220.0)) {
    return fail("planar coordinate transform grid mapping changed");
  }

  cbdam::coordinate_transform::point2d_t p0(10.0, 20.0);
  cbdam::coordinate_transform::point2d_t p1(13.0, 24.0);
  if (!near(transform.uv_distance_between(p0, p1), 5.0)) {
    return fail("planar coordinate transform uv distance changed");
  }

  std::vector<cbdam::coordinate_transform::aabox_t> boxes;
  transform.uv_box_containing(
      boxes,
      cbdam::coordinate_transform::point2d_t(10.0, 20.0),
      cbdam::coordinate_transform::point2d_t(11.0, 25.0),
      cbdam::coordinate_transform::point2d_t(30.0, 22.0),
      cbdam::coordinate_transform::point2d_t(25.0, 40.0));
  if (boxes.size() != 1 ||
      !near(boxes[0][0][0], 10.0) || !near(boxes[0][0][1], 20.0) ||
      !near(boxes[0][1][0], 30.0) || !near(boxes[0][1][1], 40.0)) {
    return fail("planar coordinate transform uv box containing changed");
  }

  cbdam::coordinate_transform* clone = transform.clone();
  const bool clone_ok =
      clone && clone->is_planar() && clone->root_count() == 1 &&
      near(clone->bounding_rectangle()[0][0], 10.0) &&
      near(clone->bounding_rectangle()[1][1], 220.0);
  delete clone;
  if (!clone_ok) {
    return fail("planar coordinate transform clone changed");
  }

  return 0;
}

int check_spherical_coordinate_transform() {
  cbdam::spherical_coordinate_transform transform(10.0);
  if (transform.is_planar() || transform.root_count() != 6 ||
      !near(transform.radius(), 10.0)) {
    return fail("spherical coordinate transform identity changed");
  }

  cbdam::coordinate_transform::point3d_t uvh(0.0, 0.0, 2.0);
  cbdam::coordinate_transform::point3d_t xyz = transform.xyz_from_uvh(uvh);
  if (!near_point(xyz, 0.0, 0.0, 12.0) ||
      !near_point(transform.uvh_from_xyz(xyz), 0.0, 0.0, 2.0) ||
      !near_point(transform.xyz_on_ground(xyz), 0.0, 0.0, 10.0) ||
      !near(transform.altitude_from_xyz(xyz), 2.0)) {
    return fail("spherical coordinate transform uvh/xyz roundtrip changed");
  }
  if (!near_vector(transform.up_from_uvh(uvh), 0.0, 0.0, 1.0) ||
      !near_vector(transform.north_from_uvh(uvh), 0.0, 1.0, 0.0) ||
      !near_vector(transform.east_from_uvh(uvh), 1.0, 0.0, 0.0)) {
    return fail("spherical coordinate transform orientation vectors changed");
  }

  if (!near(transform.uv_distance_between(
                cbdam::coordinate_transform::point2d_t(179.0, 0.0),
                cbdam::coordinate_transform::point2d_t(-179.0, 0.0)),
            2.0)) {
    return fail("spherical coordinate transform longitude wrap distance changed");
  }

  cbdam::coordinate_transform* clone = transform.clone();
  const bool clone_ok =
      clone && !clone->is_planar() && clone->root_count() == 6 &&
      near_point(clone->xyz_from_uvh(uvh), 0.0, 0.0, 12.0);
  delete clone;
  if (!clone_ok) {
    return fail("spherical coordinate transform clone changed");
  }

  return 0;
}

int check_cylindrical_coordinate_transform() {
  cbdam::cylindrical_coordinate_transform transform(10.0);
  if (transform.is_planar() || transform.root_count() != 8 ||
      !near(transform.radius(), 10.0)) {
    return fail("cylindrical coordinate transform identity changed");
  }

  cbdam::coordinate_transform::point2d_t uv =
      transform.uv_from_grid(cbdam::grid_cylindrical_canonical_point(0));
  if (!near(uv[0], -180.0) || !near(uv[1], -90.0)) {
    return fail("cylindrical coordinate transform canonical grid mapping changed");
  }

  cbdam::coordinate_transform* clone = transform.clone();
  const bool clone_ok =
      clone && !clone->is_planar() && clone->root_count() == 8 &&
      near(clone->uv_from_grid(cbdam::grid_cylindrical_canonical_point(0))[0],
           -180.0);
  delete clone;
  if (!clone_ok) {
    return fail("cylindrical coordinate transform clone changed");
  }

  return 0;
}

int check_repository_parameters_roundtrip() {
  const char* file_name = "terra_sdk_cbdam_repository_smoke.xml";
  std::remove(file_name);

  cbdam::coordinate_transform::aabox_t box(
      cbdam::coordinate_transform::point2d_t(10.0, 20.0),
      cbdam::coordinate_transform::point2d_t(110.0, 220.0));
  cbdam::planar_coordinate_transform transform(box);
  cbdam::repository_parameters written(
      17, 2.5, &transform, "EPSG:4326", "SDK smoke repository");

  written.write_to_file(file_name);
  if (!written.last_operation_success()) {
    std::remove(file_name);
    return fail("failed to write repository parameters");
  }

  cbdam::repository_parameters read;
  read.read_from_file(file_name);
  std::remove(file_name);

  if (!read.last_operation_success()) {
    return fail("failed to read repository parameters");
  }
  if (read.patch_dim() != 17 || !near(read.height_scale_factor(), 2.5)) {
    return fail("repository numeric parameters changed");
  }
  if (read.srs() != "EPSG:4326" || read.about() != "SDK smoke repository") {
    return fail("repository string parameters changed");
  }
  if (!read.is_planar() || !read.get_coordinate_transform()) {
    return fail("repository planar coordinate transform missing");
  }

  const cbdam::coordinate_transform::aabox_t& read_box =
      read.get_coordinate_transform()->bounding_rectangle();
  if (!near(read_box[0][0], 10.0) || !near(read_box[0][1], 20.0) ||
      !near(read_box[1][0], 110.0) || !near(read_box[1][1], 220.0)) {
    return fail("repository coordinate transform bbox changed");
  }

  cbdam::coordinate_transform::point3d_t uvh(30.0, 40.0, 5.0);
  cbdam::coordinate_transform::point3d_t xyz =
      read.get_coordinate_transform()->xyz_from_uvh(uvh);
  if (!near(xyz[0], 30.0) || !near(xyz[1], 40.0) || !near(xyz[2], 5.0)) {
    return fail("planar coordinate transform xyz_from_uvh changed");
  }

  return 0;
}

int check_raw_image_sampling_and_roundtrip() {
  cbdam::raw_image image(4, 4);
  if (!image.is_open() || image.height() != 4 || image.width() != 4) {
    return fail("raw_image temporary image dimensions changed");
  }

  image.set_value(100);
  image.set_value_at(0, 0, 0);
  image.set_value_at(0, 1, 10);
  image.set_value_at(1, 0, 20);
  image.set_value_at(1, 1, 30);
  image.set_value_at(3, 3, 77);

  if (image(0, 0) != 0 || image(1, 1) != 30 || image(3, 3) != 77) {
    return fail("raw_image direct value access changed");
  }
  if (image.value_at_parametric_coords(1.0f / 6.0f, 1.0f / 6.0f) != 15) {
    return fail("raw_image bilinear sampling changed");
  }
  if (image.value_at_parametric_coords(1.0f, 1.0f) != 77) {
    return fail("raw_image edge sampling changed");
  }

  const char* file_name = "terra_sdk_cbdam_raw_image_smoke.raw";
  std::remove(file_name);
  {
    cbdam::raw_image written;
    written.open_to_write(3, 5, file_name);
    if (!written.is_open() || written.height() != 3 || written.width() != 5) {
      std::remove(file_name);
      return fail("raw_image persistent write open changed");
    }
    written.set_value_at(0, 0, -7);
    written.set_value_at(2, 4, 42);
    written.close();
  }
  {
    cbdam::raw_image read;
    read.open_to_read(file_name);
    std::remove(file_name);
    if (!read.is_open() || read.height() != 3 || read.width() != 5) {
      return fail("raw_image persistent read header changed");
    }
    if (read(0, 0) != -7 || read(2, 4) != 42) {
      return fail("raw_image persistent data roundtrip changed");
    }
  }

  return 0;
}

int check_byte_array_accessor_layout() {
  std::vector<uint8_t> buffer(sizeof(uint32_t) + 5 + 3, 0);

  cbdam::byte_array_accessor::set_first_patch_size(&buffer[0], 5);
  for (int i = 0; i < 5; ++i) {
    buffer[sizeof(uint32_t) + i] = static_cast<uint8_t>(10 + i);
  }
  for (int i = 0; i < 3; ++i) {
    buffer[sizeof(uint32_t) + 5 + i] = static_cast<uint8_t>(20 + i);
  }

  if (!cbdam::byte_array_accessor::sanity_check(
          &buffer[0], static_cast<uint32_t>(buffer.size()))) {
    return fail("byte_array_accessor rejected a valid patch buffer");
  }
  if (cbdam::byte_array_accessor::first_patch_size(&buffer[0]) != 5 ||
      cbdam::byte_array_accessor::second_patch_size(
          &buffer[0], static_cast<uint32_t>(buffer.size())) != 3) {
    return fail("byte_array_accessor patch size layout changed");
  }

  uint8_t* first = cbdam::byte_array_accessor::first_patch_pointer(&buffer[0]);
  uint8_t* second =
      cbdam::byte_array_accessor::second_patch_pointer(&buffer[0]);
  if (first != &buffer[sizeof(uint32_t)] ||
      second != &buffer[sizeof(uint32_t) + 5]) {
    return fail("byte_array_accessor patch pointer layout changed");
  }
  if (first[0] != 10 || first[4] != 14 ||
      second[0] != 20 || second[2] != 22) {
    return fail("byte_array_accessor patch payload access changed");
  }

  cbdam::byte_array_accessor::set_first_patch_size(&buffer[0], 99);
  if (cbdam::byte_array_accessor::sanity_check(
          &buffer[0], static_cast<uint32_t>(buffer.size()))) {
    return fail("byte_array_accessor accepted an oversized first patch");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_grid_diamond_topology()) {
    return status;
  }
  if (int status = check_simple_polygon_triangulation()) {
    return status;
  }
  if (int status = check_reference_counted_cache_lifecycle()) {
    return status;
  }
  if (int status = check_diamond_operator_and_color_arithmetic()) {
    return status;
  }
  if (int status = check_diamond_operator_analysis_synthesis_roundtrip()) {
    return status;
  }
  if (int status = check_grid_diamond_state_flags_and_serialization()) {
    return status;
  }
  if (int status = check_delta_codec_root_distribution()) {
    return status;
  }
  if (int status = check_null_compressor_patch_roundtrip()) {
    return status;
  }
  if (int status = check_diamond_vertices_ray_intersection()) {
    return status;
  }
  if (int status = check_ray_intersections()) {
    return status;
  }
  if (int status = check_priority_diamond_ordering()) {
    return status;
  }
  if (int status = check_planar_coordinate_transform()) {
    return status;
  }
  if (int status = check_spherical_coordinate_transform()) {
    return status;
  }
  if (int status = check_cylindrical_coordinate_transform()) {
    return status;
  }
  if (int status = check_repository_parameters_roundtrip()) {
    return status;
  }
  if (int status = check_raw_image_sampling_and_roundtrip()) {
    return status;
  }
  if (int status = check_byte_array_accessor_layout()) {
    return status;
  }
  std::cout
      << "SDK smoke passed: vic_core_cbdam_base grid diamonds, triangulation, reference_counted_cache, diamond_operator, color_rgb, wavelet_roundtrip, grid_diamond_state, delta_codec, null_compressor, diamond_vertices, ray intersections, priority_diamond, coordinate transforms, repository_parameters, raw_image, and byte_array_accessor"
      << std::endl;
  return 0;
}
