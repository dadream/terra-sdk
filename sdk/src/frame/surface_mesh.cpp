#include <terra/frame/surface_mesh.hpp>

#include <terra/core/coordinate_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <new>

namespace terra {
namespace frame {
namespace {

constexpr std::uint32_t maximum_patch_dimension = 256U;

core::vector3d uvh_from_grid(const core::grid_point& point) {
  const double grid_to_degrees =
      90.0 / static_cast<double>(core::grid_coordinate_max);
  const core::grid_value half_root = core::grid_coordinate_max / 2;
  double longitude_grid = 0.0;
  if (point[2] == half_root) {
    longitude_grid = -2.0 * core::grid_coordinate_max +
                     static_cast<double>(point[0] + half_root);
  } else if (point[0] == half_root) {
    longitude_grid = -1.0 * core::grid_coordinate_max +
                     static_cast<double>(-point[2] + half_root);
  } else if (point[2] == -half_root) {
    longitude_grid = static_cast<double>(-point[0] + half_root);
  } else if (point[0] == -half_root) {
    longitude_grid = core::grid_coordinate_max +
                     static_cast<double>(point[2] + half_root);
  }
  return {{longitude_grid * grid_to_degrees,
           static_cast<double>(point[1]) * grid_to_degrees, 0.0}};
}

double longitude_near(double longitude, double reference) {
  if (longitude - reference > 180.0) {
    return longitude - 360.0;
  }
  if (longitude - reference < -180.0) {
    return longitude + 360.0;
  }
  return longitude;
}

core::grid_point interpolated_grid_point(
    const core::grid_point& origin, const core::grid_point& edge_x,
    const core::grid_point& edge_y, std::uint32_t x, std::uint32_t y,
    std::uint32_t dimension) {
  core::grid_point result{{0, 0, 0}};
  for (std::size_t axis = 0U; axis < result.size(); ++axis) {
    const double value =
        static_cast<double>(origin[axis]) +
        (static_cast<double>(edge_x[axis]) -
         static_cast<double>(origin[axis])) * x / dimension +
        (static_cast<double>(edge_y[axis]) -
         static_cast<double>(origin[axis])) * y / dimension;
    result[axis] = static_cast<core::grid_value>(value);
  }
  return result;
}

core::vector3d planar_uvh_from_grid(const core::grid_point& point,
                                    const core::bounds2d& bounds) {
  const double grid_minimum = core::grid_coordinate_min;
  const double grid_span = static_cast<double>(core::grid_coordinate_max) -
                           static_cast<double>(core::grid_coordinate_min);
  const double u_fraction =
      (static_cast<double>(point[0]) - grid_minimum) / grid_span;
  const double v_fraction =
      (static_cast<double>(point[1]) - grid_minimum) / grid_span;
  return {{bounds.minimum[0] +
               u_fraction * (bounds.maximum[0] - bounds.minimum[0]),
           bounds.minimum[1] +
               v_fraction * (bounds.maximum[1] - bounds.minimum[1]),
           0.0}};
}

void texture_coordinates(const core::vector3d& uvh,
                         const core::bounds2d& extent, bool cylindrical,
                         float* output) {
  const double u = cylindrical ? longitude_near(
      uvh[0], 0.5 * (extent.minimum[0] + extent.maximum[0])) : uvh[0];
  output[0] = static_cast<float>((u - extent.minimum[0]) /
      (extent.maximum[0] - extent.minimum[0]));
  output[1] = static_cast<float>((extent.maximum[1] - uvh[1]) /
      (extent.maximum[1] - extent.minimum[1]));
}

constexpr float texture_patterns[8][6] = {
    {0,0,1,0,0,1}, {1,1,0,1,1,0}, {0,1,0,0,1,1}, {1,0,1,1,0,0},
    {0.5F,0.5F,0,0,1,0}, {0.5F,0.5F,1,0,1,1},
    {0.5F,0.5F,1,1,0,1}, {0.5F,0.5F,0,1,0,0}};

bool cylindrical_texture_pattern(const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t dimension, const core::bounds2d& extent, texture_grid_pattern& pattern) {
  const core::grid_point points[] = {patch.corners[(1U + 2U * fragment) % 4U],
      patch.corners[(2U + 2U * fragment) % 4U], patch.corners[(2U * fragment) % 4U]};
  // Exact affine coordinates require an integer lattice throughout this
  // triangle. Odd dimensions and the deepest grids may truncate individual
  // samples; matching only their three corners would be a false identity.
  for (std::size_t point = 1U; point < 3U; ++point)
    for (std::size_t axis = 0U; axis < 3U; ++axis)
      if ((static_cast<std::int64_t>(points[point][axis]) - points[0][axis]) % dimension)
        return false;
  const auto half = core::grid_coordinate_max / 2;
  bool face = false;
  for (const auto axis : {0U, 2U})
    if ((points[0][axis] == half || points[0][axis] == -half) &&
        points[1][axis] == points[0][axis] && points[2][axis] == points[0][axis]) face = true;
  if (!face) return false;
  float corners[6];
  for (std::size_t point = 0U; point < 3U; ++point)
    texture_coordinates(uvh_from_grid(points[point]), extent, true, corners + point * 2U);
  for (std::uint32_t orientation = 0U; orientation < 8U; ++orientation)
    if (std::equal(corners, corners + 6U, texture_patterns[orientation])) {
      pattern = {dimension, orientation};
      return true;
    }
  return false;
}

}  // namespace

namespace {

surface_mesh_status make_cylindrical_patch_surface_impl(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension,
    const codec::height_fragment* heights, double height_scale,
    double radius,
    patch_surface_mesh& output, bool boundary_only = false, bool with_texture = true) {
  output = patch_surface_mesh();
  if (patch_dimension == 0U || patch_dimension > maximum_patch_dimension ||
      !std::isfinite(radius) || radius <= 0.0) {
    return surface_mesh_status::invalid_argument;
  }
  if (fragment > 1U || !patch.has_fragment(fragment)) {
    return surface_mesh_status::invalid_fragment;
  }
  const std::size_t vertex_count =
      (static_cast<std::size_t>(patch_dimension) + 1U) *
      (static_cast<std::size_t>(patch_dimension) + 2U) / 2U;
  if (heights &&
      (heights->dimension != patch_dimension ||
       heights->values.size() != vertex_count ||
       !std::isfinite(height_scale) || height_scale <= 0.0)) {
    return surface_mesh_status::invalid_height;
  }

  const core::grid_diamond diamond(patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]);
  const auto tile = imagery::terrain_anchor(diamond, patch.level, fragment, true);
  const imagery::texture_model model;
  const core::bounds2d tile_extent = model.bounds(tile);
  const double tile_width = tile_extent.maximum[0] - tile_extent.minimum[0];
  const double tile_height = tile_extent.maximum[1] - tile_extent.minimum[1];
  if (!tile.is_valid() || tile_width <= 0.0 || tile_height <= 0.0) {
    return surface_mesh_status::invalid_texture;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    const auto described = describe_patch_surface(patch, fragment, patch_dimension,
        true, radius, core::bounds2d(), output);
    if (described != surface_mesh_status::ok) return described;
    const auto output_vertices = boundary_only ? patch_dimension * 3U : vertex_count;
    output.positions_xyz.reserve(output_vertices * 3U);
    if (with_texture) output.texture_uv.reserve(output_vertices * 2U);
    const core::coordinate_transform transform = core::coordinate_transform::cylindrical(radius);

    const std::size_t first = (1U + 2U * fragment) % 4U;
    const std::size_t second = (2U + 2U * fragment) % 4U;
    const std::size_t third = (0U + 2U * fragment) % 4U;
    const core::grid_point& gp0 = patch.corners[first];
    const core::grid_point& gp1 = patch.corners[second];
    const core::grid_point& gp2 = patch.corners[third];

    std::size_t row_begin = 0U;
    for (std::uint32_t y = 0U; y <= patch_dimension; ++y) {
      const auto last = patch_dimension - y;
      // Row zero is all boundary; later rows contain only their two endpoints.
      const auto stride = boundary_only && y && last ? last : 1U;
      for (std::uint32_t x = 0U; x <= last; x += stride) {
        const auto vertex = row_begin + x;
        const core::grid_point grid = interpolated_grid_point(
            gp0, gp1, gp2, x, y, patch_dimension);
        core::vector3d uvh = uvh_from_grid(grid);
        if (heights) {
          uvh[2] = height_scale * heights->values[vertex];
          if (!std::isfinite(uvh[2]) || radius + uvh[2] <= 0.0) {
            output = patch_surface_mesh();
            return surface_mesh_status::invalid_height;
          }
        }
        const core::vector3d xyz = transform.xyz_from_uvh(uvh);
        output.positions_xyz.push_back(
            static_cast<float>(xyz[0] - output.origin[0]));
        output.positions_xyz.push_back(
            static_cast<float>(xyz[1] - output.origin[1]));
        output.positions_xyz.push_back(
            static_cast<float>(xyz[2] - output.origin[2]));
        if (with_texture) {
          float uv[2];
          texture_coordinates(uvh, tile_extent, true, uv);
          output.texture_uv.insert(output.texture_uv.end(), uv, uv + 2U);
        }
      }
      row_begin += last + 1U;
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output = patch_surface_mesh();
    return surface_mesh_status::resource_limit;
  }
#endif
  return surface_mesh_status::ok;
}

surface_mesh_status make_planar_patch_surface_impl(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension,
    const codec::height_fragment* heights, double height_scale,
    const core::bounds2d& bounds,
    patch_surface_mesh& output, bool boundary_only = false, bool with_texture = true) {
  output = patch_surface_mesh();
  const double width = bounds.maximum[0] - bounds.minimum[0];
  const double height = bounds.maximum[1] - bounds.minimum[1];
  if (patch_dimension == 0U || patch_dimension > maximum_patch_dimension ||
      !std::isfinite(bounds.minimum[0]) ||
      !std::isfinite(bounds.minimum[1]) ||
      !std::isfinite(bounds.maximum[0]) ||
      !std::isfinite(bounds.maximum[1]) || width <= 0.0 || height <= 0.0) {
    return surface_mesh_status::invalid_argument;
  }
  if (fragment > 1U || !patch.has_fragment(fragment)) {
    return surface_mesh_status::invalid_fragment;
  }
  const std::size_t vertex_count =
      (static_cast<std::size_t>(patch_dimension) + 1U) *
      (static_cast<std::size_t>(patch_dimension) + 2U) / 2U;
  if (heights &&
      (heights->dimension != patch_dimension ||
       heights->values.size() != vertex_count ||
       !std::isfinite(height_scale) || height_scale <= 0.0)) {
    return surface_mesh_status::invalid_height;
  }

  const core::grid_diamond diamond(patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]);
  const auto tile = imagery::terrain_anchor(diamond, patch.level, fragment, false);
  imagery::texture_model model;
  model.global = false;
  model.extent = bounds;
  const core::bounds2d tile_extent = model.bounds(tile);
  const double tile_width = tile_extent.maximum[0] - tile_extent.minimum[0];
  const double tile_height = tile_extent.maximum[1] - tile_extent.minimum[1];
  if (!tile.is_valid() || tile_width <= 0.0 || tile_height <= 0.0) {
    return surface_mesh_status::invalid_texture;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    const auto described = describe_patch_surface(patch, fragment, patch_dimension,
        false, 0.0, bounds, output);
    if (described != surface_mesh_status::ok) return described;
    const auto output_vertices = boundary_only ? patch_dimension * 3U : vertex_count;
    output.positions_xyz.reserve(output_vertices * 3U);
    if (with_texture) output.texture_uv.reserve(output_vertices * 2U);

    const std::size_t first = (1U + 2U * fragment) % 4U;
    const std::size_t second = (2U + 2U * fragment) % 4U;
    const std::size_t third = (0U + 2U * fragment) % 4U;
    const core::grid_point& gp0 = patch.corners[first];
    const core::grid_point& gp1 = patch.corners[second];
    const core::grid_point& gp2 = patch.corners[third];

    std::size_t row_begin = 0U;
    for (std::uint32_t y = 0U; y <= patch_dimension; ++y) {
      const auto last = patch_dimension - y;
      // Row zero is all boundary; later rows contain only their two endpoints.
      const auto stride = boundary_only && y && last ? last : 1U;
      for (std::uint32_t x = 0U; x <= last; x += stride) {
        const auto vertex = row_begin + x;
        const core::grid_point grid = interpolated_grid_point(
            gp0, gp1, gp2, x, y, patch_dimension);
        core::vector3d uvh = planar_uvh_from_grid(grid, bounds);
        if (heights) {
          uvh[2] = height_scale * heights->values[vertex];
          if (!std::isfinite(uvh[2])) {
            output = patch_surface_mesh();
            return surface_mesh_status::invalid_height;
          }
        }
        output.positions_xyz.push_back(
            static_cast<float>(uvh[0] - output.origin[0]));
        output.positions_xyz.push_back(
            static_cast<float>(uvh[1] - output.origin[1]));
        output.positions_xyz.push_back(static_cast<float>(uvh[2]));
        if (with_texture) {
          float uv[2];
          texture_coordinates(uvh, tile_extent, false, uv);
          output.texture_uv.insert(output.texture_uv.end(), uv, uv + 2U);
        }
      }
      row_begin += last + 1U;
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output = patch_surface_mesh();
    return surface_mesh_status::resource_limit;
  }
#endif
  return surface_mesh_status::ok;
}

}  // namespace

bool texture_grid_pattern::sample(std::uint32_t first_vertex,
    std::uint32_t vertex_count, float* output) const {
  if (!dimension || dimension > maximum_patch_dimension || orientation >= 8U ||
      vertex_count > maximum_surface_sample_vertices || (vertex_count && !output)) return false;
  const auto total = (dimension + 1U) * (dimension + 2U) / 2U;
  if (first_vertex > total || vertex_count > total - first_vertex) return false;
  const auto& corners = texture_patterns[orientation];
  std::uint32_t y = 0U, x = first_vertex;
  if (!vertex_count) return true;
  while (x > dimension - y) { x -= dimension - y + 1U; ++y; }
  for (std::uint32_t i = 0U; i < vertex_count; ++i) {
    for (std::size_t axis = 0U; axis < 2U; ++axis)
      output[2U * i + axis] = static_cast<float>(corners[axis] +
          (static_cast<double>(corners[2U + axis]) - corners[axis]) * x / dimension +
          (static_cast<double>(corners[4U + axis]) - corners[axis]) * y / dimension);
    if (++x > dimension - y) { x = 0U; ++y; }
  }
  return true;
}

bool describe_cylindrical_texture_pattern(const lod_patch& patch,
    std::uint8_t fragment, std::uint32_t dimension, texture_grid_pattern& pattern) {
  if (!dimension || dimension > maximum_patch_dimension || fragment > 1U || !patch.has_fragment(fragment))
    return false;
  const core::grid_diamond diamond(patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]);
  const auto tile = imagery::terrain_anchor(diamond, patch.level, fragment, true);
  if (!tile.is_valid()) return false;
  return cylindrical_texture_pattern(patch, fragment, dimension,
      imagery::texture_model().bounds(tile), pattern);
}

surface_mesh_status describe_patch_surface(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    bool cylindrical, double radius, const core::bounds2d& bounds,
    patch_surface_mesh& output) {
  output = patch_surface_mesh();
  if (!dimension || dimension > maximum_patch_dimension ||
      (cylindrical && (!std::isfinite(radius) || radius <= 0.0)))
    return surface_mesh_status::invalid_argument;
  if (fragment > 1U || !patch.has_fragment(fragment))
    return surface_mesh_status::invalid_fragment;
  imagery::texture_model model;
  model.global = cylindrical;
  if (!cylindrical) model.extent = bounds;
  const core::grid_diamond diamond(patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]);
  const auto tile = imagery::terrain_anchor(diamond, patch.level, fragment, cylindrical);
  const auto extent = model.bounds(tile);
  if (!tile.is_valid() || !std::isfinite(extent.minimum[0]) || !std::isfinite(extent.minimum[1]) ||
      !std::isfinite(extent.maximum[0]) || !std::isfinite(extent.maximum[1]) ||
      extent.maximum[0] <= extent.minimum[0] || extent.maximum[1] <= extent.minimum[1])
    return surface_mesh_status::invalid_texture;
  output.patch = patch; output.fragment = fragment; output.texture_node = tile;
  output.origin = cylindrical
      ? core::coordinate_transform::cylindrical(radius).xyz_from_uvh(uvh_from_grid(patch.id))
      : planar_uvh_from_grid(patch.id, bounds);
  return surface_mesh_status::ok;
}

surface_mesh_status sample_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    bool cylindrical, double radius, const core::bounds2d& bounds,
    std::uint32_t first_vertex, std::uint32_t vertex_count, float* output) {
  const auto dimension = heights.dimension;
  if (!dimension || dimension > maximum_patch_dimension ||
      vertex_count > maximum_surface_sample_vertices || (vertex_count && !output))
    return surface_mesh_status::invalid_argument;
  const auto total = (dimension + 1U) * (dimension + 2U) / 2U;
  if (first_vertex > total || vertex_count > total - first_vertex)
    return surface_mesh_status::invalid_argument;
  if (heights.values.size() != total || !std::isfinite(height_scale) || height_scale <= 0.0)
    return surface_mesh_status::invalid_height;
  patch_surface_mesh description;
  const auto status = describe_patch_surface(patch, fragment, dimension,
      cylindrical, radius, bounds, description);
  if (status != surface_mesh_status::ok) return status;
  // Checking all requested heights first makes rejection atomic, without a
  // temporary vertex array. Other slices are validated when they are read.
  for (std::uint32_t i = 0U; i < vertex_count; ++i) {
    const auto height = height_scale * heights.values[first_vertex + i];
    if (!std::isfinite(height) || (cylindrical && radius + height <= 0.0))
      return surface_mesh_status::invalid_height;
  }
  if (!vertex_count) return surface_mesh_status::ok;
  const auto& gp0 = patch.corners[(1U + 2U * fragment) % 4U];
  const auto& gp1 = patch.corners[(2U + 2U * fragment) % 4U];
  const auto& gp2 = patch.corners[(2U * fragment) % 4U];
  const auto transform = core::coordinate_transform::cylindrical(radius);
  std::uint32_t y = 0U, x = first_vertex;
  while (x > dimension - y) { x -= dimension - y + 1U; ++y; }
  for (std::uint32_t i = 0U; i < vertex_count; ++i) {
    const auto grid = interpolated_grid_point(gp0, gp1, gp2, x, y, dimension);
    auto uvh = cylindrical ? uvh_from_grid(grid) : planar_uvh_from_grid(grid, bounds);
    uvh[2] = height_scale * heights.values[first_vertex + i];
    const auto xyz = cylindrical ? transform.xyz_from_uvh(uvh) : uvh;
    for (std::size_t axis = 0U; axis < 3U; ++axis)
      output[3U * i + axis] = static_cast<float>(xyz[axis] - description.origin[axis]);
    if (++x > dimension - y) { x = 0U; ++y; }
  }
  return surface_mesh_status::ok;
}

surface_mesh_status sample_patch_texture_coordinates(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    bool cylindrical, const core::bounds2d& bounds,
    std::uint32_t first_vertex, std::uint32_t vertex_count, float* output) {
  if (!dimension || dimension > maximum_patch_dimension ||
      vertex_count > maximum_surface_sample_vertices || (vertex_count && !output))
    return surface_mesh_status::invalid_argument;
  const auto total = (dimension + 1U) * (dimension + 2U) / 2U;
  if (first_vertex > total || vertex_count > total - first_vertex)
    return surface_mesh_status::invalid_argument;
  if (fragment > 1U || !patch.has_fragment(fragment))
    return surface_mesh_status::invalid_fragment;
  imagery::texture_model model;
  model.global = cylindrical;
  if (!cylindrical) model.extent = bounds;
  const core::grid_diamond diamond(patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]);
  const auto tile = imagery::terrain_anchor(diamond, patch.level, fragment, cylindrical);
  const auto extent = model.bounds(tile);
  if (!tile.is_valid() || !std::isfinite(extent.minimum[0]) || !std::isfinite(extent.minimum[1]) ||
      !std::isfinite(extent.maximum[0]) || !std::isfinite(extent.maximum[1]) ||
      extent.maximum[0] <= extent.minimum[0] || extent.maximum[1] <= extent.minimum[1])
    return surface_mesh_status::invalid_texture;
  if (!vertex_count) return surface_mesh_status::ok;
  texture_grid_pattern pattern;
  if (cylindrical && cylindrical_texture_pattern(patch, fragment, dimension, extent, pattern))
    return pattern.sample(first_vertex, vertex_count, output)
        ? surface_mesh_status::ok : surface_mesh_status::invalid_argument;
  const auto& gp0 = patch.corners[(1U + 2U * fragment) % 4U];
  const auto& gp1 = patch.corners[(2U + 2U * fragment) % 4U];
  const auto& gp2 = patch.corners[(2U * fragment) % 4U];
  std::uint32_t y = 0U, x = first_vertex;
  while (x > dimension - y) { x -= dimension - y + 1U; ++y; }
  for (std::uint32_t i = 0U; i < vertex_count; ++i) {
    const auto grid = interpolated_grid_point(gp0, gp1, gp2, x, y, dimension);
    const auto uvh = cylindrical ? uvh_from_grid(grid) : planar_uvh_from_grid(grid, bounds);
    texture_coordinates(uvh, extent, cylindrical, output + 2U * i);
    if (++x > dimension - y) { x = 0U; ++y; }
  }
  return surface_mesh_status::ok;
}

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    double radius, patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(patch, fragment, dimension, nullptr, 0.0, radius, output);
}
surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius, patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(patch, fragment, heights.dimension, &heights, height_scale, radius, output);
}
surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment, std::uint32_t dimension,
    const core::bounds2d& bounds, patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(patch, fragment, dimension, nullptr, 0.0, bounds, output);
}
surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(patch, fragment, heights.dimension, &heights, height_scale, bounds, output);
}

surface_mesh_status make_cylindrical_patch_boundary(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius, patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(patch, fragment, heights.dimension, &heights,
      height_scale, radius, output, true);
}

surface_mesh_status make_cylindrical_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius, patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(patch, fragment, heights.dimension, &heights,
      height_scale, radius, output, false, false);
}
surface_mesh_status make_planar_patch_positions(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(patch, fragment, heights.dimension, &heights,
      height_scale, bounds, output, false, false);
}
surface_mesh_status make_planar_patch_boundary(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(patch, fragment, heights.dimension, &heights,
      height_scale, bounds, output, true);
}

const char* surface_mesh_status_message(surface_mesh_status status) {
  switch (status) {
    case surface_mesh_status::ok:
      return "ok";
    case surface_mesh_status::invalid_argument:
      return "invalid surface mesh argument";
    case surface_mesh_status::invalid_fragment:
      return "invalid or unavailable patch fragment";
    case surface_mesh_status::invalid_height:
      return "invalid patch height fragment";
    case surface_mesh_status::invalid_texture:
      return "unable to select a texture tile";
    case surface_mesh_status::resource_limit:
      return "unable to allocate patch surface";
  }
  return "unknown surface mesh status";
}

}  // namespace frame
}  // namespace terra
