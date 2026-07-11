#include <vic/cbdam/base/byte_array_accessor.hpp>
#include <vic/cbdam/base/diamond_operator.hpp>
#include <vic/vfs/repository.hpp>

#include <sl/quantized_array_codec.hpp>

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace {

typedef cbdam::height_operator::array2_t patch_t;

bool read_binary(const std::string& path, std::vector<uint8_t>& content) {
  std::ifstream input(path.c_str(), std::ios::in | std::ios::binary);
  if (!input) {
    return false;
  }
  content.assign(std::istreambuf_iterator<char>(input),
                 std::istreambuf_iterator<char>());
  return !input.bad() && !content.empty();
}

bool read_text(const std::string& path, std::string& content) {
  std::ifstream input(path.c_str(), std::ios::in | std::ios::binary);
  if (!input) {
    return false;
  }
  std::ostringstream output;
  output << input.rdbuf();
  content = output.str();
  return true;
}

uint64_t fnv1a_bytes(const uint8_t* data, std::size_t size) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (std::size_t i = 0; i < size; ++i) {
    hash ^= data[i];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

void fnv1a_value(uint64_t& hash, int32_t value) {
  const uint32_t bits = static_cast<uint32_t>(value);
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    hash ^= static_cast<uint8_t>((bits >> shift) & 0xffU);
    hash *= UINT64_C(1099511628211);
  }
}

bool decode_patch(const uint8_t* data, uint32_t size, patch_t& patch) {
  if (!data || size == 0) {
    return false;
  }
  sl::quantized_array_codec codec;
  codec.set_is_compressing_header(true);
  cbdam::height_operator::decompress_to(patch, data, size, &codec);
  return patch.extent()[0] > 0 && patch.extent()[1] > 0;
}

bool append_patch_report(std::ostringstream& output, const std::string& prefix,
                         const patch_t& patch, std::string& error) {
  const std::size_t rows = patch.extent()[0];
  const std::size_t columns = patch.extent()[1];
  if (rows == 0 || columns == 0) {
    error = prefix + " decoded to an empty array";
    return false;
  }

  int32_t minimum = std::numeric_limits<int32_t>::max();
  int32_t maximum = std::numeric_limits<int32_t>::min();
  int64_t sum = 0;
  uint64_t absolute_sum = 0;
  std::size_t nonzero_count = 0;
  uint64_t hash = UINT64_C(14695981039346656037);
  for (std::size_t row = 0; row < rows; ++row) {
    for (std::size_t column = 0; column < columns; ++column) {
      const int32_t value = patch(row, column);
      if (value < minimum) {
        minimum = value;
      }
      if (value > maximum) {
        maximum = value;
      }
      sum += value;
      absolute_sum += value < 0
                          ? static_cast<uint64_t>(-static_cast<int64_t>(value))
                          : static_cast<uint64_t>(value);
      if (value != 0) {
        ++nonzero_count;
      }
      fnv1a_value(hash, value);
    }
  }

  output << prefix << ".rows=" << rows << "\n";
  output << prefix << ".columns=" << columns << "\n";
  output << prefix << ".value_count=" << rows * columns << "\n";
  output << prefix << ".minimum=" << minimum << "\n";
  output << prefix << ".maximum=" << maximum << "\n";
  output << prefix << ".sum=" << sum << "\n";
  output << prefix << ".absolute_sum=" << absolute_sum << "\n";
  output << prefix << ".nonzero_count=" << nonzero_count << "\n";
  output << prefix << ".values_fnv1a64=" << hash << "\n";

  const std::size_t nonzero_sample_count =
      nonzero_count < 8 ? nonzero_count : 8;
  output << prefix << ".nonzero_sample_count=" << nonzero_sample_count
         << "\n";
  std::size_t emitted_nonzero = 0;
  for (std::size_t row = 0;
       row < rows && emitted_nonzero < nonzero_sample_count; ++row) {
    for (std::size_t column = 0;
         column < columns && emitted_nonzero < nonzero_sample_count;
         ++column) {
      const int32_t value = patch(row, column);
      if (value != 0) {
        output << prefix << ".nonzero_sample." << emitted_nonzero << "="
               << row << "," << column << "," << value << "\n";
        ++emitted_nonzero;
      }
    }
  }

  const std::size_t sample_rows[] = {0, 0, 0, rows / 2, rows / 2,
                                     rows / 2, rows - 1, rows - 1, rows - 1};
  const std::size_t sample_columns[] = {
      0, columns / 2, columns - 1, 0, columns / 2,
      columns - 1, 0, columns / 2, columns - 1};
  const std::size_t sample_count =
      sizeof(sample_rows) / sizeof(sample_rows[0]);
  output << prefix << ".sample_count=" << sample_count << "\n";
  for (std::size_t i = 0; i < sample_count; ++i) {
    output << prefix << ".sample." << i << "=" << sample_rows[i] << ","
           << sample_columns[i] << ","
           << patch(sample_rows[i], sample_columns[i]) << "\n";
  }
  return true;
}

bool build_report(const std::string& payload_path, std::string& report,
                  std::string& error) {
  std::vector<uint8_t> payload;
  if (!read_binary(payload_path, payload)) {
    error = "unable to read patch payload";
    return false;
  }
  if (payload.size() > std::numeric_limits<uint32_t>::max()) {
    error = "patch payload is too large";
    return false;
  }
  const uint32_t payload_size = static_cast<uint32_t>(payload.size());
  if (!cbdam::byte_array_accessor::sanity_check(&payload[0], payload_size)) {
    error = "patch payload failed byte-array sanity check";
    return false;
  }

  const uint32_t first_size =
      cbdam::byte_array_accessor::first_patch_size(&payload[0]);
  const uint32_t second_size =
      cbdam::byte_array_accessor::second_patch_size(&payload[0], payload_size);
  patch_t first_patch;
  patch_t second_patch;
  if (!decode_patch(cbdam::byte_array_accessor::first_patch_pointer(&payload[0]),
                    first_size, first_patch)) {
    error = "unable to decode first patch";
    return false;
  }
  if (second_size > 0 &&
      !decode_patch(
          cbdam::byte_array_accessor::second_patch_pointer(&payload[0]),
          second_size, second_patch)) {
    error = "unable to decode second patch";
    return false;
  }

  std::ostringstream output;
  output << "schema=terra.patch_decode.v1\n";
  output << "payload.size=" << payload_size << "\n";
  output << "payload.fnv1a64="
         << fnv1a_bytes(&payload[0], payload.size()) << "\n";
  output << "payload.first_patch_size=" << first_size << "\n";
  output << "payload.second_patch_size=" << second_size << "\n";
  output << "payload.second_patch_present="
         << (second_size > 0 ? "true" : "false") << "\n";
  if (!append_patch_report(output, "patch.0", first_patch, error)) {
    return false;
  }
  if (second_size > 0 &&
      !append_patch_report(output, "patch.1", second_patch, error)) {
    return false;
  }

  report = output.str();
  return true;
}

std::size_t first_mismatch_line(const std::string& expected,
                                const std::string& actual) {
  std::istringstream expected_input(expected);
  std::istringstream actual_input(actual);
  std::string expected_line;
  std::string actual_line;
  std::size_t line = 1;
  while (true) {
    const bool has_expected =
        static_cast<bool>(std::getline(expected_input, expected_line));
    const bool has_actual =
        static_cast<bool>(std::getline(actual_input, actual_line));
    if (!has_expected || !has_actual || expected_line != actual_line) {
      return line;
    }
    ++line;
  }
}

bool parse_int32(const char* text, int32_t& value) {
  errno = 0;
  char* end = 0;
  const long parsed = std::strtol(text, &end, 10);
  if (errno != 0 || !end || *end != '\0' ||
      parsed < std::numeric_limits<int32_t>::min() ||
      parsed > std::numeric_limits<int32_t>::max()) {
    return false;
  }
  value = static_cast<int32_t>(parsed);
  return true;
}

int extract_payload(int argc, char** argv) {
  if (argc != 7) {
    return 2;
  }
  int32_t i = 0;
  int32_t j = 0;
  int32_t k = 0;
  if (!parse_int32(argv[3], i) || !parse_int32(argv[4], j) ||
      !parse_int32(argv[5], k)) {
    std::cerr << "Patch extract failed: invalid repository key" << std::endl;
    return 1;
  }

  vic::vfs::repository repository;
  repository.open_read(argv[2]);
  if (!repository.is_open()) {
    std::cerr << "Patch extract failed: unable to open repository" << std::endl;
    return 1;
  }
  const vic::vfs::repository::key_t key(i, j, k);
  vic::vfs::repository::uint32_t size = 0;
  const uint8_t* data = repository.get_data(key, size);
  if (!data || size == 0) {
    std::cerr << "Patch extract failed: repository key is missing" << std::endl;
    return 1;
  }

  std::ofstream output(argv[6], std::ios::out | std::ios::binary);
  if (!output) {
    std::cerr << "Patch extract failed: unable to create output" << std::endl;
    return 1;
  }
  output.write(reinterpret_cast<const char*>(data), size);
  if (!output) {
    std::cerr << "Patch extract failed: unable to write output" << std::endl;
    return 1;
  }
  std::cout << "Extracted patch record key=" << i << "," << j << "," << k
            << " size=" << size << std::endl;
  return 0;
}

void print_usage(const char* program) {
  std::cerr << "Usage: " << program << " <payload.bin> <golden.txt>\n"
            << "       " << program << " --dump <payload.bin>\n"
            << "       " << program
            << " --extract <repository> <i> <j> <k> <output.bin>"
            << std::endl;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc >= 2 && std::string(argv[1]) == "--extract") {
    const int status = extract_payload(argc, argv);
    if (status == 2) {
      print_usage(argv[0]);
    }
    return status;
  }
  if (argc != 3) {
    print_usage(argv[0]);
    return 2;
  }

  const bool dump = std::string(argv[1]) == "--dump";
  const std::string payload_path = dump ? argv[2] : argv[1];
  std::string actual;
  std::string error;
  if (!build_report(payload_path, actual, error)) {
    std::cerr << "CBDAM patch decode golden failed: " << error << std::endl;
    return 1;
  }
  if (dump) {
    std::cout << actual;
    return 0;
  }

  std::string expected;
  if (!read_text(argv[2], expected)) {
    std::cerr << "CBDAM patch decode golden failed: unable to read "
              << argv[2] << std::endl;
    return 1;
  }
  if (expected != actual) {
    std::cerr << "CBDAM patch decode changed at golden line "
              << first_mismatch_line(expected, actual) << "\n"
              << "Expected:\n"
              << expected << "Actual:\n"
              << actual;
    return 1;
  }

  std::cout << "SDK golden passed: CBDAM record framing and patch decode"
            << std::endl;
  return 0;
}
