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

core::bounds2d fragment_bounds(const lod_patch& patch,
                               std::uint8_t fragment) {
  const std::size_t first = (1U + 2U * fragment) % 4U;
  const std::size_t second = (2U + 2U * fragment) % 4U;
  const std::size_t third = (0U + 2U * fragment) % 4U;
  core::vector3d uvh[] = {
      uvh_from_grid(patch.corners[first]),
      uvh_from_grid(patch.corners[second]),
      uvh_from_grid(patch.corners[third])};
  const double reference_longitude = uvh_from_grid(patch.id)[0];
  for (core::vector3d& point : uvh) {
    point[0] = longitude_near(point[0], reference_longitude);
  }
  core::vector2d minimum{{uvh[0][0], uvh[0][1]}};
  core::vector2d maximum = minimum;
  for (const core::vector3d& point : uvh) {
    minimum[0] = std::min(minimum[0], point[0]);
    minimum[1] = std::min(minimum[1], point[1]);
    maximum[0] = std::max(maximum[0], point[0]);
    maximum[1] = std::max(maximum[1], point[1]);
  }
  if (maximum[0] <= -180.0) {
    minimum[0] += 360.0;
    maximum[0] += 360.0;
  } else if (minimum[0] >= 180.0) {
    minimum[0] -= 360.0;
    maximum[0] -= 360.0;
  }
  return core::bounds2d(minimum, maximum);
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

}  // namespace

namespace {

surface_mesh_status make_cylindrical_patch_surface_impl(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension,
    const codec::height_fragment* heights, double height_scale,
    double radius,
    const core::global_geodetic_wmts_selector& texture_selector,
    patch_surface_mesh& output) {
  output = patch_surface_mesh();
  if (patch_dimension == 0U || patch_dimension > maximum_patch_dimension ||
      !std::isfinite(radius) || radius <= 0.0 ||
      !texture_selector.is_valid()) {
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

  const core::bounds2d bounds = fragment_bounds(patch, fragment);
  const core::wmts_tile_key tile =
      texture_selector.select_clamped(bounds, patch_dimension);
  const core::bounds2d tile_extent = texture_selector.tile_bounds(tile);
  const double tile_width = tile_extent.maximum[0] - tile_extent.minimum[0];
  const double tile_height = tile_extent.maximum[1] - tile_extent.minimum[1];
  if (!tile.is_valid() || tile_width <= 0.0 || tile_height <= 0.0) {
    return surface_mesh_status::invalid_texture;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    output.patch = patch;
    output.fragment = fragment;
    output.texture_tile = tile;
    output.positions_xyz.reserve(vertex_count * 3U);
    output.texture_uv.reserve(vertex_count * 2U);

    const core::coordinate_transform transform =
        core::coordinate_transform::cylindrical(radius);
    const core::vector3d origin_uvh = uvh_from_grid(patch.id);
    output.origin = transform.xyz_from_uvh(origin_uvh);

    const std::size_t first = (1U + 2U * fragment) % 4U;
    const std::size_t second = (2U + 2U * fragment) % 4U;
    const std::size_t third = (0U + 2U * fragment) % 4U;
    const core::grid_point& gp0 = patch.corners[first];
    const core::grid_point& gp1 = patch.corners[second];
    const core::grid_point& gp2 = patch.corners[third];

    std::size_t vertex = 0U;
    for (std::uint32_t y = 0U; y <= patch_dimension; ++y) {
      for (std::uint32_t x = 0U; x <= patch_dimension - y; ++x) {
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
        const double texture_longitude = longitude_near(
            uvh[0], 0.5 * (tile_extent.minimum[0] +
                           tile_extent.maximum[0]));
        output.texture_uv.push_back(static_cast<float>(
            (texture_longitude - tile_extent.minimum[0]) / tile_width));
        output.texture_uv.push_back(static_cast<float>(
            (tile_extent.maximum[1] - uvh[1]) / tile_height));
        ++vertex;
      }
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
    const core::bounds2d& bounds, patch_surface_mesh& output) {
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

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    output.patch = patch;
    output.fragment = fragment;
    output.texture_tile = core::wmts_tile_key(0, 0, 0, 0);
    output.positions_xyz.reserve(vertex_count * 3U);
    output.texture_uv.reserve(vertex_count * 2U);
    output.origin = planar_uvh_from_grid(patch.id, bounds);

    const std::size_t first = (1U + 2U * fragment) % 4U;
    const std::size_t second = (2U + 2U * fragment) % 4U;
    const std::size_t third = (0U + 2U * fragment) % 4U;
    const core::grid_point& gp0 = patch.corners[first];
    const core::grid_point& gp1 = patch.corners[second];
    const core::grid_point& gp2 = patch.corners[third];

    std::size_t vertex = 0U;
    for (std::uint32_t y = 0U; y <= patch_dimension; ++y) {
      for (std::uint32_t x = 0U; x <= patch_dimension - y; ++x) {
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
        output.texture_uv.push_back(static_cast<float>(
            (uvh[0] - bounds.minimum[0]) / width));
        output.texture_uv.push_back(static_cast<float>(
            (bounds.maximum[1] - uvh[1]) / height));
        ++vertex;
      }
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

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, double radius,
    const core::global_geodetic_wmts_selector& texture_selector,
    patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(
      patch, fragment, patch_dimension, nullptr, 0.0, radius,
      texture_selector, output);
}

surface_mesh_status make_cylindrical_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    double radius,
    const core::global_geodetic_wmts_selector& texture_selector,
    patch_surface_mesh& output) {
  return make_cylindrical_patch_surface_impl(
      patch, fragment, heights.dimension, &heights, height_scale, radius,
      texture_selector, output);
}

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    std::uint32_t patch_dimension, const core::bounds2d& bounds,
    patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(
      patch, fragment, patch_dimension, nullptr, 0.0, bounds, output);
}

surface_mesh_status make_planar_patch_surface(
    const lod_patch& patch, std::uint8_t fragment,
    const codec::height_fragment& heights, double height_scale,
    const core::bounds2d& bounds, patch_surface_mesh& output) {
  return make_planar_patch_surface_impl(
      patch, fragment, heights.dimension, &heights, height_scale,
      bounds, output);
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
