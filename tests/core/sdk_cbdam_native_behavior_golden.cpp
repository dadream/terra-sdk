#include <vic/cbdam/base/coordinate_transform.hpp>
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

  std::cout << "SDK golden passed: cylindrical metadata, coordinates, and "
               "root patch topology"
            << std::endl;
  return 0;
}
