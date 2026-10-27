#ifndef TERRA_BENCH_TRIANGLE_PROJECTION_HPP
#define TERRA_BENCH_TRIANGLE_PROJECTION_HPP

#include <terra/frame/camera.hpp>

#include <array>
#include <cstdint>

namespace terra {
namespace frame {

// A clipped triangle needs at most nine vertices. Leave room for coincident
// boundary vertices without allocating during a projection batch.
constexpr std::uint32_t maximum_projected_triangle_vertices = 16U;

struct triangle_projection_context {
  matrix4d matrix{{}};
  core::vector3d origin{{}};
  double scale_x = 1.0, scale_y = 1.0;
  bool clip = true, cull = false;
};

struct triangle_projection_input {
  std::array<float, 9> positions{{}};
  std::array<float, 6> uv{{}};
};

struct projected_triangle {
  std::uint32_t vertex_count = 0U;
  double pixels_per_uv = 0.0;
  double center_distance = 0.0;
  // minimum U/V, maximum U/V; the same homogeneous interpolation preserves UV.
  std::array<double, 4> bounds{{}};
  // X(u,v), Y(u,v), W(u,v), with X/Y in screen pixels.
  std::array<double, 9> projection{{}};
  std::array<core::vector2d, maximum_projected_triangle_vertices> polygon{{}};
};

bool valid_triangle_projection_context(const triangle_projection_context& context);
bool valid_triangle_projection_input(const triangle_projection_input& input);

// Fixed stack storage only. False means invalid input or numerical polygon
// overflow, and leaves output untouched. A valid invisible/degenerate triangle
// succeeds with vertex_count zero. No terrain/image resource is retained.
bool project_imagery_triangle(const triangle_projection_context& context,
                             const triangle_projection_input& input,
                             projected_triangle& output);

}  // namespace frame
}  // namespace terra

#endif
