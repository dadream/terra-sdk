#ifndef TERRA_CODEC_CBDAM_HEIGHT_HPP
#define TERRA_CODEC_CBDAM_HEIGHT_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

namespace terra {
namespace codec {

enum class decode_status {
  ok = 0,
  invalid_argument,
  invalid_record,
  unsupported_shape,
  resource_limit
};

struct height_patch {
  std::uint32_t rows = 0;
  std::uint32_t columns = 0;
  std::vector<std::int32_t> values;

  bool empty() const;
  std::int32_t at(std::uint32_t row, std::uint32_t column) const;
};

struct height_patch_record {
  height_patch first;
  height_patch second;
  bool has_second = false;
};

decode_status decode_cbdam_height_patch(const std::uint8_t* data,
                                        std::size_t size,
                                        height_patch& output);

decode_status decode_cbdam_height_record(const std::uint8_t* data,
                                         std::size_t size,
                                         height_patch_record& output);

const char* decode_status_message(decode_status status);

}  // namespace codec
}  // namespace terra

#endif  // TERRA_CODEC_CBDAM_HEIGHT_HPP
