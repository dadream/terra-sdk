#include <vic/cbdam/base/camera_controller_vtrackball.hpp>
#include <vic/cbdam/base/coordinate_transform.hpp>
#include <vic/cbdam/base/grid_diamond_graph_incore.hpp>
#include <vic/cbdam/base/grid_diamond.hpp>
#include <vic/cbdam/base/repository_parameters.hpp>

#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <locale>
#include <sstream>
#include <string>

namespace {

std::string format_double(double value) {
  if (std::fabs(value) < 0.0000005) {
    value = 0.0;
  }
  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << std::fixed << std::setprecision(6) << value;
  return output.str();
}

std::string format_grid_point(const cbdam::grid_point_t& point) {
  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << point[0] << "," << point[1] << "," << point[2];
  return output.str();
}

std::string format_point2(
    const cbdam::coordinate_transform::point2d_t& point) {
  return format_double(point[0]) + "," + format_double(point[1]);
}

std::string format_point3(
    const cbdam::coordinate_transform::point3d_t& point) {
  return format_double(point[0]) + "," + format_double(point[1]) + "," +
         format_double(point[2]);
}

std::string format_vector3(
    const cbdam::coordinate_transform::vector3d_t& vector) {
  return format_double(vector[0]) + "," + format_double(vector[1]) + "," +
         format_double(vector[2]);
}

bool read_file(const std::string& path, std::string& content) {
  std::ifstream input(path.c_str(), std::ios::in | std::ios::binary);
  if (!input) {
    return false;
  }
  std::ostringstream output;
  output << input.rdbuf();
  content = output.str();
  return true;
}

void append_grid_point(std::ostringstream& output, const std::string& key,
                       const cbdam::grid_point_t& point) {
  output << key << "=" << format_grid_point(point) << "\n";
}

template <class Map>
void append_matrix(std::ostringstream& output, const std::string& prefix,
                   const Map& map) {
  const typename Map::matrix_t& matrix = map.as_matrix();
  for (std::size_t row = 0; row < 4; ++row) {
    output << prefix << ".row." << row << "=";
    for (std::size_t column = 0; column < 4; ++column) {
      if (column != 0) {
        output << ",";
      }
      output << format_double(matrix(row, column));
    }
    output << "\n";
  }
}

template <class Plane>
std::string format_plane(const Plane& plane) {
  return format_double(plane[0]) + "," + format_double(plane[1]) + "," +
         format_double(plane[2]) + "," + format_double(plane[3]);
}

struct camera_fixture {
  explicit camera_fixture(double globe_radius)
      : radius(static_cast<float>(globe_radius)),
        aspect_ratio(1280.0f / 720.0f),
        y_fov(static_cast<float>(30.0 * (3.14 / 180.0))),
        controller(&camera),
        visibility() {
    controller.set_window_size(1280, 720);
    controller.set_radius(radius);
    initial_distance = compute_initial_distance();
    controller.reset_rotation();
    controller.set_distance(initial_distance);
    update_projection();
  }

  double compute_initial_distance() const {
    const double vertical_half_fov = 0.5 * y_fov;
    const double fit_aspect = aspect_ratio < 1.0f ? aspect_ratio : 1.0f;
    const double half_fov =
        std::atan(std::tan(vertical_half_fov) * fit_aspect);
    return 1.05 * radius / std::sin(half_fov);
  }

  void update_projection() {
    const float distance_two = static_cast<float>(
        as_vector(camera.position()).two_norm_squared());
    const float radius_two = radius * radius;
    p_far = std::sqrt(distance_two - radius_two) * 1.1f;
    p_near = p_far / 10000.0f;
    camera.set_projection(y_fov, aspect_ratio, p_near, p_far);
  }

  float radius;
  float aspect_ratio;
  float y_fov;
  float p_near;
  float p_far;
  double initial_distance;
  cbdam::camera camera;
  cbdam::camera_controller_vtrackball controller;
  cbdam::grid_diamond_graph_incore visibility;
};

cbdam::grid_diamond_graph_incore::bounding_volume_t make_box(
    double x, double y, double z, double half_extent) {
  const sl::point3d pmin(x - half_extent, y - half_extent, z - half_extent);
  const sl::point3d pmax(x + half_extent, y + half_extent, z + half_extent);
  return cbdam::grid_diamond_graph_incore::bounding_volume_t(
      sl::aabox3d(pmin, pmax));
}

void append_camera_state(std::ostringstream& output,
                         const std::string& state_name,
                         camera_fixture& fixture) {
  fixture.update_projection();
  const cbdam::camera::projective_map_t camera_pv(
      fixture.camera.projection() * fixture.camera.view());
  const cbdam::camera::point3_t camera_position = fixture.camera.position();
  const cbdam::camera::point3_t controller_position =
      fixture.controller.camera_position();
  const std::string prefix = "camera.state." + state_name;

  output << prefix << ".distance="
         << format_double(fixture.controller.distance()) << "\n";
  output << prefix << ".near=" << format_double(fixture.p_near) << "\n";
  output << prefix << ".far=" << format_double(fixture.p_far) << "\n";
  output << prefix << ".position=" << format_point3(camera_position) << "\n";
  output << prefix << ".controller_position="
         << format_point3(controller_position) << "\n";
  output << prefix << ".tilt="
         << format_double(fixture.controller.tilt_angle()) << "\n";
  append_matrix(output, prefix + ".projection", fixture.camera.projection());
  append_matrix(output, prefix + ".view", fixture.camera.view());
  append_matrix(output, prefix + ".pv", camera_pv);
  for (std::size_t i = 0; i < 6; ++i) {
    output << prefix << ".clip_plane." << i << "="
           << format_plane(camera_pv.clip_plane(i)) << "\n";
  }

  const double r = fixture.radius;
  const double h = r * 0.005;
  const cbdam::camera::point3_t behind_camera = inverse_transformation(
      fixture.camera.view(), cbdam::camera::point3_t(0.0, 0.0, 0.1 * r));
  const struct {
    const char* name;
    double x;
    double y;
    double z;
  } boxes[] = {
      {"center", 0.0, 0.0, 0.0},
      {"near_surface", 0.0, 0.0, r},
      {"far_surface", 0.0, 0.0, -r},
      {"east_limb", r, 0.0, 0.0},
      {"west_limb", -r, 0.0, 0.0},
      {"north_limb", 0.0, r, 0.0},
      {"behind_eye", behind_camera[0], behind_camera[1], behind_camera[2]},
      {"beyond_far", 0.0, 0.0, -2.0 * r}};
  const std::size_t box_count = sizeof(boxes) / sizeof(boxes[0]);
  output << prefix << ".frustum_box_count=" << box_count << "\n";
  for (std::size_t i = 0; i < box_count; ++i) {
    const cbdam::grid_diamond_graph_incore::bounding_volume_t box =
        make_box(boxes[i].x, boxes[i].y, boxes[i].z, h);
    output << prefix << ".frustum." << boxes[i].name << "="
           << (fixture.visibility.is_visible(box, camera_pv) ? "visible"
                                                             : "culled")
           << "\n";
  }
}

void append_camera_behavior(std::ostringstream& output, double radius) {
  const double pi = 3.14159265358979323846;
  camera_fixture fixture(radius);

  output << "camera.viewport=1280x720\n";
  output << "camera.aspect_ratio=" << format_double(fixture.aspect_ratio)
         << "\n";
  output << "camera.y_fov=" << format_double(fixture.y_fov) << "\n";
  output << "camera.radius=" << format_double(fixture.radius) << "\n";
  output << "camera.initial_distance="
         << format_double(fixture.initial_distance) << "\n";
  append_camera_state(output, "initial", fixture);

  double zoomed_distance = fixture.controller.distance();
  for (int i = 0; i < 8; ++i) {
    zoomed_distance *= 0.85;
  }
  const double minimum_distance = 1.001 * fixture.radius;
  if (zoomed_distance < minimum_distance) {
    zoomed_distance = minimum_distance;
  }
  fixture.controller.set_distance(zoomed_distance);
  append_camera_state(output, "zoom_in_8", fixture);

  fixture.controller.set_tilt_angle(-45.0 * pi / 180.0);
  append_camera_state(output, "tilt_45", fixture);

  fixture.controller.rotate_yaw(30.0 * pi / 180.0);
  append_camera_state(output, "rotate_30", fixture);

  fixture.controller.reset_rotation();
  fixture.controller.set_distance(fixture.initial_distance);
  append_camera_state(output, "reset", fixture);
}

bool build_report(const std::string& metadata_path, std::string& report,
                  std::string& error) {
  cbdam::repository_parameters parameters;
  parameters.read_from_file(metadata_path.c_str());
  if (!parameters.last_operation_success() ||
      !parameters.get_coordinate_transform()) {
    error = "unable to read globe terrain metadata";
    return false;
  }

  const cbdam::cylindrical_coordinate_transform* transform =
      dynamic_cast<const cbdam::cylindrical_coordinate_transform*>(
          parameters.get_coordinate_transform());
  if (!transform) {
    error = "globe terrain metadata is not cylindrical";
    return false;
  }

  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << "schema=terra.native_behavior.v1\n";
  output << "metadata.patch_dim=" << parameters.patch_dim() << "\n";
  output << "metadata.height_scale_factor="
         << format_double(parameters.height_scale_factor()) << "\n";
  output << "metadata.srs=" << parameters.srs() << "\n";
  output << "metadata.about=" << parameters.about() << "\n";
  output << "metadata.transform=cylindrical\n";
  output << "metadata.is_planar="
         << (parameters.is_planar() ? "true" : "false") << "\n";
  output << "metadata.root_count=" << transform->root_count() << "\n";
  output << "metadata.radius=" << format_double(transform->radius()) << "\n";
  output << "metadata.bounds="
         << format_point2(transform->bounding_rectangle()[0]) << "|"
         << format_point2(transform->bounding_rectangle()[1]) << "\n";

  const cbdam::coordinate_transform::point3d_t samples[] = {
      cbdam::coordinate_transform::point3d_t(0.0, 0.0, 0.0),
      cbdam::coordinate_transform::point3d_t(90.0, 0.0, 1000.0),
      cbdam::coordinate_transform::point3d_t(-90.0, 0.0, 0.0),
      cbdam::coordinate_transform::point3d_t(45.0, 30.0, 250.0)};
  const std::size_t sample_count = sizeof(samples) / sizeof(samples[0]);
  output << "transform.sample_count=" << sample_count << "\n";
  for (std::size_t i = 0; i < sample_count; ++i) {
    const std::string prefix = "transform.sample." + std::to_string(i);
    const cbdam::coordinate_transform::point3d_t xyz =
        transform->xyz_from_uvh(samples[i]);
    output << prefix << ".uvh=" << format_point3(samples[i]) << "\n";
    output << prefix << ".xyz=" << format_point3(xyz) << "\n";
    output << prefix << ".roundtrip="
           << format_point3(transform->uvh_from_xyz(xyz)) << "\n";
    output << prefix << ".up="
           << format_vector3(transform->up_from_uvh(samples[i])) << "\n";
    output << prefix << ".north="
           << format_vector3(transform->north_from_uvh(samples[i])) << "\n";
    output << prefix << ".east="
           << format_vector3(transform->east_from_uvh(samples[i])) << "\n";
  }

  output << "grid.canonical_point_count=12\n";
  for (std::size_t i = 0; i < 12; ++i) {
    const cbdam::grid_point_t point =
        cbdam::grid_cylindrical_canonical_point(i);
    const std::string prefix = "grid.canonical_point." + std::to_string(i);
    append_grid_point(output, prefix + ".grid", point);
    output << prefix << ".uv=" << format_point2(transform->uv_from_grid(point))
           << "\n";
  }

  output << "topology.root_count=8\n";
  for (int i = 0; i < 8; ++i) {
    const cbdam::grid_diamond root =
        cbdam::grid_diamond::cylindrical_canonical_root(i);
    const std::string prefix = "topology.root." + std::to_string(i);
    output << prefix << ".valid=" << (root.is_valid() ? "true" : "false")
           << "\n";
    append_grid_point(output, prefix + ".id", root.id());
    append_grid_point(output, prefix + ".parent.0", root.parent_id(0));
    append_grid_point(output, prefix + ".parent.1", root.parent_id(1));
    for (int corner = 0; corner < 4; ++corner) {
      append_grid_point(output,
                        prefix + ".corner." + std::to_string(corner),
                        root.corner(corner));
    }
    for (int fragment = 0; fragment < 2; ++fragment) {
      for (int child = 0; child < 2; ++child) {
        append_grid_point(
            output,
            prefix + ".child." + std::to_string(fragment) + "." +
                std::to_string(child),
            root.child_id(fragment, child));
      }
    }
  }

  append_camera_behavior(output, transform->radius());

  report = output.str();
  return true;
}

std::size_t first_mismatch_line(const std::string& expected,
                                const std::string& actual) {
  std::istringstream expected_input(expected);
  std::istringstream actual_input(actual);
  std::string expected_line;
  std::string actual_line;
  std::size_t line = 1;
  while (true) {
    const bool has_expected =
        static_cast<bool>(std::getline(expected_input, expected_line));
    const bool has_actual =
        static_cast<bool>(std::getline(actual_input, actual_line));
    if (!has_expected || !has_actual) {
      return line;
    }
    if (expected_line != actual_line) {
      return line;
    }
    ++line;
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "Usage: " << argv[0]
              << " <globe_terrain.xml> <golden.txt>\n"
              << "       " << argv[0] << " --dump <globe_terrain.xml>"
              << std::endl;
    return 2;
  }

  const bool dump = std::string(argv[1]) == "--dump";
  const std::string metadata_path = dump ? argv[2] : argv[1];
  std::string actual;
  std::string error;
  if (!build_report(metadata_path, actual, error)) {
    std::cerr << "CBDAM native behavior golden failed: " << error << std::endl;
    return 1;
  }

  if (dump) {
    std::cout << actual;
    return 0;
  }

  std::string expected;
  if (!read_file(argv[2], expected)) {
    std::cerr << "CBDAM native behavior golden failed: unable to read "
              << argv[2] << std::endl;
    return 1;
  }
  if (expected != actual) {
    std::cerr << "CBDAM native behavior changed at golden line "
              << first_mismatch_line(expected, actual) << "\n"
              << "Expected:\n"
              << expected << "Actual:\n"
              << actual;
    return 1;
  }

  std::cout
      << "SDK golden passed: cylindrical metadata, coordinates, topology, "
         "camera, and frustum behavior"
      << std::endl;
  return 0;
}
