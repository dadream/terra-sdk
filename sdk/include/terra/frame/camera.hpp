#ifndef TERRA_FRAME_CAMERA_HPP
#define TERRA_FRAME_CAMERA_HPP

#include <terra/core/types.hpp>

#include <array>

namespace terra {
namespace frame {

using matrix4d = std::array<double, 16>;
using plane4d = std::array<double, 4>;

struct axis_aligned_box3d {
  axis_aligned_box3d(const core::vector3d& minimum_value,
                     const core::vector3d& maximum_value);

  core::vector3d minimum;
  core::vector3d maximum;
};

struct camera_snapshot {
  double distance;
  double near_plane;
  double far_plane;
  double tilt_radians;
  core::vector3d position;
  matrix4d projection;
  matrix4d view;
  matrix4d projection_view;
  std::array<plane4d, 6> clip_planes;
};

class globe_camera {
 public:
  globe_camera(float radius, int viewport_width, int viewport_height,
               float vertical_fov_radians);

  bool is_valid() const;
  float radius() const;
  float aspect_ratio() const;
  float vertical_fov_radians() const;
  double initial_distance() const;
  double distance() const;
  double tilt_radians() const;

  void set_distance(double distance);
  void set_tilt_radians(double tilt_radians);
  void rotate_yaw_radians(double yaw_radians);
  void reset();

  camera_snapshot snapshot() const;

 private:
  float radius_;
  int viewport_width_;
  int viewport_height_;
  float aspect_ratio_;
  float vertical_fov_radians_;
  double initial_distance_;
  double distance_;
  double tilt_radians_;
  double yaw_radians_;
};

core::vector3d inverse_rigid_transform_point(
    const matrix4d& transform, const core::vector3d& point);

bool is_visible(const axis_aligned_box3d& box,
                const std::array<plane4d, 6>& clip_planes);

}  // namespace frame
}  // namespace terra

#endif  // TERRA_FRAME_CAMERA_HPP
