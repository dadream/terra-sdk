#include <terra/frame/camera.hpp>

#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

using golden_map = std::map<std::string, std::string>;

golden_map read_golden(const std::string& path) {
  std::ifstream input(path.c_str());
  if (!input) {
    throw std::runtime_error("unable to open golden file: " + path);
  }
  golden_map values;
  std::string line;
  while (std::getline(input, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::string::size_type separator = line.find('=');
    if (separator == std::string::npos) {
      throw std::runtime_error("invalid golden line: " + line);
    }
    values[line.substr(0, separator)] = line.substr(separator + 1);
  }
  return values;
}

std::string format_double(double value) {
  if (std::fabs(value) < 0.0000005) {
    value = 0.0;
  }
  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << std::fixed << std::setprecision(6) << value;
  return output.str();
}

std::string format_vector(const terra::core::vector3d& value) {
  return format_double(value[0]) + "," + format_double(value[1]) + "," +
         format_double(value[2]);
}

std::string format_plane(const terra::frame::plane4d& value) {
  return format_double(value[0]) + "," + format_double(value[1]) + "," +
         format_double(value[2]) + "," + format_double(value[3]);
}

terra::core::vector3d transform_point(
    const terra::frame::matrix4d& transform,
    const terra::core::vector3d& point) {
  terra::core::vector3d result{{0.0, 0.0, 0.0}};
  for (std::size_t row = 0; row < 3; ++row) {
    result[row] = transform[row * 4 + 3];
    for (std::size_t column = 0; column < 3; ++column) {
      result[row] += transform[row * 4 + column] * point[column];
    }
  }
  return result;
}

void expect(const golden_map& golden, const std::string& key,
            const std::string& actual) {
  const golden_map::const_iterator found = golden.find(key);
  if (found == golden.end()) {
    throw std::runtime_error("missing golden key: " + key);
  }
  if (found->second != actual) {
    throw std::runtime_error(key + ": expected " + found->second +
                             ", got " + actual);
  }
}

terra::frame::axis_aligned_box3d make_box(
    double x, double y, double z, double half_extent) {
  return terra::frame::axis_aligned_box3d(
      terra::core::vector3d{{x - half_extent, y - half_extent,
                             z - half_extent}},
      terra::core::vector3d{{x + half_extent, y + half_extent,
                             z + half_extent}});
}

void check_matrix(const golden_map& golden, const std::string& prefix,
                  const terra::frame::matrix4d& matrix) {
  for (std::size_t row = 0; row < 4; ++row) {
    std::string actual;
    for (std::size_t column = 0; column < 4; ++column) {
      if (column != 0) {
        actual += ",";
      }
      actual += format_double(matrix[row * 4 + column]);
    }
    expect(golden, prefix + ".row." + std::to_string(row), actual);
  }
}

void check_state(const golden_map& golden, const std::string& name,
                 const terra::frame::camera_snapshot& state,
                 double radius) {
  const std::string prefix = "camera.state." + name;
  expect(golden, prefix + ".distance", format_double(state.distance + radius));
  if (!(state.near_plane > 0 && state.far_plane > state.near_plane &&
        state.near_plane <= state.distance / 1000.0 && std::isfinite(state.far_plane))) {
    throw std::runtime_error("invalid range-based clipping");
  }
  expect(golden, prefix + ".position", format_vector(state.position));
  expect(golden, prefix + ".controller_position",
         format_vector(state.position));
  expect(golden, prefix + ".tilt", format_double(state.tilt_radians));

  check_matrix(golden, prefix + ".view", state.view);

  for (std::size_t i = 0; i < 4U; ++i) {
    expect(golden, prefix + ".clip_plane." + std::to_string(i),
           format_plane(state.clip_planes[i]));
  }

  const double half_extent = radius * 0.005;
  const terra::core::vector3d behind_eye =
      terra::frame::inverse_rigid_transform_point(
          state.view, terra::core::vector3d{{0.0, 0.0, 0.1 * radius}});
  const struct {
    const char* name;
    terra::frame::axis_aligned_box3d box;
  } boxes[] = {
      {"center", make_box(0.0, 0.0, 0.0, half_extent)},
      {"near_surface", make_box(0.0, 0.0, radius, half_extent)},
      {"far_surface", make_box(0.0, 0.0, -radius, half_extent)},
      {"east_limb", make_box(radius, 0.0, 0.0, half_extent)},
      {"west_limb", make_box(-radius, 0.0, 0.0, half_extent)},
      {"north_limb", make_box(0.0, radius, 0.0, half_extent)},
      {"behind_eye", make_box(behind_eye[0], behind_eye[1], behind_eye[2],
                               half_extent)},
      {"beyond_far", make_box(0.0, 0.0, -2.0 * radius, half_extent)}};
  expect(golden, prefix + ".frustum_box_count",
         std::to_string(sizeof(boxes) / sizeof(boxes[0])));
  for (const auto& box : boxes) {
    expect(golden, prefix + ".frustum." + box.name,
           terra::frame::is_visible(box.box, state.clip_planes)
               ? "visible"
               : "culled");
  }
}

}  // namespace

void check_near_ground_cameras() {
  constexpr double radius = 6378000.0;
  for (const auto height : {-400.0, 0.0, 1800.0, 5000.0}) {
    for (const auto range : {0.1, 2.0, 100.0, 10000.0, 20000000.0}) {
      for (const auto tilt : {0.0, 45.0, 80.0, 88.0}) {
        terra::frame::globe_camera camera(radius, 1280, 720, 0.6F);
        camera.set_target_degrees(116.5623, 40.74863);
        if (!camera.set_target_height(height)) throw std::runtime_error("valid target height rejected");
        camera.set_distance(range);
        camera.set_tilt_radians(-tilt * 3.14159265358979323846 / 180.0);
        camera.rotate_yaw_radians(1.1);
        const auto s = camera.snapshot();
        const auto target = terra::frame::inverse_rigid_transform_point(s.view, {{0, 0, -range}});
        const double length = std::sqrt(target[0]*target[0] + target[1]*target[1] + target[2]*target[2]);
        if (std::abs(length - radius - height) > 1e-6)
          throw std::runtime_error("camera dropped target height");
        double squared = 0;
        for (std::size_t i = 0; i < 3; ++i) squared += (s.position[i]-target[i])*(s.position[i]-target[i]);
        if (std::abs(std::sqrt(squared) - range) > 1e-6)
          throw std::runtime_error("camera range is not eye-to-target distance");
        if (!(s.near_plane > 0 && s.near_plane < range && s.far_plane > range))
          throw std::runtime_error("near ground target was clipped");
        for (const auto value : s.projection_view) if (!std::isfinite(value))
          throw std::runtime_error("near ground projection is non-finite");
        const auto depth = [&](double d) { return (-d*s.projection[10]+s.projection[11])/d; };
        if (std::abs(depth(s.near_plane) + 1) > 1e-12 ||
            std::abs(depth(s.far_plane) - 1) > 1e-12)
          throw std::runtime_error("clip planes do not map to the depth interval");
      }
    }
  }
}

int main(int argc, char** argv) {
  try {
    if (argc != 2) {
      std::cerr << "usage: " << argv[0] << " <native_behavior_v1.txt>\n";
      return 2;
    }
    check_near_ground_cameras();
    const golden_map golden = read_golden(argv[1]);
    const float radius = static_cast<float>(6378000.0);
    const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
    terra::frame::globe_camera camera(radius, 1280, 720, y_fov);
    if (!camera.is_valid()) {
      return 1;
    }
    expect(golden, "camera.viewport", "1280x720");
    expect(golden, "camera.aspect_ratio",
           format_double(camera.aspect_ratio()));
    expect(golden, "camera.y_fov",
           format_double(camera.vertical_fov_radians()));
    expect(golden, "camera.radius", format_double(camera.radius()));
    expect(golden, "camera.initial_distance",
           format_double(camera.initial_distance() + radius));
    check_state(golden, "initial", camera.snapshot(), radius);

    double zoomed_distance = camera.distance() + radius;
    for (int i = 0; i < 8; ++i) {
      zoomed_distance *= 0.85;
    }
    zoomed_distance = std::max(zoomed_distance, 1.001 * radius);
    camera.set_distance(zoomed_distance - radius);
    check_state(golden, "zoom_in_8", camera.snapshot(), radius);

    const double pi = 3.14159265358979323846;
    camera.set_tilt_radians(-45.0 * pi / 180.0);
    check_state(golden, "tilt_45", camera.snapshot(), radius);

    camera.rotate_yaw_radians(30.0 * pi / 180.0);
    check_state(golden, "rotate_30", camera.snapshot(), radius);

    camera.reset();
    check_state(golden, "reset", camera.snapshot(), radius);

    const double longitude_degrees = 116.4074;
    const double latitude_degrees = 39.9042;
    if (!camera.set_target_degrees(longitude_degrees, latitude_degrees)) {
      throw std::runtime_error("unable to set Beijing camera target");
    }
    if (camera.target_longitude_degrees() != longitude_degrees ||
        camera.target_latitude_degrees() != latitude_degrees) {
      throw std::runtime_error("globe camera target getters changed");
    }
    const terra::frame::camera_snapshot beijing = camera.snapshot();
    const double longitude = longitude_degrees * pi / 180.0;
    const double latitude = latitude_degrees * pi / 180.0;
    const terra::core::vector3d target_unit{{
        std::sin(longitude) * std::cos(latitude), std::sin(latitude),
        std::cos(longitude) * std::cos(latitude)}};
    const terra::core::vector3d target_surface{{
        radius * target_unit[0], radius * target_unit[1],
        radius * target_unit[2]}};
    const terra::core::vector3d target_in_view =
        transform_point(beijing.view, target_surface);
    if (std::fabs(target_in_view[0]) > 0.000001 ||
        std::fabs(target_in_view[1]) > 0.000001 ||
        std::fabs(target_in_view[2] + beijing.distance) >
            0.000001) {
      throw std::runtime_error("Beijing target is not on the view axis");
    }
    for (std::size_t axis = 0; axis < 3; ++axis) {
      if (std::fabs(beijing.position[axis] -
                    target_unit[axis] * (beijing.distance + radius)) > 0.000001) {
        throw std::runtime_error("Beijing camera position changed");
      }
    }
    if (camera.set_target_degrees(181.0, 0.0)) {
      throw std::runtime_error("invalid globe target was accepted");
    }
    camera.reset();
    if (camera.target_longitude_degrees() != 0.0 ||
        camera.target_latitude_degrees() != 0.0) {
      throw std::runtime_error("globe camera reset target changed");
    }
    for (const double heading : {0.0, 90.0, 180.0, 270.0}) {
      for (const double pitch : {-80.0, 0.0, 35.0, 80.0}) {
        if (!camera.set_eye(longitude_degrees, latitude_degrees, 502.0,
                            heading * pi / 180.0, pitch * pi / 180.0))
          throw std::runtime_error("valid eye rejected");
        const auto eye = camera.snapshot();
        const auto local_eye = transform_point(eye.view, eye.position);
        if (eye.distance != 0.0 || eye.near_plane != 0.1 || eye.far_plane <= eye.near_plane)
          throw std::runtime_error("eye clipping uses a fictitious orbit range");
        double vertical = 0.0;
        for (std::size_t axis = 0; axis < 3; ++axis) {
          if (std::fabs(eye.position[axis] - target_unit[axis] * (radius + 502.0)) > 1e-6 ||
              std::fabs(local_eye[axis]) > 1e-6)
            throw std::runtime_error("looking moved the fixed eye");
          vertical -= eye.view[8U + axis] * target_unit[axis];
        }
        if (std::fabs(vertical - std::sin(pitch * pi / 180.0)) > 1e-12)
          throw std::runtime_error("eye pitch is not relative to the local horizon");
        const auto before = camera.snapshot();
        if (camera.set_eye(181.0, 0.0, 0.0, 0.0, 0.0) || camera.snapshot().view != before.view)
          throw std::runtime_error("invalid eye changed the pose");
      }
    }
    std::cout << "Terra::frame golden orbit and fixed-eye poses passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
