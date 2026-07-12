#ifndef TERRA_CORE_COORDINATE_TRANSFORM_HPP
#define TERRA_CORE_COORDINATE_TRANSFORM_HPP

#include <terra/core/types.hpp>

#include <cstddef>

namespace terra {
namespace core {

class coordinate_transform {
 public:
  static coordinate_transform planar(const bounds2d& bounds);
  static coordinate_transform cylindrical(double radius);

  coordinate_transform_kind kind() const;
  bool is_planar() const;
  std::size_t root_count() const;
  const bounds2d& bounds() const;
  double radius() const;

  vector3d xyz_on_ground(const vector3d& xyz) const;
  double altitude_from_xyz(const vector3d& xyz) const;
  vector3d xyz_from_uvh(const vector3d& uvh) const;
  vector3d uvh_from_xyz(const vector3d& xyz) const;
  vector3d up_from_uvh(const vector3d& uvh) const;
  vector3d north_from_uvh(const vector3d& uvh) const;
  vector3d east_from_uvh(const vector3d& uvh) const;

 private:
  coordinate_transform(coordinate_transform_kind kind,
                       const bounds2d& bounds,
                       double radius,
                       std::size_t root_count);

  coordinate_transform_kind kind_;
  bounds2d bounds_;
  double radius_;
  std::size_t root_count_;
};

}  // namespace core
}  // namespace terra

#endif  // TERRA_CORE_COORDINATE_TRANSFORM_HPP
