#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <vic/cbdam/base/byte_array_accessor.hpp>
#include <vic/cbdam/base/delta_codec.hpp>
#include <vic/cbdam/base/diamond_vertices.hpp>
#include <vic/cbdam/base/grid_diamond.hpp>
#include <vic/vfs/repository.hpp>
#include <sl/bitops.hpp>
#include <sl/quantized_array_codec.hpp>

#include <db.h>
#include <sys/stat.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

using repository_key = vic::vfs::repository::key_t;
using legacy_base =
    cbdam::delta_codec<cbdam::height_operator, cbdam::diamond_vertices>;

constexpr std::int32_t grid_coordinate_max = 1 << 28;

enum class lookup_status { found, missing, io_error };

struct lookup_result {
  lookup_status status = lookup_status::io_error;
  int error_code = 0;
  std::vector<std::uint8_t> bytes;
};

struct database_status {
  bool opened = false;
  bool structurally_complete = false;
  std::uint64_t expected_bytes = 0U;
  std::uint64_t actual_bytes = 0U;
  std::uint64_t readable_records = 0U;
  int cursor_error = 0;
};

class legacy_lifting : public legacy_base {
 public:
  void extract_child(std::size_t parent_fragment, std::size_t child_index,
                     std::vector<std::int32_t>& output) {
    output.clear();
    output.reserve(static_cast<std::size_t>(patch_dim_ + 1) *
                   static_cast<std::size_t>(patch_dim_ + 2) / 2U);
    for (int y = 0; y <= patch_dim_; ++y) {
      for (int x = 0; x <= patch_dim_ - y; ++x) {
        output.push_back(matrix_values_[matrix_index(
            y, x, static_cast<int>(parent_fragment),
            static_cast<int>(child_index))]);
      }
    }
  }
};

repository_key make_key(std::int32_t i, std::int32_t j, std::int32_t k) {
  repository_key key;
  key[0] = i;
  key[1] = j;
  key[2] = k;
  return key;
}

repository_key as_key(const DBT* value) {
  repository_key result;
  std::memcpy(&result[0], value->data, value->size);
  return result;
}

std::uint64_t high_morton(const repository_key& point) {
  const std::uint32_t x =
      static_cast<std::uint32_t>(grid_coordinate_max + point[0]);
  const std::uint32_t y =
      static_cast<std::uint32_t>(grid_coordinate_max + point[1]);
  const std::uint32_t z =
      static_cast<std::uint32_t>(grid_coordinate_max + point[2]);
  return sl::morton_bitops<std::uint64_t, 3>::encoded(x >> 16U, 0) |
         sl::morton_bitops<std::uint64_t, 3>::encoded(y >> 16U, 1) |
         sl::morton_bitops<std::uint64_t, 3>::encoded(z >> 16U, 2);
}

std::uint64_t low_morton(const repository_key& point) {
  const std::uint32_t mask = (1U << 16U) - 1U;
  const std::uint32_t x =
      static_cast<std::uint32_t>(grid_coordinate_max + point[0]);
  const std::uint32_t y =
      static_cast<std::uint32_t>(grid_coordinate_max + point[1]);
  const std::uint32_t z =
      static_cast<std::uint32_t>(grid_coordinate_max + point[2]);
  return sl::morton_bitops<std::uint64_t, 3>::encoded(x & mask, 0) |
         sl::morton_bitops<std::uint64_t, 3>::encoded(y & mask, 1) |
         sl::morton_bitops<std::uint64_t, 3>::encoded(z & mask, 2);
}

int compare_keys(DB*, const DBT* first, const DBT* second) {
  const repository_key first_key = as_key(first);
  const repository_key second_key = as_key(second);
  const std::uint64_t first_high = high_morton(first_key);
  const std::uint64_t second_high = high_morton(second_key);
  if (first_high != second_high) {
    return first_high < second_high ? -1 : 1;
  }
  const std::uint64_t first_low = low_morton(first_key);
  const std::uint64_t second_low = low_morton(second_key);
  if (first_low == second_low) {
    return 0;
  }
  return first_low < second_low ? -1 : 1;
}

std::uint64_t file_size(const std::string& path) {
  struct stat value;
  if (::stat(path.c_str(), &value) != 0 || value.st_size < 0) {
    return 0U;
  }
  return static_cast<std::uint64_t>(value.st_size);
}

class raw_database {
 public:
  raw_database() = default;
  raw_database(const raw_database&) = delete;
  raw_database& operator=(const raw_database&) = delete;
  ~raw_database() {
    if (database_ != nullptr) {
      database_->close(database_, 0);
    }
  }

  database_status open(const std::string& path) {
    status_ = database_status();
    status_.actual_bytes = file_size(path);
    int result = db_create(&database_, nullptr, 0);
    if (result != 0) {
      status_.cursor_error = result;
      return status_;
    }
    database_->set_bt_compare(database_, compare_keys);
    database_->set_cachesize(database_, 0, 16U * 1024U * 1024U, 0);
    result = database_->open(database_, nullptr, path.c_str(), nullptr,
                             DB_BTREE, DB_RDONLY, 0);
    if (result != 0) {
      status_.cursor_error = result;
      return status_;
    }
    status_.opened = true;
    void* raw_statistics = nullptr;
    result = database_->stat(database_, nullptr, &raw_statistics, DB_FAST_STAT);
    if (result == 0 && raw_statistics != nullptr) {
      const auto* statistics =
          static_cast<const DB_BTREE_STAT*>(raw_statistics);
      status_.expected_bytes =
          static_cast<std::uint64_t>(statistics->bt_pagecnt) *
          static_cast<std::uint64_t>(statistics->bt_pagesize);
      std::free(raw_statistics);
    }
    status_.structurally_complete = status_.expected_bytes != 0U &&
                                    status_.actual_bytes >=
                                        status_.expected_bytes;
    DBC* cursor = nullptr;
    result = database_->cursor(database_, nullptr, &cursor, 0);
    if (result == 0 && cursor != nullptr) {
      DBT key;
      DBT data;
      std::memset(&key, 0, sizeof(key));
      std::memset(&data, 0, sizeof(data));
      while ((result = cursor->get(cursor, &key, &data, DB_NEXT)) == 0) {
        ++status_.readable_records;
      }
      cursor->close(cursor);
    }
    status_.cursor_error = result == DB_NOTFOUND ? 0 : result;
    return status_;
  }

  lookup_result get(const repository_key& key) const {
    lookup_result result;
    if (database_ == nullptr || !status_.opened) {
      return result;
    }
    DBT db_key;
    DBT db_data;
    std::memset(&db_key, 0, sizeof(db_key));
    std::memset(&db_data, 0, sizeof(db_data));
    db_key.data = const_cast<std::int32_t*>(&key[0]);
    db_key.size = sizeof(repository_key);
    const int error = database_->get(database_, nullptr, &db_key, &db_data, 0);
    result.error_code = error;
    if (error == 0) {
      const auto* begin = static_cast<const std::uint8_t*>(db_data.data);
      result.bytes.assign(begin, begin + db_data.size);
      result.status = lookup_status::found;
    } else if (error == DB_NOTFOUND) {
      result.status = lookup_status::missing;
    } else {
      result.status = lookup_status::io_error;
    }
    return result;
  }

 private:
  DB* database_ = nullptr;
  database_status status_;
};

legacy_base::array2_t to_legacy(const terra::codec::height_patch& patch) {
  legacy_base::array2_t result(patch.rows, patch.columns);
  for (std::uint32_t row = 0U; row < patch.rows; ++row) {
    for (std::uint32_t column = 0U; column < patch.columns; ++column) {
      result(row, column) =
          patch.values[static_cast<std::size_t>(row) * patch.columns + column];
    }
  }
  return result;
}

bool decode_with_legacy(const std::vector<std::uint8_t>& bytes,
                        terra::codec::height_patch& output) {
  if (bytes.empty() ||
      !cbdam::byte_array_accessor::sanity_check(
          bytes.data(), static_cast<std::uint32_t>(bytes.size()))) {
    return false;
  }
  const std::uint32_t first_size =
      cbdam::byte_array_accessor::first_patch_size(bytes.data());
  if (cbdam::byte_array_accessor::second_patch_size(
          bytes.data(), static_cast<std::uint32_t>(bytes.size())) != 0U) {
    return false;
  }
  legacy_base::array2_t patch;
  sl::quantized_array_codec codec;
  codec.set_is_compressing_header(true);
  cbdam::height_operator::decompress_to(
      patch, cbdam::byte_array_accessor::first_patch_pointer(bytes.data()),
      first_size, &codec);
  output.rows = static_cast<std::uint32_t>(patch.extent()[0]);
  output.columns = static_cast<std::uint32_t>(patch.extent()[1]);
  output.values.resize(static_cast<std::size_t>(output.rows) * output.columns);
  for (std::uint32_t row = 0U; row < output.rows; ++row) {
    for (std::uint32_t column = 0U; column < output.columns; ++column) {
      output.values[static_cast<std::size_t>(row) * output.columns + column] =
          patch(row, column);
    }
  }
  return true;
}

bool decode_with_both(const lookup_result& record,
                      terra::codec::height_patch& output) {
  if (record.status != lookup_status::found) {
    return false;
  }
  terra::codec::height_patch_record modern;
  if (terra::codec::decode_cbdam_height_record(
          record.bytes.data(), record.bytes.size(), modern) !=
          terra::codec::decode_status::ok ||
      modern.has_second) {
    return false;
  }
  terra::codec::height_patch legacy;
  if (!decode_with_legacy(record.bytes, legacy) ||
      legacy.rows != modern.first.rows ||
      legacy.columns != modern.first.columns ||
      legacy.values != modern.first.values) {
    return false;
  }
  output = modern.first;
  return true;
}

bool compare_refinement(legacy_lifting& legacy,
                        const terra::codec::height_refinement& modern) {
  for (std::size_t parent = 0U; parent < 2U; ++parent) {
    for (std::size_t child = 0U; child < 2U; ++child) {
      std::vector<std::int32_t> expected;
      legacy.extract_child(parent, child, expected);
      if (!modern.has_child(parent, child) ||
          modern.children[2U * parent + child].values != expected) {
        return false;
      }
    }
  }
  return true;
}

bool refine_root_with_both(const terra::codec::height_patch& root,
                           const terra::codec::height_patch& detail,
                           terra::codec::height_refinement& output) {
  terra::codec::height_diamond parent;
  if (terra::codec::make_cbdam_root_height(root, parent) !=
          terra::codec::hierarchy_status::ok ||
      terra::codec::refine_cbdam_height(parent, detail, output) !=
          terra::codec::hierarchy_status::ok) {
    return false;
  }
  const std::size_t vertex_count =
      static_cast<std::size_t>(detail.rows + 1U) * (detail.rows + 2U) / 2U;
  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices first(&owner, static_cast<int>(vertex_count), false);
  cbdam::diamond_vertices second(&owner, static_cast<int>(vertex_count), false);
  legacy_lifting legacy;
  legacy.init(static_cast<std::int32_t>(detail.rows));
  const cbdam::grid_diamond unused;
  legacy.distribute_data_to_root(to_legacy(root), unused, &first, &second);
  if (parent.fragments[0].values != first.values() ||
      parent.fragments[1].values != second.values()) {
    return false;
  }
  legacy.decode_values(to_legacy(detail), unused, &first, &second);
  return compare_refinement(legacy, output);
}

bool same_key(const cbdam::grid_point_t& point, const repository_key& key) {
  return point[0] == key[0] && point[1] == key[1] && point[2] == key[2];
}

bool add_child_fragment(const cbdam::grid_diamond& parent,
                        const repository_key& child_key,
                        const terra::codec::height_refinement& refinement,
                        terra::codec::height_diamond& child) {
  for (int parent_fragment = 0; parent_fragment < 2; ++parent_fragment) {
    for (int child_index = 0; child_index < 2; ++child_index) {
      if (!same_key(parent.child_id(parent_fragment, child_index), child_key)) {
        continue;
      }
      const cbdam::grid_diamond geometry =
          parent.canonical_cylindrical_child_diamond(parent_fragment,
                                                       child_index);
      std::size_t child_fragment = 2U;
      for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
        if (geometry.parent_id(static_cast<int>(fragment)) == parent.id()) {
          child_fragment = fragment;
          break;
        }
      }
      if (child_fragment >= 2U) {
        return false;
      }
      const std::size_t refinement_slot =
          2U * static_cast<std::size_t>(parent_fragment) +
          static_cast<std::size_t>(child_index);
      child.dimension = refinement.dimension;
      child.fragments[child_fragment] = refinement.children[refinement_slot];
      child.fragment_mask |=
          static_cast<std::uint8_t>(1U << child_fragment);
      return true;
    }
  }
  return false;
}

bool refine_child_with_both(const terra::codec::height_diamond& parent,
                            const terra::codec::height_patch& detail) {
  terra::codec::height_refinement modern;
  if (parent.fragment_mask != 0x03U ||
      terra::codec::refine_cbdam_height(parent, detail, modern) !=
          terra::codec::hierarchy_status::ok) {
    return false;
  }
  const std::size_t vertex_count =
      static_cast<std::size_t>(parent.dimension + 1U) *
      (parent.dimension + 2U) / 2U;
  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices first(&owner, static_cast<int>(vertex_count), false);
  cbdam::diamond_vertices second(&owner, static_cast<int>(vertex_count), false);
  first.values() = parent.fragments[0].values;
  second.values() = parent.fragments[1].values;
  legacy_lifting legacy;
  legacy.init(static_cast<std::int32_t>(parent.dimension));
  const cbdam::grid_diamond unused;
  legacy.decode_values(to_legacy(detail), unused, &first, &second);
  return compare_refinement(legacy, modern);
}

const char* lookup_name(lookup_status status) {
  switch (status) {
    case lookup_status::found:
      return "found";
    case lookup_status::missing:
      return "missing";
    case lookup_status::io_error:
      return "io_error";
  }
  return "unknown";
}

std::string error_name(int error) {
  return error == 0 ? std::string() : db_strerror(error);
}

std::string json_string(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (char character : value) {
    if (character == '"' || character == '\\') {
      output << '\\';
    }
    output << character;
  }
  output << '"';
  return output.str();
}

void write_database(std::ostream& output, const char* name,
                    const database_status& status, bool trailing_comma) {
  output << "    \"" << name << "\": {\n"
         << "      \"opened\": " << (status.opened ? "true" : "false")
         << ",\n      \"structurally_complete\": "
         << (status.structurally_complete ? "true" : "false")
         << ",\n      \"expected_bytes\": " << status.expected_bytes
         << ",\n      \"actual_bytes\": " << status.actual_bytes
         << ",\n      \"readable_records\": " << status.readable_records
         << ",\n      \"cursor_error\": "
         << json_string(error_name(status.cursor_error)) << "\n    }"
         << (trailing_comma ? "," : "") << '\n';
}

void write_record(std::ostream& output, const char* name,
                  const lookup_result& result, bool trailing_comma) {
  output << "    \"" << name << "\": {\"status\": \""
         << lookup_name(result.status) << "\", \"bytes\": "
         << result.bytes.size() << ", \"error\": "
         << json_string(error_name(result.error_code)) << "}"
         << (trailing_comma ? "," : "") << '\n';
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: terra_sdk_globe_terrain_beijing_probe "
                 "TERRAIN_PREFIX SUMMARY_JSON\n";
    return 2;
  }
  const std::string prefix = argv[1];
  raw_database root_database;
  raw_database detail_database;
  const database_status root_status = root_database.open(prefix + ".root");
  const database_status detail_status = detail_database.open(prefix + ".data");

  const repository_key root_two_key = make_key(0, 134217728, -134217728);
  const repository_key root_three_key = make_key(-134217728, 134217728, 0);
  const repository_key beijing_child_key =
      make_key(-134217728, 134217728, -134217728);
  const lookup_result root_two = root_database.get(root_two_key);
  const lookup_result root_three = root_database.get(root_three_key);
  const lookup_result detail_two = detail_database.get(root_two_key);
  const lookup_result detail_three = detail_database.get(root_three_key);
  const lookup_result child_detail = detail_database.get(beijing_child_key);

  terra::codec::height_patch root_two_patch;
  terra::codec::height_patch root_three_patch;
  terra::codec::height_patch detail_two_patch;
  terra::codec::height_patch detail_three_patch;
  terra::codec::height_patch child_detail_patch;
  const bool decode_parity =
      decode_with_both(root_two, root_two_patch) &&
      decode_with_both(root_three, root_three_patch) &&
      (detail_two.status != lookup_status::found ||
       decode_with_both(detail_two, detail_two_patch)) &&
      (detail_three.status != lookup_status::found ||
       decode_with_both(detail_three, detail_three_patch)) &&
      (child_detail.status != lookup_status::found ||
       decode_with_both(child_detail, child_detail_patch));

  terra::codec::height_refinement root_two_refinement;
  terra::codec::height_refinement root_three_refinement;
  const bool root_two_refined =
      detail_two.status == lookup_status::found &&
      refine_root_with_both(root_two_patch, detail_two_patch,
                            root_two_refinement);
  const bool root_three_refined =
      detail_three.status == lookup_status::found &&
      refine_root_with_both(root_three_patch, detail_three_patch,
                            root_three_refinement);

  terra::codec::height_diamond shared_child;
  bool shared_child_assembled = false;
  bool child_refined = false;
  if (root_two_refined && root_three_refined) {
    const cbdam::grid_diamond root_two_geometry =
        cbdam::grid_diamond::cylindrical_canonical_root(2);
    const cbdam::grid_diamond root_three_geometry =
        cbdam::grid_diamond::cylindrical_canonical_root(3);
    shared_child_assembled =
        add_child_fragment(root_two_geometry, beijing_child_key,
                           root_two_refinement, shared_child) &&
        add_child_fragment(root_three_geometry, beijing_child_key,
                           root_three_refinement, shared_child) &&
        shared_child.fragment_mask == 0x03U;
    child_refined = shared_child_assembled &&
                    child_detail.status == lookup_status::found &&
                    refine_child_with_both(shared_child, child_detail_patch);
  }

  const std::uint32_t readable_detail_records =
      static_cast<std::uint32_t>(detail_two.status == lookup_status::found) +
      static_cast<std::uint32_t>(detail_three.status == lookup_status::found);
  const std::uint32_t fully_composed_lod_max =
      child_refined ? 2U : (shared_child_assembled ? 1U : 0U);
  const bool database_complete = root_status.structurally_complete &&
                                 detail_status.structurally_complete &&
                                 root_status.cursor_error == 0 &&
                                 detail_status.cursor_error == 0;
  const bool passed = database_complete && decode_parity &&
                      shared_child_assembled && child_refined;

  std::ofstream summary(argv[2], std::ios::out | std::ios::trunc);
  if (!summary) {
    std::cerr << "unable to create summary: " << argv[2] << '\n';
    return 2;
  }
  summary << "{\n"
          << "  \"schema\": \"terra.globe-terrain-beijing.v1\",\n"
          << "  \"target\": {\"longitude\": 116.0, \"latitude\": 40.0},\n"
          << "  \"passed\": " << (passed ? "true" : "false") << ",\n"
          << "  \"database_complete\": "
          << (database_complete ? "true" : "false") << ",\n"
          << "  \"databases\": {\n";
  write_database(summary, "root", root_status, true);
  write_database(summary, "detail", detail_status, false);
  summary << "  },\n  \"records\": {\n";
  write_record(summary, "root_2", root_two, true);
  write_record(summary, "root_3", root_three, true);
  write_record(summary, "detail_2", detail_two, true);
  write_record(summary, "detail_3", detail_three, true);
  write_record(summary, "beijing_child_detail", child_detail, false);
  summary << "  },\n"
          << "  \"decode_parity_cbdam_sdk\": "
          << (decode_parity ? "true" : "false") << ",\n"
          << "  \"root_2_refinement_parity\": "
          << (root_two_refined ? "true" : "false") << ",\n"
          << "  \"root_3_refinement_parity\": "
          << (root_three_refined ? "true" : "false") << ",\n"
          << "  \"shared_child_assembled\": "
          << (shared_child_assembled ? "true" : "false") << ",\n"
          << "  \"shared_child_refinement_parity\": "
          << (child_refined ? "true" : "false") << ",\n"
          << "  \"readable_root_detail_records\": "
          << readable_detail_records << ",\n"
          << "  \"fully_composed_lod_max\": "
          << fully_composed_lod_max << ",\n"
          << "  \"fully_composed_level_count\": "
          << (fully_composed_lod_max + 1U) << "\n}\n";

  std::cout << "Beijing globe terrain probe: "
            << (passed ? "passed" : "failed") << '\n'
            << "  database complete: "
            << (database_complete ? "yes" : "no") << '\n'
            << "  readable root detail records: "
            << readable_detail_records << "/2\n"
            << "  fully composed LOD: 0-" << fully_composed_lod_max << '\n'
            << "  summary: " << argv[2] << '\n';
  return passed ? 0 : 1;
}
