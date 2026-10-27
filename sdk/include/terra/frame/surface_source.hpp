#ifndef TERRA_FRAME_SURFACE_SOURCE_HPP
#define TERRA_FRAME_SURFACE_SOURCE_HPP

#include <terra/frame/height_storage.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <memory>

namespace terra {
namespace frame {

struct surface_source_parameters {
  std::uint32_t dimension = 0U;
  double height_scale = 1.0, radius = 0.0;
  bool cylindrical = false;
  core::bounds2d bounds;
};

// UV metadata must not keep a former mesh/height payload alive. Literal arrays
// use weak ownership identity; sampled layouts use the exact CBDAM recipe.
struct surface_uv_identity {
  std::weak_ptr<const void> owner;
  const void* address = nullptr;
  surface_source_parameters parameters;
  lod_patch patch;
  std::uint8_t fragment = 0U;
  texture_grid_pattern pattern;
  bool sampled = true, regular = false;
  bool compatible(const surface_uv_identity& other) const;
};

// Immutable CBDAM reader. Existing arrays are real shared loans. A not-yet-built
// position stream retains frozen heights and samples the same Float32 arithmetic
// as full mesh production; later mesh production cannot change this choice.
// Numeric arrays/heights remain charged to their original owners.
class surface_source {
 public:
  surface_source() = default;
  surface_source(std::shared_ptr<const patch_surface_mesh> mesh,
                 std::shared_ptr<const std::vector<float>> uv,
                 std::shared_ptr<const height_storage::block> heights,
                 const surface_source_parameters& parameters);
  bool valid() const { return valid_; }
  bool resident_positions() const { return bool(positions_); }
  std::uint32_t vertex_count() const { return vertices_; }
  std::uint32_t dimension() const { return parameters_.dimension; }
  const surface_uv_identity& uv_identity() const { return uv_identity_; }
  const core::vector3d& origin() const { return origin_; }
  // At most64 vertices. No allocation or full-candidate materialization.
  surface_mesh_status read(std::uint32_t first, std::uint32_t count,
                           float* positions, float* uv) const;
  surface_mesh_status read_uv(std::uint32_t first, std::uint32_t count, float* uv) const;
 private:
  surface_source_parameters parameters_;
  lod_patch patch_;
  std::uint8_t fragment_ = 0U;
  core::vector3d origin_{{}};
  std::uint32_t vertices_ = 0U;
  bool valid_ = false;
  surface_uv_identity uv_identity_;
  std::shared_ptr<const std::vector<float>> positions_, uv_;
  std::shared_ptr<const height_storage::block> heights_;
};

} // namespace frame
} // namespace terra
#endif
