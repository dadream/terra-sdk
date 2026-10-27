#include <terra/frame/height_storage.hpp>

#include <algorithm>
#include <limits>
#include <utility>

namespace terra {
namespace frame {
namespace {
std::size_t bytes(const codec::height_fragment& value) {
  return value.values.capacity() * sizeof(std::int32_t);
}
std::size_t bytes(const codec::height_diamond& value) {
  return bytes(value.fragments[0]) + bytes(value.fragments[1]);
}
}  // namespace

height_storage::height_storage(std::size_t maximum) : budget_(maximum) {}
height_storage::handle height_storage::empty() const {
  auto result = std::make_shared<block>();
  result->allocation_ = budget_.resident_credit();
  return result;
}
std::size_t height_storage::fragment_bytes(std::size_t n) {
  return (n + 1U) * (n + 2U) / 2U * sizeof(std::int32_t);
}
std::size_t height_storage::workspace_bytes(std::size_t n) {
  return (2U * (n + 1U) * (n + 1U) + n * n + (2U * n + 1U) * (2U * n + 1U)) * sizeof(std::int32_t);
}
std::size_t height_storage::refinement_bytes(const codec::height_diamond& parent, std::size_t copies) {
  if (parent.dimension == 0U || parent.dimension > codec::maximum_cbdam_patch_dimension)
    return std::numeric_limits<std::size_t>::max();
  const auto payload = 2U * (std::size_t(parent.has_fragment(0U)) + std::size_t(parent.has_fragment(1U))) *
      fragment_bytes(parent.dimension);
  const auto temporary = std::max(workspace_bytes(parent.dimension), copies);
  return temporary > std::numeric_limits<std::size_t>::max() - payload
      ? std::numeric_limits<std::size_t>::max() : payload + temporary;
}
std::size_t height_storage::resident_bytes() const { return budget_.resident_bytes(); }
std::size_t height_storage::work_bytes() const { return budget_.work_bytes(); }
std::size_t height_storage::peak_bytes() const { return budget_.peak_bytes(); }
std::size_t height_storage::maximum_bytes() const { return budget_.maximum_bytes(); }
codec::hierarchy_status height_storage::root(const codec::height_patch& record, handle& output) {
  if (record.rows < 2U || record.rows > codec::maximum_cbdam_patch_dimension + 1U ||
      record.rows != record.columns) return codec::hierarchy_status::invalid_shape;
  credit work;
  if (!budget_.reserve(2U * fragment_bytes(record.rows - 1U), work)) return codec::hierarchy_status::resource_limit;
  auto result = empty();
  const auto status = codec::make_cbdam_root_height(record, result->value_);
  if (status != codec::hierarchy_status::ok) return status;
  budget_.adopt(work, result->allocation_, bytes(result->value_));
  output = std::move(result);
  return status;
}
codec::hierarchy_status height_storage::refine(const codec::height_diamond& parent,
    const codec::height_patch& detail, std::size_t copies, refinement& output) {
  if (output.allocation_.attached() || parent.dimension == 0U || parent.dimension > codec::maximum_cbdam_patch_dimension)
    return codec::hierarchy_status::invalid_shape;
  if (!budget_.reserve(refinement_bytes(parent, copies), output.allocation_))
    return codec::hierarchy_status::resource_limit;
  const auto status = codec::refine_cbdam_height(parent, detail, output.value_);
  if (status != codec::hierarchy_status::ok) {
    output.value_ = codec::height_refinement(); output.allocation_.clear(); return status;
  }
  std::size_t produced = 0U;
  for (const auto& child : output.value_.children) produced += bytes(child);
  // Codec scratch is gone. Keep destinations and admitted copies through
  // their transfer; another producer cannot spend their remaining credit.
  output.allocation_.shrink(produced + copies);
  output.copy_remaining_ = copies;
  return status;
}
std::size_t height_storage::copy_bytes(const handle& destination, std::size_t fragment) {
  return destination && !destination.unique() && fragment < 2U
      ? bytes(destination->value_.fragments[1U - fragment]) : 0U;
}
bool height_storage::replace(handle& destination, std::size_t fragment,
                             refinement& source, std::size_t child) {
  if (fragment >= 2U || child >= 4U || !source.value_.has_child(child / 2U, child % 2U) ||
      !source.allocation_.belongs_to(budget_) ||
      (destination && (!destination->allocation_.belongs_to(budget_) ||
        (destination->value_.dimension && destination->value_.dimension != source.value_.dimension)))) return false;
  const auto copied = copy_bytes(destination, fragment);
  auto& incoming = source.value_.children[child];
  const auto transferred = bytes(incoming);
  if (copied > source.copy_remaining_ || source.allocation_.bytes() < copied + transferred) return false;
  if (!destination) destination = empty();
  else if (!destination.unique()) {
    auto fresh = empty();
    fresh->value_.dimension = destination->value_.dimension; fresh->value_.fragment_mask = destination->value_.fragment_mask;
    fresh->value_.fragments[1U - fragment] = destination->value_.fragments[1U - fragment];
    budget_.adopt(source.allocation_, fresh->allocation_, bytes(fresh->value_.fragments[1U - fragment]));
    source.copy_remaining_ -= copied;
    destination = std::move(fresh);
  }
  auto& target = destination->value_;
  const auto previous = bytes(target.fragments[fragment]);
  // Drop the replaced array before returning its charge. Shared old blocks
  // remain untouched and charged until their own final reader releases them.
  target.fragments[fragment] = codec::height_fragment();
  destination->allocation_.shrink(destination->allocation_.bytes() - previous);
  target.fragments[fragment] = std::move(incoming);
  budget_.adopt(source.allocation_, destination->allocation_, transferred);
  target.dimension = source.value_.dimension;
  target.fragment_mask |= std::uint8_t(1U << fragment);
  source.value_.child_mask &= std::uint8_t(~(1U << child));
  return true;
}

}  // namespace frame
}  // namespace terra
