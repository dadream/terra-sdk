#include <terra/frame/height_query.hpp>

#include <algorithm>
#include <cmath>

namespace terra {
namespace frame {
namespace {
double dot(const core::vector3d& a, const core::vector3d& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
std::size_t index(std::uint32_t x, std::uint32_t y, std::uint32_t dimension) {
  return y * (2U * dimension + 3U - y) / 2U + x;
}
}  // namespace

core::vector3d height_query_grid(double u, double v, bool cylindrical,
                               const core::bounds2d& bounds) {
  const double g = core::grid_coordinate_max;
  if (!cylindrical) {
    return {{-g + 2 * g * (u - bounds.minimum[0]) /
                        (bounds.maximum[0] - bounds.minimum[0]),
             -g + 2 * g * (v - bounds.minimum[1]) /
                        (bounds.maximum[1] - bounds.minimum[1]), g}};
  }
  const double h = g / 2.0, latitude = v * g / 90.0;
  if (u < -90.0) return {{-h + (u + 180.0) * g / 90.0, latitude, h}};
  if (u < 0.0) return {{h, latitude, h - (u + 90.0) * g / 90.0}};
  if (u < 90.0) return {{h - u * g / 90.0, latitude, -h}};
  return {{-h, latitude, -h + (u - 90.0) * g / 90.0}};
}

bool height_fragment_coordinates(const core::grid_diamond& diamond,
                                 std::size_t fragment,
                                 const core::vector3d& point,
                                 core::vector2d& uv) {
  if (fragment > 1U) return false;
  const auto& a = diamond.corner((1U + 2U * fragment) % 4U);
  const auto& b = diamond.corner((2U + 2U * fragment) % 4U);
  const auto& c = diamond.corner((2U * fragment) % 4U);
  core::vector3d ab, ac, ap;
  for (std::size_t i = 0U; i < 3U; ++i) {
    ab[i] = double(b[i]) - a[i]; ac[i] = double(c[i]) - a[i];
    ap[i] = point[i] - a[i];
  }
  const double aa = dot(ab, ab), cc = dot(ac, ac), bc = dot(ab, ac);
  const double determinant = aa * cc - bc * bc;
  if (!(determinant > 0.0)) return false;
  double u = (cc * dot(ap, ab) - bc * dot(ap, ac)) / determinant;
  double v = (aa * dot(ap, ac) - bc * dot(ap, ab)) / determinant;
  if (!std::isfinite(u) || !std::isfinite(v) ||
      u < -1e-10 || v < -1e-10 || u + v > 1.0 + 1e-10) return false;
  // Barycentrics alone also accept the projection onto the opposite cylinder
  // face. Verify that the query is actually on this fragment's grid plane.
  for (std::size_t i = 0U; i < 3U; ++i) {
    if (std::abs(ap[i] - u * ab[i] - v * ac[i]) > 1e-5) return false;
  }
  u = std::max(0.0, std::min(1.0, u));
  v = std::max(0.0, std::min(1.0 - u, v));
  uv = {{u, v}};
  return true;
}

bool sample_height_fragment(const core::grid_diamond& diamond,
                            std::size_t fragment,
                            const codec::height_fragment& heights,
                            const core::vector3d& point, double& height) {
  const auto n = heights.dimension;
  if (n == 0U || n > codec::maximum_cbdam_patch_dimension ||
      heights.values.size() != (n + 1U) * (n + 2U) / 2U) return false;
  core::vector2d uv;
  if (!height_fragment_coordinates(diamond, fragment, point, uv)) return false;
  const double u = uv[0], v = uv[1];
  const double px = u * n, py = v * n;
  auto x = static_cast<std::uint32_t>(std::floor(px));
  auto y = static_cast<std::uint32_t>(std::floor(py));
  if (x + y >= n) { if (x) --x; else --y; }
  const double dx = px - x, dy = py - y;
  const double b_height = heights.values[index(x + 1U, y, n)];
  const double c_height = heights.values[index(x, y + 1U, n)];
  if (dx + dy <= 1.0 || x + y + 1U == n) {
    height = (1.0 - dx - dy) * heights.values[index(x, y, n)] +
             dx * b_height + dy * c_height;
  } else {
    height = (dx + dy - 1.0) * heights.values[index(x + 1U, y + 1U, n)] +
             (1.0 - dy) * b_height + (1.0 - dx) * c_height;
  }
  return true;
}

double height_sample_spacing(const core::grid_diamond& diamond,
                             std::size_t fragment, std::uint32_t dimension,
                             bool cylindrical, const core::bounds2d& bounds,
                             double radius) {
  const double g = core::grid_coordinate_max;
  const double angular_scale = 3.14159265358979323846 * radius / (2.0 * g);
  const core::vector3d scale = cylindrical
      ? core::vector3d{{angular_scale, angular_scale, angular_scale}}
      : core::vector3d{{(bounds.maximum[0] - bounds.minimum[0]) / (2.0 * g),
                        (bounds.maximum[1] - bounds.minimum[1]) / (2.0 * g), 0.0}};
  const std::size_t corners[] = {(1U + 2U * fragment) % 4U,
      (2U + 2U * fragment) % 4U, (2U * fragment) % 4U};
  double squared = 0.0;
  for (std::size_t edge = 0U; edge < 3U; ++edge) {
    core::vector3d d;
    for (std::size_t i = 0U; i < 3U; ++i) {
      d[i] = (double(diamond.corner(corners[edge])[i]) -
                     diamond.corner(corners[(edge + 1U) % 3U])[i]) * scale[i];
    }
    squared = std::max(squared, dot(d, d));
  }
  return std::sqrt(squared) / dimension;
}
}  // namespace frame
}  // namespace terra
