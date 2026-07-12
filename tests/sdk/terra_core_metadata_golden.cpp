#include <terra/core/metadata.hpp>

#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>

namespace {

using properties = std::map<std::string, std::string>;

properties read_golden(const std::string& path) {
  std::ifstream input(path.c_str());
  properties result;
  std::string line;
  while (std::getline(input, line)) {
    const std::size_t separator = line.find('=');
    if (separator != std::string::npos) {
      result[line.substr(0U, separator)] = line.substr(separator + 1U);
    }
  }
  if (!input.eof()) {
    throw std::runtime_error("unable to read metadata golden");
  }
  return result;
}

double number(const properties& values, const std::string& key) {
  const properties::const_iterator found = values.find(key);
  if (found == values.end()) {
    throw std::runtime_error("missing metadata golden key: " + key);
  }
  return std::stod(found->second);
}

std::string string_value(const properties& values, const std::string& key) {
  const properties::const_iterator found = values.find(key);
  if (found == values.end()) {
    throw std::runtime_error("missing metadata golden key: " + key);
  }
  return found->second;
}

terra::core::dataset_metadata globe_metadata(const properties& values) {
  terra::core::dataset_metadata result;
  result.patch_dimension =
      static_cast<std::uint32_t>(number(values, "metadata.patch_dim"));
  result.height_scale_factor =
      number(values, "metadata.height_scale_factor");
  result.srs = string_value(values, "metadata.srs");
  result.about = string_value(values, "metadata.about");
  result.transform = terra::core::coordinate_transform_kind::cylindrical;
  result.bounds = terra::core::bounds2d(
      terra::core::vector2d{{-180.0, -90.0}},
      terra::core::vector2d{{180.0, 90.0}});
  result.radius = number(values, "metadata.radius");
  return result;
}

terra::core::dataset_metadata planar_metadata(const properties& values) {
  terra::core::dataset_metadata result;
  result.patch_dimension = static_cast<std::uint32_t>(
      number(values, "planar.metadata.patch_dim"));
  result.height_scale_factor =
      number(values, "planar.metadata.height_scale_factor");
  result.srs = string_value(values, "planar.metadata.srs");
  result.about = string_value(values, "planar.metadata.about");
  result.transform = terra::core::coordinate_transform_kind::planar;
  result.bounds = terra::core::bounds2d(
      terra::core::vector2d{{0.0, 0.0}},
      terra::core::vector2d{{1025.0, 1025.0}});
  result.radius = 0.0;
  return result;
}

void require_status(const terra::core::dataset_metadata& metadata,
                    terra::core::metadata_status expected) {
  const terra::core::metadata_validation validation =
      terra::core::validate_dataset_metadata(metadata);
  if (validation.status != expected) {
    throw std::runtime_error(
        std::string("metadata status mismatch: expected ") +
        terra::core::metadata_status_message(expected) + ", got " +
        terra::core::metadata_status_message(validation.status));
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 2) {
      std::cerr << "usage: terra_core_metadata_golden GOLDEN\n";
      return 2;
    }
    const properties values = read_golden(argv[1]);
    terra::core::dataset_metadata globe = globe_metadata(values);
    terra::core::dataset_metadata planar = planar_metadata(values);
    const terra::core::metadata_validation globe_result =
        terra::core::validate_dataset_metadata(globe);
    const terra::core::metadata_validation planar_result =
        terra::core::validate_dataset_metadata(planar);
    if (!globe_result.valid() || globe_result.planar ||
        globe_result.root_count != 8U || !planar_result.valid() ||
        !planar_result.planar || planar_result.root_count != 1U) {
      throw std::runtime_error("M2 metadata did not validate");
    }

    globe.format_version = 2U;
    require_status(globe,
                   terra::core::metadata_status::unsupported_format_version);
    globe = globe_metadata(values);
    globe.patch_dimension = 63U;
    require_status(globe,
                   terra::core::metadata_status::invalid_patch_dimension);
    globe = globe_metadata(values);
    globe.height_scale_factor =
        std::numeric_limits<double>::quiet_NaN();
    require_status(globe, terra::core::metadata_status::invalid_height_scale);
    globe = globe_metadata(values);
    globe.srs.clear();
    require_status(globe, terra::core::metadata_status::missing_srs);
    globe = globe_metadata(values);
    globe.bounds.maximum[0] = 179.0;
    require_status(globe, terra::core::metadata_status::invalid_bounds);
    globe = globe_metadata(values);
    globe.radius = 0.0;
    require_status(globe, terra::core::metadata_status::invalid_radius);

    std::cout << "SDK golden passed: typed dataset metadata contract\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
