#include <terra/codec/cbdam_hierarchy.hpp>

#include <vic/cbdam/base/delta_codec.hpp>
#include <vic/cbdam/base/diamond_vertices.hpp>

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <vector>

namespace {

using legacy_base = cbdam::delta_codec<cbdam::height_operator,
                                       cbdam::diamond_vertices>;

class legacy_lifting : public legacy_base {
 public:
  void extract_child(std::size_t parent_fragment,
                     std::size_t child_index,
                     std::vector<std::int32_t>& output) {
    output.clear();
    output.reserve(
        static_cast<std::size_t>(patch_dim_ + 1) * (patch_dim_ + 2) / 2U);
    for (int y = 0; y <= patch_dim_; ++y) {
      for (int x = 0; x <= patch_dim_ - y; ++x) {
        output.push_back(matrix_values_[
            matrix_index(y, x, static_cast<int>(parent_fragment),
                         static_cast<int>(child_index))]);
      }
    }
  }
};

void expect(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

terra::codec::height_patch make_root(std::uint32_t dimension) {
  terra::codec::height_patch result;
  result.rows = dimension + 1U;
  result.columns = dimension + 1U;
  result.values.resize(
      static_cast<std::size_t>(result.rows) * result.columns);
  for (std::uint32_t y = 0U; y < result.rows; ++y) {
    for (std::uint32_t x = 0U; x < result.columns; ++x) {
      result.values[static_cast<std::size_t>(y) * result.columns + x] =
          static_cast<std::int32_t>(
              23 * static_cast<int>(y) - 19 * static_cast<int>(x) +
              7 * static_cast<int>((x + 2U * y) % 5U) - 13);
    }
  }
  return result;
}

terra::codec::height_patch make_detail(std::uint32_t dimension) {
  terra::codec::height_patch result;
  result.rows = dimension;
  result.columns = dimension;
  result.values.resize(
      static_cast<std::size_t>(dimension) * dimension);
  for (std::uint32_t y = 0U; y < dimension; ++y) {
    for (std::uint32_t x = 0U; x < dimension; ++x) {
      const int sign = ((3U * x + y) % 2U) == 0U ? 1 : -1;
      result.values[static_cast<std::size_t>(y) * dimension + x] =
          sign * static_cast<std::int32_t>(5U * x + 9U * y + 3U);
    }
  }
  return result;
}

legacy_base::array2_t to_legacy(const terra::codec::height_patch& patch) {
  legacy_base::array2_t result(patch.rows, patch.columns);
  for (std::uint32_t y = 0U; y < patch.rows; ++y) {
    for (std::uint32_t x = 0U; x < patch.columns; ++x) {
      result(y, x) =
          patch.values[static_cast<std::size_t>(y) * patch.columns + x];
    }
  }
  return result;
}

void compare_refinement(legacy_lifting& legacy,
                        const terra::codec::height_refinement& modern,
                        std::size_t parent_fragment,
                        std::size_t child_index) {
  std::vector<std::int32_t> expected;
  legacy.extract_child(parent_fragment, child_index, expected);
  const std::size_t slot = 2U * parent_fragment + child_index;
  expect(modern.has_child(parent_fragment, child_index),
         "modern child is missing");
  expect(modern.children[slot].values == expected,
         "CBDAM hierarchy differs from legacy lifting");
}

terra::codec::height_patch decode_record(const char* path) {
  std::ifstream input(path, std::ios::binary);
  expect(input.good(), "unable to open globe hierarchy record");
  const std::vector<std::uint8_t> bytes(
      (std::istreambuf_iterator<char>(input)),
      std::istreambuf_iterator<char>());
  terra::codec::height_patch_record record;
  expect(!bytes.empty() &&
             terra::codec::decode_cbdam_height_record(
                 bytes.data(), bytes.size(), record) ==
                 terra::codec::decode_status::ok &&
             !record.has_second,
         "unable to decode globe hierarchy record");
  return record.first;
}

terra::codec::height_refinement verify_root_chain(
    const char* root_path, const char* detail_path) {
  const terra::codec::height_patch root = decode_record(root_path);
  const terra::codec::height_patch detail = decode_record(detail_path);
  expect(root.rows == detail.rows + 1U &&
             root.columns == detail.columns + 1U,
         "globe root/detail dimensions changed");
  const std::uint32_t dimension = detail.rows;
  const std::size_t vertex_count =
      (dimension + 1U) * (dimension + 2U) / 2U;

  terra::codec::height_diamond modern_parent;
  expect(terra::codec::make_cbdam_root_height(root, modern_parent) ==
             terra::codec::hierarchy_status::ok,
         "unable to distribute globe root");

  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices parent0(
      &owner, static_cast<int>(vertex_count), false);
  cbdam::diamond_vertices parent1(
      &owner, static_cast<int>(vertex_count), false);
  legacy_lifting legacy;
  legacy.init(static_cast<std::int32_t>(dimension));
  const cbdam::grid_diamond unused;
  const legacy_base::array2_t legacy_root = to_legacy(root);
  const legacy_base::array2_t legacy_detail = to_legacy(detail);
  legacy.distribute_data_to_root(
      legacy_root, unused, &parent0, &parent1);
  expect(modern_parent.fragments[0].values == parent0.values() &&
             modern_parent.fragments[1].values == parent1.values(),
         "globe root distribution differs from legacy");

  legacy.decode_values(legacy_detail, unused, &parent0, &parent1);
  terra::codec::height_refinement modern;
  expect(terra::codec::refine_cbdam_height(
             modern_parent, detail, modern) ==
             terra::codec::hierarchy_status::ok,
         "unable to refine globe root");
  for (std::size_t parent = 0U; parent < 2U; ++parent) {
    for (std::size_t child = 0U; child < 2U; ++child) {
      compare_refinement(legacy, modern, parent, child);
    }
  }
  return modern;
}

void verify_globe_chain(const char* root0_path,
                        const char* detail0_path,
                        const char* root3_path,
                        const char* detail3_path,
                        const char* child_detail_path) {
  const terra::codec::height_refinement root0 =
      verify_root_chain(root0_path, detail0_path);
  const terra::codec::height_refinement root3 =
      verify_root_chain(root3_path, detail3_path);
  expect(root0.dimension == root3.dimension,
         "globe root patch dimensions differ");

  terra::codec::height_diamond shared_child;
  shared_child.dimension = root0.dimension;
  shared_child.fragment_mask = 0x03U;
  shared_child.fragments[0] = root0.children[0U];
  shared_child.fragments[1] = root3.children[3U];
  const terra::codec::height_patch child_detail =
      decode_record(child_detail_path);

  const std::size_t vertex_count =
      (shared_child.dimension + 1U) *
      (shared_child.dimension + 2U) / 2U;
  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices parent0(
      &owner, static_cast<int>(vertex_count), false);
  cbdam::diamond_vertices parent1(
      &owner, static_cast<int>(vertex_count), false);
  parent0.values() = shared_child.fragments[0].values;
  parent1.values() = shared_child.fragments[1].values;

  legacy_lifting legacy;
  legacy.init(static_cast<std::int32_t>(shared_child.dimension));
  const legacy_base::array2_t legacy_detail = to_legacy(child_detail);
  const cbdam::grid_diamond unused;
  legacy.decode_values(legacy_detail, unused, &parent0, &parent1);

  terra::codec::height_refinement modern;
  expect(terra::codec::refine_cbdam_height(
             shared_child, child_detail, modern) ==
             terra::codec::hierarchy_status::ok,
         "unable to refine shared globe child");
  bool nonzero = false;
  for (std::size_t parent = 0U; parent < 2U; ++parent) {
    for (std::size_t child = 0U; child < 2U; ++child) {
      compare_refinement(legacy, modern, parent, child);
      const std::vector<std::int32_t>& values =
          modern.children[2U * parent + child].values;
      for (std::int32_t value : values) {
        nonzero = nonzero || value != 0;
      }
    }
  }
  expect(nonzero, "globe child refinement unexpectedly stayed flat");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    return 2;
  }
  const std::uint32_t dimension = 8U;
  const terra::codec::height_patch root = make_root(dimension);
  const terra::codec::height_patch detail = make_detail(dimension);
  const legacy_base::array2_t legacy_root = to_legacy(root);
  const legacy_base::array2_t legacy_detail = to_legacy(detail);
  const std::size_t vertex_count =
      (dimension + 1U) * (dimension + 2U) / 2U;

  legacy_lifting legacy;
  legacy.init(static_cast<std::int32_t>(dimension));
  cbdam::reference_counted_owner owner;
  cbdam::diamond_vertices parent0(
      &owner, static_cast<int>(vertex_count), false);
  cbdam::diamond_vertices parent1(
      &owner, static_cast<int>(vertex_count), false);
  const cbdam::grid_diamond unused;
  legacy.distribute_data_to_root(
      legacy_root, unused, &parent0, &parent1);

  terra::codec::height_diamond modern_parent;
  expect(terra::codec::make_cbdam_root_height(root, modern_parent) ==
             terra::codec::hierarchy_status::ok,
         "modern root distribution failed");
  expect(modern_parent.fragments[0].values == parent0.values() &&
             modern_parent.fragments[1].values == parent1.values(),
         "modern root distribution differs from legacy");

  legacy.decode_values(legacy_detail, unused, &parent0, &parent1);
  terra::codec::height_refinement modern;
  expect(terra::codec::refine_cbdam_height(
             modern_parent, detail, modern) ==
             terra::codec::hierarchy_status::ok,
         "modern lifting failed");
  for (std::size_t parent = 0U; parent < 2U; ++parent) {
    for (std::size_t child = 0U; child < 2U; ++child) {
      compare_refinement(legacy, modern, parent, child);
    }
  }

  legacy_lifting fragment0_legacy;
  fragment0_legacy.init(static_cast<std::int32_t>(dimension));
  fragment0_legacy.decode_values(
      legacy_detail, unused, &parent0, nullptr);
  terra::codec::height_diamond fragment0_parent = modern_parent;
  fragment0_parent.fragment_mask = 0x01U;
  fragment0_parent.fragments[1] = terra::codec::height_fragment();
  expect(terra::codec::refine_cbdam_height(
             fragment0_parent, detail, modern) ==
             terra::codec::hierarchy_status::ok,
         "modern fragment zero mirror failed");
  compare_refinement(fragment0_legacy, modern, 0U, 0U);
  compare_refinement(fragment0_legacy, modern, 0U, 1U);

  legacy_lifting fragment1_legacy;
  fragment1_legacy.init(static_cast<std::int32_t>(dimension));
  fragment1_legacy.decode_values(
      legacy_detail, unused, nullptr, &parent1);
  terra::codec::height_diamond fragment1_parent = modern_parent;
  fragment1_parent.fragment_mask = 0x02U;
  fragment1_parent.fragments[0] = terra::codec::height_fragment();
  expect(terra::codec::refine_cbdam_height(
             fragment1_parent, detail, modern) ==
             terra::codec::hierarchy_status::ok,
         "modern fragment one mirror failed");
  compare_refinement(fragment1_legacy, modern, 1U, 0U);
  compare_refinement(fragment1_legacy, modern, 1U, 1U);

  verify_globe_chain(argv[1], argv[2], argv[3], argv[4], argv[5]);
  return 0;
}
