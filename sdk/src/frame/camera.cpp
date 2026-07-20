#include <terra/frame/camera.hpp>

#include <algorithm>
#include <cmath>

namespace terra {
namespace frame {
namespace {

matrix4d identity() {
  return {{1.0, 0.0, 0.0, 0.0,
           0.0, 1.0, 0.0, 0.0,
           0.0, 0.0, 1.0, 0.0,
           0.0, 0.0, 0.0, 1.0}};
}

double at(const matrix4d& matrix, std::size_t row, std::size_t column) {
  return matrix[row * 4 + column];
}

double& at(matrix4d& matrix, std::size_t row, std::size_t column) {
  return matrix[row * 4 + column];
}

matrix4d multiply(const matrix4d& left, const matrix4d& right) {
  matrix4d result = {{0.0}};
  for (std::size_t row = 0; row < 4; ++row) {
    for (std::size_t column = 0; column < 4; ++column) {
      for (std::size_t inner = 0; inner < 4; ++inner) {
        at(result, row, column) +=
            at(left, row, inner) * at(right, inner, column);
      }
    }
  }
  return result;
}

matrix4d translation(double x, double y, double z) {
  matrix4d result = identity();
  at(result, 0, 3) = x;
  at(result, 1, 3) = y;
  at(result, 2, 3) = z;
  return result;
}

matrix4d rotation_x(double angle) {
  matrix4d result = identity();
  const double cosine = std::cos(angle);
  const double sine = std::sin(angle);
  at(result, 1, 1) = cosine;
  at(result, 1, 2) = -sine;
  at(result, 2, 1) = sine;
  at(result, 2, 2) = cosine;
  return result;
}

matrix4d rotation_z(double angle) {
  matrix4d result = identity();
  const double cosine = std::cos(angle);
  const double sine = std::sin(angle);
  at(result, 0, 0) = cosine;
  at(result, 0, 1) = -sine;
  at(result, 1, 0) = sine;
  at(result, 1, 1) = cosine;
  return result;
}

matrix4d globe_target_alignment(double longitude_degrees,
                                double latitude_degrees) {
  const double degrees_to_radians = 3.14159265358979323846 / 180.0;
  const double longitude = longitude_degrees * degrees_to_radians;
  const double latitude = latitude_degrees * degrees_to_radians;
  const double sine_longitude = std::sin(longitude);
  const double cosine_longitude = std::cos(longitude);
  const double sine_latitude = std::sin(latitude);
  const double cosine_latitude = std::cos(latitude);

  matrix4d result = identity();
  at(result, 0, 0) = cosine_longitude;
  at(result, 0, 1) = 0.0;
  at(result, 0, 2) = -sine_longitude;
  at(result, 1, 0) = -sine_longitude * sine_latitude;
  at(result, 1, 1) = cosine_latitude;
  at(result, 1, 2) = -cosine_longitude * sine_latitude;
  at(result, 2, 0) = sine_longitude * cosine_latitude;
  at(result, 2, 1) = sine_latitude;
  at(result, 2, 2) = cosine_longitude * cosine_latitude;
  return result;
}

matrix4d perspective(double fov, double aspect,
                     double near_plane, double far_plane) {
  const double cotangent = 1.0 / std::tan(fov / 2.0);
  return {{cotangent / aspect, 0.0, 0.0, 0.0,
           0.0, cotangent, 0.0, 0.0,
           0.0, 0.0,
           -(far_plane + near_plane) / (far_plane - near_plane),
           -(2.0 * far_plane * near_plane) /
               (far_plane - near_plane),
           0.0, 0.0, -1.0, 0.0}};
}

plane4d clip_plane(const matrix4d& projection_view,
                   std::size_t index) {
  const std::size_t source_row = index / 2;
  plane4d plane = {{0.0, 0.0, 0.0, 0.0}};
  for (std::size_t column = 0; column < 4; ++column) {
    plane[column] = index % 2 == 0
                        ? at(projection_view, 3, column) +
                              at(projection_view, source_row, column)
                        : at(projection_view, 3, column) -
                              at(projection_view, source_row, column);
  }
  const double normal_length =
      std::sqrt(plane[0] * plane[0] + plane[1] * plane[1] +
                plane[2] * plane[2]);
  for (std::size_t component = 0; component < 4; ++component) {
    plane[component] /= normal_length;
  }
  return plane;
}

}  // namespace

axis_aligned_box3d::axis_aligned_box3d(
    const core::vector3d& minimum_value,
    const core::vector3d& maximum_value)
    : minimum(minimum_value), maximum(maximum_value) {}

globe_camera::globe_camera(float radius, int viewport_width,
                           int viewport_height,
                           float vertical_fov_radians)
    : radius_(radius),
      viewport_width_(viewport_width),
      viewport_height_(viewport_height),
      aspect_ratio_(viewport_height > 0
                        ? static_cast<float>(viewport_width) /
                              static_cast<float>(viewport_height)
                        : 0.0f),
      vertical_fov_radians_(vertical_fov_radians),
      initial_distance_(0.0),
      distance_(0.0),
      tilt_radians_(0.0),
      yaw_radians_(0.0),
      target_longitude_degrees_(0.0),
      target_latitude_degrees_(0.0) {
  if (is_valid()) {
    const double half_fov = std::atan(
        std::tan(0.5 * vertical_fov_radians_) *
        std::min(aspect_ratio_, 1.0f));
    initial_distance_ = 1.05 * radius_ / std::sin(half_fov);
    distance_ = initial_distance_;
  }
}

bool globe_camera::is_valid() const {
  return radius_ > 0.0f && viewport_width_ > 0 && viewport_height_ > 0 &&
         vertical_fov_radians_ > 0.0f &&
         vertical_fov_radians_ < 3.14159265358979323846f;
}

float globe_camera::radius() const { return radius_; }
float globe_camera::aspect_ratio() const { return aspect_ratio_; }
float globe_camera::vertical_fov_radians() const {
  return vertical_fov_radians_;
}
double globe_camera::initial_distance() const { return initial_distance_; }
double globe_camera::distance() const { return distance_; }
double globe_camera::tilt_radians() const { return tilt_radians_; }
double globe_camera::target_longitude_degrees() const {
  return target_longitude_degrees_;
}
double globe_camera::target_latitude_degrees() const {
  return target_latitude_degrees_;
}

void globe_camera::set_distance(double distance) { distance_ = distance; }
void globe_camera::set_tilt_radians(double tilt_radians) {
  tilt_radians_ = tilt_radians;
}
void globe_camera::rotate_yaw_radians(double yaw_radians) {
  yaw_radians_ += yaw_radians;
}
bool globe_camera::set_target_degrees(double longitude_degrees,
                                      double latitude_degrees) {
  if (!std::isfinite(longitude_degrees) ||
      !std::isfinite(latitude_degrees) || longitude_degrees < -180.0 ||
      longitude_degrees > 180.0 || latitude_degrees < -90.0 ||
      latitude_degrees > 90.0) {
    return false;
  }
  target_longitude_degrees_ = longitude_degrees;
  target_latitude_degrees_ = latitude_degrees;
  return true;
}
void globe_camera::reset() {
  distance_ = initial_distance_;
  tilt_radians_ = 0.0;
  yaw_radians_ = 0.0;
  target_longitude_degrees_ = 0.0;
  target_latitude_degrees_ = 0.0;
}

camera_snapshot globe_camera::snapshot() const {
  camera_snapshot result;
  result.distance = distance_;
  result.tilt_radians = tilt_radians_;
  result.view = multiply(
      multiply(
          multiply(translation(0.0, 0.0, -(distance_ - radius_)),
                   rotation_x(tilt_radians_)),
          translation(0.0, 0.0, -radius_)),
      multiply(rotation_z(yaw_radians_),
               globe_target_alignment(target_longitude_degrees_,
                                      target_latitude_degrees_)));
  result.position = inverse_rigid_transform_point(
      result.view, core::vector3d{{0.0, 0.0, 0.0}});

  const float distance_squared = static_cast<float>(
      result.position[0] * result.position[0] +
      result.position[1] * result.position[1] +
      result.position[2] * result.position[2]);
  const float radius_squared = radius_ * radius_;
  const float far_plane =
      std::sqrt(distance_squared - radius_squared) * 1.1f;
  const float near_plane = far_plane / 10000.0f;
  result.near_plane = near_plane;
  result.far_plane = far_plane;
  result.projection = perspective(vertical_fov_radians_, aspect_ratio_,
                                  near_plane, far_plane);
  result.projection_view = multiply(result.projection, result.view);
  for (std::size_t i = 0; i < result.clip_planes.size(); ++i) {
    result.clip_planes[i] = clip_plane(result.projection_view, i);
  }
  return result;
}

planar_camera::planar_camera(const core::bounds2d& bounds,
                             int viewport_width, int viewport_height,
                             float vertical_fov_radians)
    : bounds_(bounds),
      center_{{0.5 * (bounds.minimum[0] + bounds.maximum[0]),
               0.5 * (bounds.minimum[1] + bounds.maximum[1]), 0.0}},
      viewport_width_(viewport_width),
      viewport_height_(viewport_height),
      aspect_ratio_(viewport_height > 0
                        ? static_cast<float>(viewport_width) /
                              static_cast<float>(viewport_height)
                        : 0.0F),
      vertical_fov_radians_(vertical_fov_radians),
      diagonal_(0.0),
      initial_distance_(0.0),
      distance_(0.0),
      tilt_radians_(0.0),
      yaw_radians_(0.0) {
  if (is_valid()) {
    const double width = bounds_.maximum[0] - bounds_.minimum[0];
    const double height = bounds_.maximum[1] - bounds_.minimum[1];
    diagonal_ = std::sqrt(width * width + height * height);
    const double tangent = std::tan(0.5 * vertical_fov_radians_);
    const double vertical_distance = 0.5 * height / tangent;
    const double horizontal_distance =
        0.5 * width / (tangent * aspect_ratio_);
    initial_distance_ =
        1.2 * std::max(vertical_distance, horizontal_distance);
    distance_ = initial_distance_;
  }
}

bool planar_camera::is_valid() const {
  const double width = bounds_.maximum[0] - bounds_.minimum[0];
  const double height = bounds_.maximum[1] - bounds_.minimum[1];
  return std::isfinite(bounds_.minimum[0]) &&
         std::isfinite(bounds_.minimum[1]) &&
         std::isfinite(bounds_.maximum[0]) &&
         std::isfinite(bounds_.maximum[1]) && width > 0.0 && height > 0.0 &&
         viewport_width_ > 0 && viewport_height_ > 0 &&
         vertical_fov_radians_ > 0.0F &&
         vertical_fov_radians_ < 3.14159265358979323846F;
}

float planar_camera::aspect_ratio() const { return aspect_ratio_; }

float planar_camera::vertical_fov_radians() const {
  return vertical_fov_radians_;
}

double planar_camera::initial_distance() const { return initial_distance_; }
double planar_camera::distance() const { return distance_; }
double planar_camera::tilt_radians() const { return tilt_radians_; }
double planar_camera::target_x() const { return center_[0]; }
double planar_camera::target_y() const { return center_[1]; }

void planar_camera::set_distance(double distance) { distance_ = distance; }

void planar_camera::set_tilt_radians(double tilt_radians) {
  tilt_radians_ = tilt_radians;
}

void planar_camera::rotate_yaw_radians(double yaw_radians) {
  yaw_radians_ += yaw_radians;
}

bool planar_camera::set_target(double x, double y) {
  if (!std::isfinite(x) || !std::isfinite(y) || x < bounds_.minimum[0] ||
      x > bounds_.maximum[0] || y < bounds_.minimum[1] ||
      y > bounds_.maximum[1]) {
    return false;
  }
  center_[0] = x;
  center_[1] = y;
  return true;
}

void planar_camera::reset() {
  center_[0] = 0.5 * (bounds_.minimum[0] + bounds_.maximum[0]);
  center_[1] = 0.5 * (bounds_.minimum[1] + bounds_.maximum[1]);
  distance_ = initial_distance_;
  tilt_radians_ = 0.0;
  yaw_radians_ = 0.0;
}

camera_snapshot planar_camera::snapshot() const {
  camera_snapshot result;
  result.distance = distance_;
  result.tilt_radians = tilt_radians_;
  result.view = multiply(
      multiply(
          multiply(translation(0.0, 0.0, -distance_),
                   rotation_x(tilt_radians_)),
          rotation_z(yaw_radians_)),
      translation(-center_[0], -center_[1], 0.0));
  result.position = inverse_rigid_transform_point(
      result.view, core::vector3d{{0.0, 0.0, 0.0}});
  const double near_plane = std::max(distance_ / 10000.0,
                                     diagonal_ / 100000.0);
  const double far_plane = distance_ + 2.0 * diagonal_;
  result.near_plane = near_plane;
  result.far_plane = far_plane;
  result.projection = perspective(vertical_fov_radians_, aspect_ratio_,
                                  near_plane, far_plane);
  result.projection_view = multiply(result.projection, result.view);
  for (std::size_t i = 0; i < result.clip_planes.size(); ++i) {
    result.clip_planes[i] = clip_plane(result.projection_view, i);
  }
  return result;
}

core::vector3d inverse_rigid_transform_point(
    const matrix4d& transform, const core::vector3d& point) {
  const double translated[] = {
      point[0] - at(transform, 0, 3),
      point[1] - at(transform, 1, 3),
      point[2] - at(transform, 2, 3)};
  return {{at(transform, 0, 0) * translated[0] +
               at(transform, 1, 0) * translated[1] +
               at(transform, 2, 0) * translated[2],
           at(transform, 0, 1) * translated[0] +
               at(transform, 1, 1) * translated[1] +
               at(transform, 2, 1) * translated[2],
           at(transform, 0, 2) * translated[0] +
               at(transform, 1, 2) * translated[1] +
               at(transform, 2, 2) * translated[2]}};
}

bool is_visible(const axis_aligned_box3d& box,
                const std::array<plane4d, 6>& clip_planes) {
  for (std::size_t i = 0; i < clip_planes.size(); ++i) {
    const plane4d& plane = clip_planes[i];
    const core::vector3d positive = {{
        plane[0] >= 0.0 ? box.maximum[0] : box.minimum[0],
        plane[1] >= 0.0 ? box.maximum[1] : box.minimum[1],
        plane[2] >= 0.0 ? box.maximum[2] : box.minimum[2]}};
    const double distance = plane[0] * positive[0] +
                            plane[1] * positive[1] +
                            plane[2] * positive[2] + plane[3];
    if (distance < 0.0) {
      return false;
    }
  }
  return true;
}

}  // namespace frame
}  // namespace terra
