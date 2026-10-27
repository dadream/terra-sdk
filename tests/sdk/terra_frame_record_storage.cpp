#include <terra/frame/record_storage.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <utility>

namespace {
using terra::frame::record_storage;
using terra::codec::decode_status;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void observe() {
  require(test_allocations::live_bytes == 0U, "previous observed payload is still alive");
  test_allocations::allocations = test_allocations::peak_bytes = 0U;
  test_allocations::measuring = true;
}
std::vector<std::uint8_t> read(const char* path) {
  std::ifstream input(path, std::ios::binary);
  require(bool(input), "record fixture is unavailable");
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
void verify_stream(const std::vector<std::uint8_t>& bytes, std::uint32_t dimension) {
  terra::codec::height_patch decoded;
  const auto expected = terra::codec::decode_cbdam_height_record_patch(bytes.data(), bytes.size(), dimension, decoded);
  observe();
  const auto actual = terra::codec::verify_cbdam_height_record_patch(bytes.data(), bytes.size(), dimension);
  test_allocations::measuring = false;
  require(actual == expected && test_allocations::allocations == 0U,
          "allocation-free verification changed codec validity or allocated payload");
}
void verify_decode(const std::vector<std::uint8_t>& bytes, std::uint32_t dimension) {
  const auto payload = std::size_t(dimension) * dimension * sizeof(std::int32_t);
  record_storage small(payload - 1U), exact(payload);
  record_storage::handle record;
  observe();
  const auto rejected = small.decode(bytes.data(), bytes.size(), dimension, record);
  test_allocations::measuring = false;
  require(rejected == decode_status::resource_limit && !record && !test_allocations::allocations,
          "one-byte-short decode allocated before admission");
  terra::codec::height_patch expected;
  require(terra::codec::decode_cbdam_height_record_patch(bytes.data(), bytes.size(), dimension, expected) == decode_status::ok,
          "record fixture is not valid");
  observe();
  require(exact.decode(bytes.data(), bytes.size(), dimension, record) == decode_status::ok,
          "exact record capacity did not decode");
  require(record->value().values == expected.values && exact.resident_bytes() == payload && !exact.work_bytes(),
          "owned decode changed samples or duplicated its production charge");
  require(test_allocations::peak_bytes >= payload && test_allocations::peak_bytes <= payload + 128U,
          "decode exceeded payload credit and bounded owner metadata");
  auto reader = record;
  record.reset();
  require(exact.resident_bytes() == payload, "cache release refunded a borrowed record");
  require(exact.decode(bytes.data(), bytes.size(), dimension, record) == decode_status::resource_limit && !record,
          "another decode spent a retained reader's credit");
  reader.reset();
  test_allocations::measuring = false;
  require(exact.resident_bytes() == 0U && test_allocations::live_bytes == 0U,
          "final record reader did not release its allocation");
  verify_stream(bytes, dimension);
  for (std::size_t i = 0U; i < bytes.size(); i += std::max<std::size_t>(1U, bytes.size() / 32U)) {
    auto changed = bytes; changed[i] ^= 0xa5U; verify_stream(changed, dimension);
  }
}
void verify_failure() {
  const std::uint8_t broken[] = {5, 0, 0, 0, 0x80, 65, 0, 0, 0};
  record_storage storage(2U * 65U * 65U * sizeof(std::int32_t));
  record_storage::handle old;
  require(storage.zero(64U, old) == decode_status::ok, "zero record setup");
  const auto identity = old.get();
  const auto before = storage.resident_bytes();
  observe();
  const auto status = storage.decode(broken, sizeof(broken), 65U, old);
  test_allocations::measuring = false;
  require(status == decode_status::invalid_record && old.get() == identity && storage.resident_bytes() == before &&
          storage.work_bytes() == 0U && test_allocations::live_bytes == 0U,
          "failed decode changed old output or leaked production credit");
  for (auto value : old->value().values) require(value == 0, "procedural zero input changed");
  record_storage::handle survivor;
  observe();
  {
    record_storage temporary(64U * 64U * sizeof(std::int32_t));
    require(temporary.zero(64U, survivor) == decode_status::ok, "surviving record setup");
  }
  require(survivor->value().values.size() == 64U * 64U, "store teardown destroyed a retained record");
  survivor.reset();
  test_allocations::measuring = false;
  require(test_allocations::live_bytes == 0U, "record outliving its store leaked budget state");
  for (const auto n : {2U, 64U, 256U}) {
    record_storage limited(std::size_t(n) * n * sizeof(std::int32_t) - 1U);
    observe();
    const auto result = limited.zero(n, survivor);
    test_allocations::measuring = false;
    require(result == decode_status::resource_limit && !test_allocations::allocations && !survivor,
            "procedural zero bypassed production admission");
  }
}
void verify_credit() {
  terra::core::payload_budget budget(64U);
  terra::core::payload_budget::credit work;
  require(!budget.reserve(std::numeric_limits<std::size_t>::max(), work) && !work.attached(), "credit overflow admitted");
  require(budget.reserve(64U, work) && !budget.reserve(1U, work), "active credit was overwritten");
  auto resident = budget.resident_credit();
  budget.adopt(work, resident, 32U);
  auto moved = std::move(work);
  require(budget.resident_bytes() == 32U && budget.work_bytes() == 32U && !work.attached(), "move refunded live production");
  moved.clear(); resident.clear();
  require(!budget.resident_bytes() && !budget.work_bytes() && budget.peak_bytes() == 64U, "credit cleanup mismatch");
}
}  // namespace
int main(int argc, char** argv) {
  try {
    require(argc == 3, "expected root and detail fixtures");
    verify_decode(read(argv[1]), 65U); verify_decode(read(argv[2]), 64U);
    verify_failure(); verify_credit();
    std::cout << "Record payload admission, observed lifetime and complete stream verification passed\n";
  } catch (const std::exception& error) {
    test_allocations::measuring = false;
    std::cerr << error.what() << '\n'; return 1;
  }
}
