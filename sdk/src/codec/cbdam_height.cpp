#include <terra/codec/cbdam_height.hpp>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <limits>
#include <new>
#include <stdexcept>

namespace terra {
namespace codec {
namespace {

const std::size_t kMaximumPatchValues = 1024U * 1024U;

class range_decoder {
 public:
  range_decoder(const std::uint8_t* data, std::size_t size)
      : low_(0), range_(0xff00), current_(data), end_(data + size),
        valid_(data != nullptr && size >= 2U) {
    zero_state_.fill(0U);
    one_state_.fill(0U);
    build_states();
    if (valid_) {
      low_ = static_cast<int>(*current_++) << 8;
      low_ += *current_++;
    }
  }

  bool decode(std::uint8_t& state) {
    if (!valid_ || state == 0U) {
      valid_ = false;
      return false;
    }
    const int range_for_one = (range_ * state) >> 8;
    if (range_for_one <= 0 || range_for_one >= range_) {
      valid_ = false;
      return false;
    }
    range_ -= range_for_one;
    if (low_ < range_) {
      state = zero_state_[state];
      refill();
      return false;
    }
    low_ -= range_;
    state = one_state_[state];
    range_ = range_for_one;
    refill();
    return true;
  }

  bool valid() const { return valid_; }
  void invalidate() { valid_ = false; }

 private:
  void build_states() {
    const std::int64_t one = std::int64_t(1) << 32;
    const int factor = static_cast<int>(0.05 * static_cast<double>(one));
    const int maximum_probability = 240;
    int previous_probability = 0;
    std::int64_t probability = one / 2;

    for (int index = 0; index < 128; ++index) {
      int probability8 =
          static_cast<int>((256 * probability + one / 2) >> 32);
      if (probability8 <= previous_probability) {
        probability8 = previous_probability + 1;
      }
      if (previous_probability != 0 && previous_probability < 256 &&
          probability8 <= maximum_probability) {
        one_state_[static_cast<std::size_t>(previous_probability)] =
            static_cast<std::uint8_t>(probability8);
      }
      probability +=
          ((one - probability) * factor + one / 2) >> 32;
      previous_probability = probability8;
    }

    for (int index = 256 - maximum_probability;
         index <= maximum_probability; ++index) {
      if (one_state_[static_cast<std::size_t>(index)] != 0U) {
        continue;
      }
      probability = (index * one + 128) >> 8;
      probability +=
          ((one - probability) * factor + one / 2) >> 32;
      int probability8 =
          static_cast<int>((256 * probability + one / 2) >> 32);
      if (probability8 <= index) {
        probability8 = index + 1;
      }
      if (probability8 > maximum_probability) {
        probability8 = maximum_probability;
      }
      one_state_[static_cast<std::size_t>(index)] =
          static_cast<std::uint8_t>(probability8);
    }
    for (int index = 1; index < 256; ++index) {
      zero_state_[static_cast<std::size_t>(index)] =
          static_cast<std::uint8_t>(
              256 - one_state_[static_cast<std::size_t>(256 - index)]);
    }
  }

  void refill() {
    if (range_ >= 0x100 || !valid_) {
      return;
    }
    range_ <<= 8;
    low_ <<= 8;
    if (current_ == end_) {
      valid_ = false;
      return;
    }
    low_ += *current_++;
  }

  int low_;
  int range_;
  const std::uint8_t* current_;
  const std::uint8_t* end_;
  bool valid_;
  std::array<std::uint8_t, 256> zero_state_;
  std::array<std::uint8_t, 256> one_state_;
};

class integer_decoder {
 public:
  integer_decoder(const std::uint8_t* data, std::size_t size)
      : range_(data, size), zero_state_(128U), bit_state_(128U) {
    sign_states_.fill(128U);
    mantissa_states_.fill(128U);
    exponent_states_.fill(128U);
  }

  bool decode_bit() { return range_.decode(bit_state_); }

  std::int32_t decode_int() {
    if (range_.decode(zero_state_)) {
      return 0;
    }
    if (!range_.valid()) {
      return 0;
    }

    std::uint32_t exponent = 0U;
    while (exponent < exponent_states_.size() &&
           range_.decode(exponent_states_[exponent])) {
      if (!range_.valid()) {
        return 0;
      }
      ++exponent;
    }
    if (!range_.valid() || exponent == exponent_states_.size()) {
      range_.invalidate();
      return 0;
    }

    std::uint32_t magnitude = std::uint32_t(1) << exponent;
    for (std::uint32_t bit = exponent; bit > 0U; --bit) {
      const std::uint32_t index = bit - 1U;
      if (range_.decode(mantissa_states_[index])) {
        magnitude |= std::uint32_t(1) << index;
      }
      if (!range_.valid()) {
        return 0;
      }
    }
    const bool negative = range_.decode(sign_states_[exponent]);
    if (!range_.valid()) {
      return 0;
    }
    if (!negative &&
        magnitude >
            static_cast<std::uint32_t>(
                std::numeric_limits<std::int32_t>::max())) {
      range_.invalidate();
      return 0;
    }
    return negative
               ? static_cast<std::int32_t>(
                     -static_cast<std::int64_t>(magnitude))
               : static_cast<std::int32_t>(magnitude);
  }

  bool valid() const { return range_.valid(); }

 private:
  range_decoder range_;
  std::uint8_t zero_state_;
  std::uint8_t bit_state_;
  std::array<std::uint8_t, 32> sign_states_;
  std::array<std::uint8_t, 32> mantissa_states_;
  std::array<std::uint8_t, 32> exponent_states_;
};

struct patch_header {
  std::uint32_t rows = 0U;
  std::uint32_t columns = 0U;
  std::uint32_t tolerance = 0U;
  std::size_t size = 0U;
};

std::uint16_t read_be16(const std::uint8_t* data) {
  return static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(data[0]) << 8U) |
      static_cast<std::uint16_t>(data[1]));
}

std::uint32_t read_be32(const std::uint8_t* data) {
  return (static_cast<std::uint32_t>(data[0]) << 24U) |
         (static_cast<std::uint32_t>(data[1]) << 16U) |
         (static_cast<std::uint32_t>(data[2]) << 8U) |
         static_cast<std::uint32_t>(data[3]);
}

std::uint32_t read_le32(const std::uint8_t* data) {
  return static_cast<std::uint32_t>(data[0]) |
         (static_cast<std::uint32_t>(data[1]) << 8U) |
         (static_cast<std::uint32_t>(data[2]) << 16U) |
         (static_cast<std::uint32_t>(data[3]) << 24U);
}

decode_status read_header(const std::uint8_t* data, std::size_t size,
                          patch_header& output) {
  if (!data || size < 3U) {
    return decode_status::invalid_record;
  }

  const std::uint8_t flags = data[0];
  std::size_t offset = 1U;
  const bool square = (flags & 0x80U) != 0U;
  const bool rows_are_16_bit = (flags & 0x40U) != 0U;
  const bool columns_are_16_bit = (flags & 0x20U) != 0U;
  const bool tolerance_is_16_bit = (flags & 0x10U) != 0U;
  const bool tolerance_is_32_bit = (flags & 0x08U) != 0U;

  const std::size_t rows_size = rows_are_16_bit ? 2U : 1U;
  if (offset + rows_size > size) {
    return decode_status::invalid_record;
  }
  output.rows = rows_are_16_bit ? read_be16(data + offset) : data[offset];
  offset += rows_size;

  if (square) {
    output.columns = output.rows;
  } else {
    const std::size_t columns_size = columns_are_16_bit ? 2U : 1U;
    if (offset + columns_size > size) {
      return decode_status::invalid_record;
    }
    output.columns =
        columns_are_16_bit ? read_be16(data + offset) : data[offset];
    offset += columns_size;
  }

  const std::size_t tolerance_size =
      tolerance_is_32_bit ? 4U : (tolerance_is_16_bit ? 2U : 1U);
  if (offset + tolerance_size + 2U > size) {
    return decode_status::invalid_record;
  }
  if (tolerance_is_32_bit) {
    output.tolerance = read_be32(data + offset);
  } else if (tolerance_is_16_bit) {
    output.tolerance = read_be16(data + offset);
  } else {
    output.tolerance = data[offset];
  }
  offset += tolerance_size;
  output.size = offset;

  if (output.rows == 0U || output.columns == 0U) {
    return decode_status::unsupported_shape;
  }
  if (output.rows > kMaximumPatchValues ||
      output.columns > kMaximumPatchValues / output.rows ||
      output.tolerance >
          static_cast<std::uint32_t>(
              (std::numeric_limits<std::int32_t>::max() - 1) / 2)) {
    return decode_status::resource_limit;
  }
  return decode_status::ok;
}

// This is the decode-only subset of the legacy SL quantized-array quadtree.
void decode_quadtree(integer_decoder& decoder,
                     std::vector<std::int32_t>& values,
                     std::uint32_t columns, std::uint32_t row,
                     std::uint32_t column, std::uint32_t row_count,
                     std::uint32_t column_count) {
  if (!decoder.valid() || decoder.decode_bit()) {
    return;
  }

  std::uint32_t lower_rows = row_count / 2U;
  const std::uint32_t upper_rows = row_count - lower_rows;
  std::uint32_t lower_columns = column_count / 2U;
  const std::uint32_t upper_columns = column_count - lower_columns;

  if (lower_rows < 2U || upper_rows < 2U) {
    if (lower_columns < 2U || upper_columns < 2U) {
      for (std::uint32_t i = row; i < row + row_count; ++i) {
        for (std::uint32_t j = column; j < column + column_count; ++j) {
          values[static_cast<std::size_t>(i) * columns + j] =
              decoder.decode_int();
        }
      }
    } else {
      lower_rows = row_count;
      decode_quadtree(decoder, values, columns, row, column, lower_rows,
                      lower_columns);
      decode_quadtree(decoder, values, columns, row, column + lower_columns,
                      lower_rows, upper_columns);
    }
  } else if (lower_columns < 2U || upper_columns < 2U) {
    lower_columns = column_count;
    decode_quadtree(decoder, values, columns, row, column, lower_rows,
                    lower_columns);
    decode_quadtree(decoder, values, columns, row + lower_rows, column,
                    upper_rows, lower_columns);
  } else {
    decode_quadtree(decoder, values, columns, row, column, lower_rows,
                    lower_columns);
    decode_quadtree(decoder, values, columns, row + lower_rows, column,
                    upper_rows, lower_columns);
    decode_quadtree(decoder, values, columns, row, column + lower_columns,
                    lower_rows, upper_columns);
    decode_quadtree(decoder, values, columns, row + lower_rows,
                    column + lower_columns, upper_rows, upper_columns);
  }
}

[[noreturn]] void height_patch_range_error() {
#if defined(TERRA_SDK_NO_EXCEPTIONS)
  std::abort();
#else
  throw std::out_of_range("height patch coordinate is outside the patch");
#endif
}

}  // namespace

bool height_patch::empty() const {
  return rows == 0U || columns == 0U || values.empty();
}

std::int32_t height_patch::at(std::uint32_t row,
                              std::uint32_t column) const {
  if (row >= rows || column >= columns) {
    height_patch_range_error();
  }
  return values.at(static_cast<std::size_t>(row) * columns + column);
}

decode_status decode_cbdam_height_patch(const std::uint8_t* data,
                                        std::size_t size,
                                        height_patch& output) {
  output = height_patch();
  if (!data) {
    return decode_status::invalid_argument;
  }

  patch_header header;
  const decode_status header_status = read_header(data, size, header);
  if (header_status != decode_status::ok) {
    return header_status;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    output.rows = header.rows;
    output.columns = header.columns;
    output.values.assign(static_cast<std::size_t>(header.rows) *
                             header.columns,
                         0);
    integer_decoder decoder(data + header.size, size - header.size);
    decode_quadtree(decoder, output.values, output.columns, 0U, 0U,
                    output.rows, output.columns);
    if (!decoder.valid()) {
      output = height_patch();
      return decode_status::invalid_record;
    }

    const std::int64_t multiplier =
        2 * static_cast<std::int64_t>(header.tolerance) + 1;
    for (std::int32_t& value : output.values) {
      const std::int64_t dequantized =
          static_cast<std::int64_t>(value) * multiplier;
      value = static_cast<std::int32_t>(std::max<std::int64_t>(
          std::numeric_limits<std::int32_t>::min(),
          std::min<std::int64_t>(std::numeric_limits<std::int32_t>::max(),
                                 dequantized)));
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output = height_patch();
    return decode_status::resource_limit;
  }
#endif
  return decode_status::ok;
}

decode_status decode_cbdam_height_record(const std::uint8_t* data,
                                         std::size_t size,
                                         height_patch_record& output) {
  output = height_patch_record();
  if (!data) {
    return decode_status::invalid_argument;
  }
  if (size < sizeof(std::uint32_t)) {
    return decode_status::invalid_record;
  }

  const std::size_t first_size = read_le32(data);
  const std::size_t payload_size = size - sizeof(std::uint32_t);
  if (first_size == 0U || first_size > payload_size) {
    return decode_status::invalid_record;
  }
  decode_status status = decode_cbdam_height_patch(
      data + sizeof(std::uint32_t), first_size, output.first);
  if (status != decode_status::ok) {
    output = height_patch_record();
    return status;
  }

  const std::size_t second_size = payload_size - first_size;
  if (second_size != 0U) {
    status = decode_cbdam_height_patch(
        data + sizeof(std::uint32_t) + first_size, second_size,
        output.second);
    if (status != decode_status::ok) {
      output = height_patch_record();
      return status;
    }
    output.has_second = true;
  }
  return decode_status::ok;
}

const char* decode_status_message(decode_status status) {
  switch (status) {
    case decode_status::ok:
      return "ok";
    case decode_status::invalid_argument:
      return "invalid argument";
    case decode_status::invalid_record:
      return "invalid CBDAM record";
    case decode_status::unsupported_shape:
      return "unsupported patch shape";
    case decode_status::resource_limit:
      return "patch exceeds resource limit";
  }
  return "unknown decode status";
}

}  // namespace codec
}  // namespace terra
