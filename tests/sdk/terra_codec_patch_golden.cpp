#include <terra/codec/cbdam_height.hpp>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using properties = std::map<std::string, std::string>;

bool read_binary(const std::string& path, std::vector<std::uint8_t>& bytes) {
  std::ifstream input(path.c_str(), std::ios::in | std::ios::binary);
  if (!input) {
    return false;
  }
  bytes.assign(std::istreambuf_iterator<char>(input),
               std::istreambuf_iterator<char>());
  return !input.bad();
}

bool read_properties(const std::string& path, properties& values) {
  std::ifstream input(path.c_str());
  std::string line;
  while (std::getline(input, line)) {
    const std::size_t separator = line.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    values[line.substr(0U, separator)] = line.substr(separator + 1U);
  }
  return input.eof() && !values.empty();
}

template <typename value_t>
std::string text(value_t value) {
  std::ostringstream output;
  output << value;
  return output.str();
}

std::uint64_t hash_bytes(const std::uint8_t* data, std::size_t size) {
  std::uint64_t hash = UINT64_C(14695981039346656037);
  for (std::size_t index = 0U; index < size; ++index) {
    hash ^= data[index];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

std::uint64_t hash_values(const std::vector<std::int32_t>& values) {
  std::uint64_t hash = UINT64_C(14695981039346656037);
  for (std::int32_t value : values) {
    const std::uint32_t bits = static_cast<std::uint32_t>(value);
    for (unsigned int shift = 0U; shift < 32U; shift += 8U) {
      hash ^= static_cast<std::uint8_t>((bits >> shift) & 0xffU);
      hash *= UINT64_C(1099511628211);
    }
  }
  return hash;
}

properties describe(const std::vector<std::uint8_t>& record,
                    const terra::codec::height_patch_record& decoded) {
  properties result;
  result["schema"] = "terra.patch_decode.v1";
  result["payload.size"] = text(record.size());
  result["payload.fnv1a64"] = text(hash_bytes(record.data(), record.size()));
  const std::uint32_t first_size =
      static_cast<std::uint32_t>(record[0]) |
      (static_cast<std::uint32_t>(record[1]) << 8U) |
      (static_cast<std::uint32_t>(record[2]) << 16U) |
      (static_cast<std::uint32_t>(record[3]) << 24U);
  result["payload.first_patch_size"] = text(first_size);
  result["payload.second_patch_size"] =
      text(record.size() - 4U - first_size);
  result["payload.second_patch_present"] =
      decoded.has_second ? "true" : "false";

  const terra::codec::height_patch& patch = decoded.first;
  result["patch.0.rows"] = text(patch.rows);
  result["patch.0.columns"] = text(patch.columns);
  result["patch.0.value_count"] = text(patch.values.size());
  std::int32_t minimum = std::numeric_limits<std::int32_t>::max();
  std::int32_t maximum = std::numeric_limits<std::int32_t>::min();
  std::int64_t sum = 0;
  std::uint64_t absolute_sum = 0U;
  std::size_t nonzero_count = 0U;
  for (std::int32_t value : patch.values) {
    minimum = std::min(minimum, value);
    maximum = std::max(maximum, value);
    sum += value;
    absolute_sum += value < 0
                        ? static_cast<std::uint64_t>(
                              -static_cast<std::int64_t>(value))
                        : static_cast<std::uint64_t>(value);
    nonzero_count += value != 0 ? 1U : 0U;
  }
  result["patch.0.minimum"] = text(static_cast<std::int64_t>(minimum));
  result["patch.0.maximum"] = text(static_cast<std::int64_t>(maximum));
  result["patch.0.sum"] = text(sum);
  result["patch.0.absolute_sum"] = text(absolute_sum);
  result["patch.0.nonzero_count"] = text(nonzero_count);
  result["patch.0.values_fnv1a64"] = text(hash_values(patch.values));

  const std::size_t nonzero_samples = std::min<std::size_t>(8U, nonzero_count);
  result["patch.0.nonzero_sample_count"] = text(nonzero_samples);
  std::size_t emitted = 0U;
  for (std::uint32_t row = 0U; row < patch.rows && emitted < nonzero_samples;
       ++row) {
    for (std::uint32_t column = 0U;
         column < patch.columns && emitted < nonzero_samples; ++column) {
      const std::int32_t value = patch.at(row, column);
      if (value != 0) {
        std::ostringstream sample;
        sample << row << ',' << column << ',' << value;
        result["patch.0.nonzero_sample." + text(emitted)] = sample.str();
        ++emitted;
      }
    }
  }

  const std::uint32_t rows[] = {0U, 0U, 0U, patch.rows / 2U,
                                patch.rows / 2U, patch.rows / 2U,
                                patch.rows - 1U, patch.rows - 1U,
                                patch.rows - 1U};
  const std::uint32_t columns[] = {
      0U, patch.columns / 2U, patch.columns - 1U, 0U,
      patch.columns / 2U, patch.columns - 1U, 0U,
      patch.columns / 2U, patch.columns - 1U};
  result["patch.0.sample_count"] = "9";
  for (std::size_t index = 0U; index < 9U; ++index) {
    std::ostringstream sample;
    sample << rows[index] << ',' << columns[index] << ','
           << patch.at(rows[index], columns[index]);
    result["patch.0.sample." + text(index)] = sample.str();
  }
  return result;
}

bool test_invalid_inputs(const std::vector<std::uint8_t>& record) {
  terra::codec::height_patch_record output;
  if (terra::codec::decode_cbdam_height_record(nullptr, 0U, output) !=
      terra::codec::decode_status::invalid_argument) {
    return false;
  }
  if (terra::codec::decode_cbdam_height_record(record.data(), 3U, output) !=
      terra::codec::decode_status::invalid_record) {
    return false;
  }
  std::vector<std::uint8_t> truncated(record.begin(), record.end() - 1);
  if (terra::codec::decode_cbdam_height_record(
          truncated.data(), truncated.size(), output) !=
      terra::codec::decode_status::invalid_record) {
    return false;
  }
  const std::uint8_t oversized[] = {0xc0U, 0xffU, 0xffU, 0U, 0U, 0U};
  terra::codec::height_patch patch;
  if (terra::codec::decode_cbdam_height_patch(
          oversized, sizeof(oversized), patch) !=
      terra::codec::decode_status::resource_limit) {
    std::cerr << "oversized patch was not rejected\n";
    return false;
  }
  const std::uint8_t corrupt_stream[] = {
      0x00U, 0x04U, 0x04U, 0x00U, 0x00U, 0x00U};
  if (terra::codec::decode_cbdam_height_patch(
          corrupt_stream, sizeof(corrupt_stream), patch) !=
      terra::codec::decode_status::invalid_record) {
    std::cerr << "corrupt range stream was not rejected\n";
    return false;
  }
  terra::codec::height_patch one_value;
  one_value.rows = 1U;
  one_value.columns = 1U;
  one_value.values.push_back(7);
  try {
    static_cast<void>(one_value.at(0U, 1U));
  } catch (const std::out_of_range&) {
    return true;
  }
  std::cerr << "out-of-range patch access was not rejected\n";
  return false;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: terra_codec_patch_golden RECORD GOLDEN\n";
    return 2;
  }
  std::vector<std::uint8_t> record;
  properties expected;
  if (!read_binary(argv[1], record) || !read_properties(argv[2], expected)) {
    std::cerr << "unable to read patch golden inputs\n";
    return 1;
  }
  terra::codec::height_patch_record decoded;
  const terra::codec::decode_status status =
      terra::codec::decode_cbdam_height_record(record.data(), record.size(),
                                               decoded);
  if (status != terra::codec::decode_status::ok) {
    std::cerr << terra::codec::decode_status_message(status) << '\n';
    return 1;
  }
  const properties actual = describe(record, decoded);
  if (actual != expected) {
    std::cerr << "Terra codec output differs from the M2 patch golden\n";
    return 1;
  }
  if (!test_invalid_inputs(record)) {
    std::cerr << "Terra codec invalid-input contract failed\n";
    return 1;
  }
  std::cout << "SDK golden passed: platform-neutral CBDAM patch codec\n";
  return 0;
}
