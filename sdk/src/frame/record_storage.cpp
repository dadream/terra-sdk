#include <terra/frame/record_storage.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>

#include <utility>

namespace terra {
namespace frame {

codec::decode_status record_storage::decode(const std::uint8_t* data, std::size_t size,
                                          std::uint32_t dimension, handle& output) {
  const auto shape = codec::validate_cbdam_height_record_patch(data, size, dimension);
  if (shape != codec::decode_status::ok) return shape;
  if (dimension > codec::maximum_cbdam_patch_dimension + 1U) return codec::decode_status::unsupported_shape;
  core::payload_budget::credit work;
  if (!budget_.reserve(std::size_t(dimension) * dimension * sizeof(std::int32_t), work))
    return codec::decode_status::resource_limit;
  auto result = std::make_shared<block>();
  result->allocation_ = budget_.resident_credit();
  const auto status = codec::decode_cbdam_height_record_patch(data, size, dimension, result->value_);
  if (status != codec::decode_status::ok) return status;
  budget_.adopt(work, result->allocation_, result->value_.values.capacity() * sizeof(std::int32_t));
  output = std::move(result);
  return status;
}

codec::decode_status record_storage::zero(std::uint32_t dimension, handle& output) {
  if (!dimension || dimension > codec::maximum_cbdam_patch_dimension) return codec::decode_status::unsupported_shape;
  core::payload_budget::credit work;
  if (!budget_.reserve(std::size_t(dimension) * dimension * sizeof(std::int32_t), work))
    return codec::decode_status::resource_limit;
  auto result = std::make_shared<block>();
  result->allocation_ = budget_.resident_credit();
  result->value_.rows = result->value_.columns = dimension;
  result->value_.values.assign(std::size_t(dimension) * dimension, 0);
  budget_.adopt(work, result->allocation_, result->value_.values.capacity() * sizeof(std::int32_t));
  output = std::move(result);
  return codec::decode_status::ok;
}

}  // namespace frame
}  // namespace terra
