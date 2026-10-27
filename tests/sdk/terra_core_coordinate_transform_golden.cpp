#include <terra/core/coordinate_transform.hpp>

#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

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

std::string format_bounds(const terra::core::bounds2d& value) {
  return format_double(value.minimum[0]) + "," +
         format_double(value.minimum[1]) + "|" +
         format_double(value.maximum[0]) + "," +
         format_double(value.maximum[1]);
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

void check_samples(const golden_map& golden, const std::string& prefix,
                   const terra::core::coordinate_transform& transform,
                   const std::vector<terra::core::vector3d>& samples) {
  expect(golden, prefix + "sample_count", std::to_string(samples.size()));
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const std::string sample_prefix =
        prefix + "sample." + std::to_string(i) + ".";
    const terra::core::vector3d xyz = transform.xyz_from_uvh(samples[i]);
    const terra::core::vector3d roundtrip = transform.uvh_from_xyz(xyz);

    expect(golden, sample_prefix + "uvh", format_vector(samples[i]));
    expect(golden, sample_prefix + "xyz", format_vector(xyz));
    expect(golden, sample_prefix + "roundtrip", format_vector(roundtrip));
    expect(golden, sample_prefix + "up",
           format_vector(transform.up_from_uvh(samples[i])));
    expect(golden, sample_prefix + "north",
           format_vector(transform.north_from_uvh(samples[i])));
    expect(golden, sample_prefix + "east",
           format_vector(transform.east_from_uvh(samples[i])));

    const terra::core::vector3d ground_uvh =
        {{samples[i][0], samples[i][1], 0.0}};
    const terra::core::vector3d expected_ground =
        transform.xyz_from_uvh(ground_uvh);
    const terra::core::vector3d actual_ground =
        transform.xyz_on_ground(xyz);
    if (format_vector(expected_ground) != format_vector(actual_ground)) {
      throw std::runtime_error(sample_prefix + "ground projection mismatch");
    }
    if (format_double(transform.altitude_from_xyz(xyz)) !=
        format_double(samples[i][2])) {
      throw std::runtime_error(sample_prefix + "altitude mismatch");
    }
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
    const terra::core::coordinate_transform globe =
        terra::core::coordinate_transform::cylindrical(6378000.0);
    expect(golden, "metadata.transform", "cylindrical");
    expect(golden, "metadata.is_planar",
           globe.is_planar() ? "true" : "false");
    expect(golden, "metadata.root_count", std::to_string(globe.root_count()));
    expect(golden, "metadata.radius", format_double(globe.radius()));
    expect(golden, "metadata.bounds", format_bounds(globe.bounds()));

    const std::vector<terra::core::vector3d> globe_samples = {
        {{0.0, 0.0, 0.0}},
        {{90.0, 0.0, 1000.0}},
        {{-90.0, 0.0, 0.0}},
        {{45.0, 30.0, 250.0}}};
    check_samples(golden, "transform.", globe, globe_samples);

    const terra::core::bounds2d planar_bounds(
        terra::core::vector2d{{0.0, 0.0}},
        terra::core::vector2d{{1025.0, 1025.0}});
    const terra::core::coordinate_transform planar =
        terra::core::coordinate_transform::planar(planar_bounds);
    expect(golden, "planar.metadata.transform", "planar");
    expect(golden, "planar.metadata.is_planar",
           planar.is_planar() ? "true" : "false");
    expect(golden, "planar.metadata.root_count",
           std::to_string(planar.root_count()));
    expect(golden, "planar.metadata.bounds", format_bounds(planar.bounds()));

    const std::vector<terra::core::vector3d> planar_samples = {
        {{0.0, 0.0, 0.0}},
        {{512.5, 512.5, 100.0}},
        {{1025.0, 1025.0, -25.0}}};
    check_samples(golden, "planar.transform.", planar, planar_samples);

    std::cout << "Terra::core coordinate transforms match the M2 golden.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
