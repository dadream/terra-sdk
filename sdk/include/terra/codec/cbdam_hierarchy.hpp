#ifndef TERRA_CODEC_CBDAM_HIERARCHY_HPP
#define TERRA_CODEC_CBDAM_HIERARCHY_HPP

#include <terra/codec/cbdam_height.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace terra {
namespace codec {

constexpr std::uint32_t maximum_cbdam_patch_dimension = 256U;

enum class hierarchy_status {
  ok = 0,
  invalid_shape,
  missing_fragment,
  resource_limit,
  arithmetic_overflow
};

struct height_fragment {
  std::uint32_t dimension = 0U;
  std::vector<std::int32_t> values;

  bool empty() const;
  std::size_t vertex_count() const;
};

struct height_diamond {
  std::uint32_t dimension = 0U;
  std::uint8_t fragment_mask = 0U;
  std::array<height_fragment, 2> fragments;

  bool has_fragment(std::size_t fragment) const;
};

struct height_refinement {
  std::uint32_t dimension = 0U;
  std::uint8_t child_mask = 0U;
  std::array<height_fragment, 4> children;

  bool has_child(std::size_t parent_fragment,
                 std::size_t child_index) const;
};

hierarchy_status make_cbdam_root_height(const height_patch& root,
                                        height_diamond& output);

hierarchy_status refine_cbdam_height(const height_diamond& parent,
                                     const height_patch& detail,
                                     height_refinement& output);

const char* hierarchy_status_message(hierarchy_status status);

}  // namespace codec
}  // namespace terra

#endif  // TERRA_CODEC_CBDAM_HIERARCHY_HPP
