#include <terra/core/coordinate_transform.hpp>

#include <cmath>

namespace terra {
namespace core {
namespace {

const double degrees_to_radians = 0.01745329251994329576;
const double radians_to_degrees = 57.29577951308232087679;

double length(const vector3d& value) {
  return std::sqrt(value[0] * value[0] + value[1] * value[1] +
                   value[2] * value[2]);
}

vector3d scaled(const vector3d& value, double factor) {
  return {{value[0] * factor, value[1] * factor, value[2] * factor}};
}

}  // namespace

bounds2d::bounds2d() : minimum{{0.0, 0.0}}, maximum{{0.0, 0.0}} {}

bounds2d::bounds2d(const vector2d& minimum_value,
                   const vector2d& maximum_value)
    : minimum(minimum_value), maximum(maximum_value) {}

dataset_metadata::dataset_metadata()
    : format_version(1),
      patch_dimension(0),
      height_scale_factor(0.0),
      srs(),
      about(),
      transform(coordinate_transform_kind::planar),
      bounds(),
      radius(0.0) {}

coordinate_transform::coordinate_transform(coordinate_transform_kind kind,
                                           const bounds2d& bounds_value,
                                           double radius_value,
                                           std::size_t root_count_value)
    : kind_(kind),
      bounds_(bounds_value),
      radius_(radius_value),
      root_count_(root_count_value) {}

coordinate_transform coordinate_transform::planar(
    const bounds2d& bounds_value) {
  return coordinate_transform(coordinate_transform_kind::planar,
                              bounds_value, 0.0, 1);
}

coordinate_transform coordinate_transform::cylindrical(double radius_value) {
  return coordinate_transform(
      coordinate_transform_kind::cylindrical,
      bounds2d(vector2d{{-180.0, -90.0}}, vector2d{{180.0, 90.0}}),
      radius_value, 8);
}

coordinate_transform_kind coordinate_transform::kind() const {
  return kind_;
}

bool coordinate_transform::is_planar() const {
  return kind_ == coordinate_transform_kind::planar;
}

std::size_t coordinate_transform::root_count() const {
  return root_count_;
}

const bounds2d& coordinate_transform::bounds() const {
  return bounds_;
}

double coordinate_transform::radius() const {
  return radius_;
}

vector3d coordinate_transform::xyz_on_ground(const vector3d& xyz) const {
  if (is_planar()) {
    return {{xyz[0], xyz[1], 0.0}};
  }
  const double distance = length(xyz);
  if (distance == 0.0) {
    return {{0.0, 0.0, 0.0}};
  }
  return scaled(xyz, radius_ / distance);
}

double coordinate_transform::altitude_from_xyz(const vector3d& xyz) const {
  if (is_planar()) {
    return xyz[2];
  }
  return length(xyz) - radius_;
}

vector3d coordinate_transform::xyz_from_uvh(const vector3d& uvh) const {
  if (is_planar()) {
    return uvh;
  }
  return scaled(up_from_uvh(uvh), radius_ + uvh[2]);
}

vector3d coordinate_transform::uvh_from_xyz(const vector3d& xyz) const {
  if (is_planar()) {
    return xyz;
  }

  double distance = length(xyz);
  if (distance == 0.0) {
    distance = 1.0;
  }
  const double nx = xyz[0] / distance;
  const double ny = xyz[1] / distance;
  const double nz = xyz[2] / distance;
  const double longitude = std::atan2(nx, nz);
  const double latitude =
      std::atan2(ny, std::sqrt(nx * nx + nz * nz));
  return {{longitude * radians_to_degrees,
           latitude * radians_to_degrees,
           distance - radius_}};
}

vector3d coordinate_transform::up_from_uvh(const vector3d& uvh) const {
  if (is_planar()) {
    return {{0.0, 0.0, 1.0}};
  }
  const double longitude = uvh[0] * degrees_to_radians;
  const double latitude = uvh[1] * degrees_to_radians;
  const double cosine_latitude = std::cos(latitude);
  return {{std::sin(longitude) * cosine_latitude,
           std::sin(latitude),
           std::cos(longitude) * cosine_latitude}};
}

vector3d coordinate_transform::north_from_uvh(const vector3d& uvh) const {
  if (is_planar()) {
    return {{0.0, 1.0, 0.0}};
  }
  const double longitude = uvh[0] * degrees_to_radians;
  const double latitude = uvh[1] * degrees_to_radians;
  const double sine_latitude = std::sin(latitude);
  return {{-std::sin(longitude) * sine_latitude,
           std::cos(latitude),
           -std::cos(longitude) * sine_latitude}};
}

vector3d coordinate_transform::east_from_uvh(const vector3d& uvh) const {
  if (is_planar()) {
    return {{1.0, 0.0, 0.0}};
  }
  const double longitude = uvh[0] * degrees_to_radians;
  return {{std::cos(longitude), 0.0, -std::sin(longitude)}};
}

}  // namespace core
}  // namespace terra
