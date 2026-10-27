#include "triangle_projection.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace terra {
namespace frame {
namespace {

using vertex = std::array<double, 6>;
using polygon = std::array<vertex, maximum_projected_triangle_vertices>;

double plane_distance(const vertex& point, std::size_t plane) {
  return point[3] + (plane % 2U ? -point[plane / 2U] : point[plane / 2U]);
}

bool clip_polygon(polygon& points, std::uint32_t& count) {
  polygon next;
  for (std::size_t plane = 0U; plane < 6U; ++plane) {
    bool inside = false, outside = false;
    for (std::uint32_t i = 0U; i < count; ++i) {
      if (plane_distance(points[i], plane) >= 0.0) inside = true;
      else outside = true;
    }
    if (!inside) { count = 0U; return true; }
    if (!outside) continue;
    std::uint32_t size = 0U;
    for (std::uint32_t i = 0U; i < count; ++i) {
      const auto& a = points[i];
      const auto& b = points[(i + 1U) % count];
      const double da = plane_distance(a, plane), db = plane_distance(b, plane);
      if (da >= 0.0) {
        if (size == next.size()) return false;
        next[size++] = a;
      }
      if ((da < 0.0) != (db < 0.0)) {
        if (size == next.size()) return false;
        const double t = da / (da - db);
        for (std::size_t axis = 0U; axis < 6U; ++axis)
          next[size][axis] = a[axis] + (b[axis] - a[axis]) * t;
        ++size;
      }
    }
    std::copy_n(next.begin(), size, points.begin());
    count = size;
  }
  return true;
}

bool back_facing(const polygon& points) {
  const auto& a = points[0]; const auto& b = points[1]; const auto& c = points[2];
  const double x = b[0] - a[0], y = b[1] - a[1], w = b[3] - a[3];
  const double u = c[0] - a[0], v = c[1] - a[1], z = c[3] - a[3];
  const double p = a[0] * (y * z - w * v), q = a[1] * (w * u - x * z);
  const double r = a[3] * (x * v - y * u);
  const double scale = std::max({std::abs(a[0]), std::abs(b[0]), std::abs(c[0])}) *
    std::max({std::abs(a[1]), std::abs(b[1]), std::abs(c[1])}) *
    std::max({std::abs(a[3]), std::abs(b[3]), std::abs(c[3])});
  return p + q + r > 1e-6 * (std::abs(p) + std::abs(q) + std::abs(r) + scale);
}

double spectral(double a, double b, double c, double d) {
  const double aa = a * a + b * b, bb = c * c + d * d, ab = a * c + b * d;
  const double value = (aa + bb + std::hypot(aa - bb, 2.0 * ab)) / 2.0;
  return std::isnan(value) ? value : std::sqrt(std::max(0.0, value));
}

}  // namespace

bool valid_triangle_projection_context(const triangle_projection_context& context) {
  return std::all_of(context.matrix.begin(), context.matrix.end(), [](double v) { return std::isfinite(v); }) &&
    std::all_of(context.origin.begin(), context.origin.end(), [](double v) { return std::isfinite(v); }) &&
    std::isfinite(context.scale_x) && context.scale_x > 0.0 &&
    std::isfinite(context.scale_y) && context.scale_y > 0.0;
}

bool valid_triangle_projection_input(const triangle_projection_input& input) {
  return std::all_of(input.positions.begin(), input.positions.end(), [](float v) { return std::isfinite(v); }) &&
    std::all_of(input.uv.begin(), input.uv.end(), [](float v) { return std::isfinite(v); });
}

bool project_imagery_triangle(const triangle_projection_context& context,
    const triangle_projection_input& input, projected_triangle& output) {
  if (!valid_triangle_projection_context(context) || !valid_triangle_projection_input(input)) return false;
  projected_triangle result;
  polygon original;
  const auto& m = context.matrix;
  for (std::size_t i = 0U; i < 3U; ++i) {
    const double x = input.positions[i * 3U] + context.origin[0];
    const double y = input.positions[i * 3U + 1U] + context.origin[1];
    const double z = input.positions[i * 3U + 2U] + context.origin[2];
    for (std::size_t row = 0U; row < 4U; ++row)
      original[i][row] = m[row * 4U] * x + m[row * 4U + 1U] * y + m[row * 4U + 2U] * z + m[row * 4U + 3U];
    original[i][4] = input.uv[i * 2U]; original[i][5] = input.uv[i * 2U + 1U];
  }
  if (context.cull && back_facing(original)) { output = result; return true; }
  polygon points;
  std::copy_n(original.begin(), 3U, points.begin());
  std::uint32_t count = 3U;
  if (context.clip && !clip_polygon(points, count)) return false;
  const double du1 = original[1][4] - original[0][4], dv1 = original[1][5] - original[0][5];
  const double du2 = original[2][4] - original[0][4], dv2 = original[2][5] - original[0][5];
  const double det = du1 * dv2 - du2 * dv1;
  if (count < 3U || std::abs(det) < 1e-16) { output = result; return true; }
  core::vector3d u, v;
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    const double a = double(input.positions[3U + axis]) - input.positions[axis];
    const double b = double(input.positions[6U + axis]) - input.positions[axis];
    u[axis] = (a * dv2 - b * dv1) / det;
    v[axis] = (b * du1 - a * du2) / det;
  }
  const double infinity = std::numeric_limits<double>::infinity();
  double depth = infinity;
  for (std::uint32_t i = 0U; i < count; ++i) depth = std::min(depth, points[i][3]);
  result.center_distance = infinity;
  result.bounds = {{infinity, infinity, -infinity, -infinity}};
  for (std::uint32_t i = 0U; i < count; ++i) {
    const auto& point = points[i];
    result.bounds[0] = std::min(result.bounds[0], point[4]);
    result.bounds[1] = std::min(result.bounds[1], point[5]);
    result.bounds[2] = std::max(result.bounds[2], point[4]);
    result.bounds[3] = std::max(result.bounds[3], point[5]);
    result.polygon[i] = {{point[4], point[5]}};
    const double nx = point[0] / point[3], ny = point[1] / point[3];
    const double distance = std::hypot(nx, ny);
    result.center_distance = std::isnan(distance) ? distance : std::min(result.center_distance, distance);
    const core::vector3d x{{context.scale_x * (m[0] - nx * m[12]),
      context.scale_x * (m[1] - nx * m[13]), context.scale_x * (m[2] - nx * m[14])}};
    const core::vector3d y{{context.scale_y * (m[4] - ny * m[12]),
      context.scale_y * (m[5] - ny * m[13]), context.scale_y * (m[6] - ny * m[14])}};
    const auto dot = [](const core::vector3d& a, const core::vector3d& b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    };
    const double density = depth > 1e-9 ? spectral(dot(x, u), dot(x, v), dot(y, u), dot(y, v)) / depth
      : std::numeric_limits<double>::infinity();
    result.pixels_per_uv = std::isnan(density) ? density : std::max(result.pixels_per_uv, density);
  }
  const double scales[] = {context.scale_x, context.scale_y, 1.0};
  const std::size_t axes[] = {0U, 1U, 3U};
  for (std::size_t row = 0U; row < 3U; ++row) {
    const double a = original[0][axes[row]] * scales[row];
    const double b = original[1][axes[row]] * scales[row];
    const double c = original[2][axes[row]] * scales[row];
    const double du = ((b - a) * dv2 - (c - a) * dv1) / det;
    const double dv = ((c - a) * du1 - (b - a) * du2) / det;
    result.projection[row * 3U] = a - du * original[0][4] - dv * original[0][5];
    result.projection[row * 3U + 1U] = du;
    result.projection[row * 3U + 2U] = dv;
  }
  result.vertex_count = count;
  output = result;
  return true;
}

}  // namespace frame
}  // namespace terra
