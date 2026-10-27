#include <terra/frame/surface_source.hpp>

#include <algorithm>

namespace terra {
namespace frame {

bool surface_uv_identity::compatible(const surface_uv_identity& other) const {
  if (parameters.dimension != other.parameters.dimension) return false;
  const bool same_owner = address && address == other.address && !owner.owner_before(other.owner) && !other.owner.owner_before(owner);
  if (!sampled && !other.sampled) return same_owner;
  if (sampled != other.sampled && !same_owner) return false;
  if (regular && other.regular) return pattern.dimension == other.pattern.dimension && pattern.orientation == other.pattern.orientation;
  return parameters.cylindrical == other.parameters.cylindrical && fragment == other.fragment &&
      patch.level == other.patch.level && patch.id == other.patch.id && patch.corners == other.patch.corners &&
      parameters.bounds.minimum == other.parameters.bounds.minimum && parameters.bounds.maximum == other.parameters.bounds.maximum;
}

surface_source::surface_source(std::shared_ptr<const patch_surface_mesh> mesh,
    std::shared_ptr<const std::vector<float>> uv,
    std::shared_ptr<const height_storage::block> heights,
    const surface_source_parameters& parameters):parameters_(parameters) {
  if (!mesh) return;
  patch_surface_mesh description;
  if (describe_patch_surface(mesh->patch, mesh->fragment, parameters.dimension,
      parameters.cylindrical, parameters.radius, parameters.bounds, description) != surface_mesh_status::ok)
    return;
  patch_ = mesh->patch; fragment_ = mesh->fragment; origin_ = description.origin;
  if (origin_ != mesh->origin) return;
  vertices_ = (parameters.dimension + 1U) * (parameters.dimension + 2U) / 2U;
  uv_identity_.parameters = parameters; uv_identity_.patch = patch_; uv_identity_.fragment = fragment_;
  uv_identity_.regular = parameters.cylindrical && describe_cylindrical_texture_pattern(
      patch_, fragment_, parameters.dimension, uv_identity_.pattern);
  if (uv) {uv_identity_.owner = uv; uv_identity_.address = uv.get();}
  if (!mesh->positions_xyz.empty()) {
    if (mesh->positions_xyz.size() != std::size_t(vertices_) * 3U) return;
    positions_ = std::shared_ptr<const std::vector<float>>(mesh, &mesh->positions_xyz);
  } else {
    if (!heights || !heights->has_fragment(fragment_) || heights->value().dimension != parameters.dimension)
      return;
    heights_ = std::move(heights);
  }
  if (uv && !uv->empty()) uv_ = std::move(uv);
  else if (!mesh->texture_uv.empty()) uv_ = std::shared_ptr<const std::vector<float>>(mesh, &mesh->texture_uv);
  if (uv_ && uv_->size() != std::size_t(vertices_) * 2U) return;
  if (uv_) {uv_identity_.owner = uv_; uv_identity_.address = uv_.get(); uv_identity_.sampled = false;}
  if (!uv_ && sample_patch_texture_coordinates(patch_, fragment_, parameters.dimension,
      parameters.cylindrical, parameters.bounds, 0U, 0U, nullptr) != surface_mesh_status::ok) return;
  valid_ = true;
}

surface_mesh_status surface_source::read(std::uint32_t first, std::uint32_t count,
    float* positions, float* uv) const {
  if (!valid_ || count > 64U || first > vertices_ || count > vertices_ - first ||
      (count && (!positions || !uv)) ||
      (positions_ && positions_->size() != std::size_t(vertices_) * 3U) ||
      (uv_ && uv_->size() != std::size_t(vertices_) * 2U)) return surface_mesh_status::invalid_argument;
  if (!count) return surface_mesh_status::ok;
  if (positions_) std::copy_n(positions_->data() + first * 3U, count * 3U, positions);
  else {
    const auto status = sample_patch_positions(patch_, fragment_, heights_->value().fragments[fragment_],
        parameters_.height_scale, parameters_.cylindrical, parameters_.radius, parameters_.bounds,
        first, count, positions);
    if (status != surface_mesh_status::ok) return status;
  }
  return read_uv(first,count,uv);
}

surface_mesh_status surface_source::read_uv(std::uint32_t first,std::uint32_t count,float* uv) const {
  if (!valid_ || count > 64U || first > vertices_ || count > vertices_ - first || (count && !uv) ||
      (uv_ && uv_->size() != std::size_t(vertices_) * 2U)) return surface_mesh_status::invalid_argument;
  if (!count) return surface_mesh_status::ok;
  if (uv_) std::copy_n(uv_->data()+first*2U,count*2U,uv);
  else return sample_patch_texture_coordinates(patch_, fragment_, parameters_.dimension,
      parameters_.cylindrical, parameters_.bounds, first, count, uv);
  return surface_mesh_status::ok;
}

} // namespace frame
} // namespace terra
