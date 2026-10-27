#include <terra/core/coordinate_transform.hpp>
#include <terra/frame/camera.hpp>

#include <cmath>
#include <iostream>

int main() {
  const double radius = 6378000.0;
  const terra::core::coordinate_transform transform =
      terra::core::coordinate_transform::cylindrical(radius);
  const terra::core::vector3d position =
      transform.xyz_from_uvh(terra::core::vector3d{{0.0, 0.0, 0.0}});

  const float vertical_fov =
      static_cast<float>(30.0 * (3.14159265358979323846 / 180.0));
  const terra::frame::globe_camera camera(
      static_cast<float>(radius), 1280, 720, vertical_fov);

  if (!camera.is_valid() || std::fabs(position[2] - radius) > 0.000001) {
    std::cerr << "Terra SDK coordinate or camera check failed\n";
    return 1;
  }

  const terra::frame::camera_snapshot snapshot = camera.snapshot();
  std::cout << "Terra SDK C++ example: camera distance "
            << snapshot.position[2] << "\n";
  return 0;
}
