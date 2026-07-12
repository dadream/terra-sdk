#ifndef TERRA_CORE_METADATA_HPP
#define TERRA_CORE_METADATA_HPP

#include <terra/core/types.hpp>

#include <cstddef>

namespace terra {
namespace core {

enum class metadata_status {
  ok = 0,
  unsupported_format_version,
  invalid_patch_dimension,
  invalid_height_scale,
  missing_srs,
  unsupported_transform,
  invalid_bounds,
  invalid_radius
};

struct metadata_validation {
  metadata_status status = metadata_status::unsupported_format_version;
  bool planar = false;
  std::size_t root_count = 0U;

  bool valid() const;
};

metadata_validation validate_dataset_metadata(
    const dataset_metadata& metadata);

const char* metadata_status_message(metadata_status status);

}  // namespace core
}  // namespace terra

#endif  // TERRA_CORE_METADATA_HPP
