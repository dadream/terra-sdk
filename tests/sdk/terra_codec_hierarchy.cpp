#include <terra/codec/cbdam_hierarchy.hpp>

#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace {

void expect(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

terra::codec::height_patch synthetic_root(std::uint32_t dimension) {
  terra::codec::height_patch result;
  result.rows = dimension + 1U;
  result.columns = dimension + 1U;
  result.values.resize(
      static_cast<std::size_t>(result.rows) * result.columns);
  for (std::uint32_t y = 0U; y < result.rows; ++y) {
    for (std::uint32_t x = 0U; x < result.columns; ++x) {
      result.values[static_cast<std::size_t>(y) * result.columns + x] =
          static_cast<std::int32_t>(17 * y - 11 * x +
                                    5 * ((x + y) % 3U));
    }
  }
  return result;
}

terra::codec::height_patch synthetic_detail(std::uint32_t dimension) {
  terra::codec::height_patch result;
  result.rows = dimension;
  result.columns = dimension;
  result.values.resize(
      static_cast<std::size_t>(dimension) * dimension);
  for (std::uint32_t y = 0U; y < dimension; ++y) {
    for (std::uint32_t x = 0U; x < dimension; ++x) {
      const int sign = ((x + 2U * y) % 2U) == 0U ? 1 : -1;
      result.values[static_cast<std::size_t>(y) * dimension + x] =
          sign * static_cast<std::int32_t>(3U * x + 7U * y + 1U);
    }
  }
  return result;
}

}  // namespace

int main() {
  const std::uint32_t dimension = 4U;
  const terra::codec::height_patch root = synthetic_root(dimension);
  terra::codec::height_diamond diamond;
  expect(terra::codec::make_cbdam_root_height(root, diamond) ==
             terra::codec::hierarchy_status::ok,
         "unable to distribute root height");
  expect(diamond.dimension == dimension && diamond.fragment_mask == 0x03U,
         "root height identity changed");
  const std::size_t vertex_count =
      (dimension + 1U) * (dimension + 2U) / 2U;
  expect(diamond.fragments[0].values.size() == vertex_count &&
             diamond.fragments[1].values.size() == vertex_count,
         "root fragment layout changed");

  std::size_t count = 0U;
  for (std::uint32_t y = 0U; y <= dimension; ++y) {
    for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
      expect(diamond.fragments[0].values[count++] ==
                 root.values[static_cast<std::size_t>(y) * root.columns + x],
             "root fragment zero orientation changed");
    }
  }
  count = 0U;
  for (std::int32_t y = static_cast<std::int32_t>(dimension);
       y >= 0; --y) {
    for (std::int32_t x = static_cast<std::int32_t>(dimension);
         x >= static_cast<std::int32_t>(dimension) - y; --x) {
      expect(diamond.fragments[1].values[count++] ==
                 root.values[static_cast<std::size_t>(y) * root.columns +
                             static_cast<std::size_t>(x)],
             "root fragment one orientation changed");
    }
  }

  const terra::codec::height_patch detail = synthetic_detail(dimension);
  terra::codec::height_refinement refined;
  expect(terra::codec::refine_cbdam_height(diamond, detail, refined) ==
             terra::codec::hierarchy_status::ok,
         "unable to synthesize child heights");
  expect(refined.dimension == dimension && refined.child_mask == 0x0fU,
         "refinement child mask changed");
  for (std::size_t parent = 0U; parent < 2U; ++parent) {
    for (std::size_t child = 0U; child < 2U; ++child) {
      const std::size_t slot = 2U * parent + child;
      expect(refined.has_child(parent, child) &&
                 refined.children[slot].dimension == dimension &&
                 refined.children[slot].values.size() == vertex_count,
             "refined child layout changed");
    }
  }

  terra::codec::height_diamond one_fragment = diamond;
  one_fragment.fragment_mask = 0x01U;
  one_fragment.fragments[1] = terra::codec::height_fragment();
  expect(terra::codec::refine_cbdam_height(
             one_fragment, detail, refined) ==
             terra::codec::hierarchy_status::ok &&
             refined.child_mask == 0x03U,
         "single-fragment mirror contract changed");

  terra::codec::height_patch invalid_root = root;
  invalid_root.columns -= 1U;
  expect(terra::codec::make_cbdam_root_height(invalid_root, diamond) ==
             terra::codec::hierarchy_status::invalid_shape,
         "invalid root shape was accepted");

  terra::codec::height_diamond overflow_parent;
  overflow_parent.dimension = 1U;
  overflow_parent.fragment_mask = 0x03U;
  for (terra::codec::height_fragment& fragment :
       overflow_parent.fragments) {
    fragment.dimension = 1U;
    fragment.values.assign(3U, std::numeric_limits<std::int32_t>::max());
  }
  terra::codec::height_patch overflow_detail;
  overflow_detail.rows = 1U;
  overflow_detail.columns = 1U;
  overflow_detail.values.assign(
      1U, std::numeric_limits<std::int32_t>::max());
  expect(terra::codec::refine_cbdam_height(
             overflow_parent, overflow_detail, refined) ==
             terra::codec::hierarchy_status::arithmetic_overflow,
         "height arithmetic overflow was accepted");
  return 0;
}
