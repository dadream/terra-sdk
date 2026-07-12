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
  expect(golden, prefix + ".distance", format_double(state.distance));
  expect(golden, prefix + ".near", format_double(state.near_plane));
  expect(golden, prefix + ".far", format_double(state.far_plane));
  expect(golden, prefix + ".position", format_vector(state.position));
  expect(golden, prefix + ".controller_position",
         format_vector(state.position));
  expect(golden, prefix + ".tilt", format_double(state.tilt_radians));
  check_matrix(golden, prefix + ".projection", state.projection);
  check_matrix(golden, prefix + ".view", state.view);
  check_matrix(golden, prefix + ".pv", state.projection_view);
  for (std::size_t i = 0; i < state.clip_planes.size(); ++i) {
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

int main(int argc, char** argv) {
  try {
    if (argc != 2) {
      std::cerr << "usage: " << argv[0] << " <native_behavior_v1.txt>\n";
      return 2;
    }
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
           format_double(camera.initial_distance()));
    check_state(golden, "initial", camera.snapshot(), radius);

    double zoomed_distance = camera.distance();
    for (int i = 0; i < 8; ++i) {
      zoomed_distance *= 0.85;
    }
    zoomed_distance = std::max(zoomed_distance, 1.001 * radius);
    camera.set_distance(zoomed_distance);
    check_state(golden, "zoom_in_8", camera.snapshot(), radius);

    const double pi = 3.14159265358979323846;
    camera.set_tilt_radians(-45.0 * pi / 180.0);
    check_state(golden, "tilt_45", camera.snapshot(), radius);

    camera.rotate_yaw_radians(30.0 * pi / 180.0);
    check_state(golden, "rotate_30", camera.snapshot(), radius);

    camera.reset();
    check_state(golden, "reset", camera.snapshot(), radius);
    std::cout << "Terra::frame camera and culling match the M2 golden.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
