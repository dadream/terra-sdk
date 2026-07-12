#include <terra/core/metadata.hpp>

#include <cmath>

namespace terra {
namespace core {
namespace {

bool finite_bounds(const bounds2d& bounds) {
  return std::isfinite(bounds.minimum[0]) &&
         std::isfinite(bounds.minimum[1]) &&
         std::isfinite(bounds.maximum[0]) &&
         std::isfinite(bounds.maximum[1]) &&
         bounds.minimum[0] < bounds.maximum[0] &&
         bounds.minimum[1] < bounds.maximum[1];
}

bool power_of_two(std::uint32_t value) {
  return value != 0U && (value & (value - 1U)) == 0U;
}

}  // namespace

bool metadata_validation::valid() const {
  return status == metadata_status::ok;
}

metadata_validation validate_dataset_metadata(
    const dataset_metadata& metadata) {
  metadata_validation result;
  if (metadata.format_version != 1U) {
    result.status = metadata_status::unsupported_format_version;
    return result;
  }
  if (!power_of_two(metadata.patch_dimension) ||
      metadata.patch_dimension < 2U || metadata.patch_dimension > 4096U) {
    result.status = metadata_status::invalid_patch_dimension;
    return result;
  }
  if (!std::isfinite(metadata.height_scale_factor) ||
      metadata.height_scale_factor <= 0.0) {
    result.status = metadata_status::invalid_height_scale;
    return result;
  }
  if (metadata.srs.empty()) {
    result.status = metadata_status::missing_srs;
    return result;
  }
  if (metadata.transform != coordinate_transform_kind::planar &&
      metadata.transform != coordinate_transform_kind::cylindrical) {
    result.status = metadata_status::unsupported_transform;
    return result;
  }
  if (!finite_bounds(metadata.bounds)) {
    result.status = metadata_status::invalid_bounds;
    return result;
  }

  result.planar = metadata.transform == coordinate_transform_kind::planar;
  result.root_count = result.planar ? 1U : 8U;
  if (result.planar) {
    if (!std::isfinite(metadata.radius) || metadata.radius != 0.0) {
      result.status = metadata_status::invalid_radius;
      return result;
    }
  } else {
    const bool global_bounds =
        metadata.bounds.minimum[0] == -180.0 &&
        metadata.bounds.minimum[1] == -90.0 &&
        metadata.bounds.maximum[0] == 180.0 &&
        metadata.bounds.maximum[1] == 90.0;
    if (!global_bounds) {
      result.status = metadata_status::invalid_bounds;
      return result;
    }
    if (!std::isfinite(metadata.radius) || metadata.radius <= 0.0) {
      result.status = metadata_status::invalid_radius;
      return result;
    }
  }

  result.status = metadata_status::ok;
  return result;
}

const char* metadata_status_message(metadata_status status) {
  switch (status) {
    case metadata_status::ok:
      return "ok";
    case metadata_status::unsupported_format_version:
      return "unsupported dataset format version";
    case metadata_status::invalid_patch_dimension:
      return "invalid patch dimension";
    case metadata_status::invalid_height_scale:
      return "invalid height scale";
    case metadata_status::missing_srs:
      return "missing spatial reference";
    case metadata_status::unsupported_transform:
      return "unsupported coordinate transform";
    case metadata_status::invalid_bounds:
      return "invalid dataset bounds";
    case metadata_status::invalid_radius:
      return "invalid globe radius";
  }
  return "unknown metadata status";
}

}  // namespace core
}  // namespace terra
