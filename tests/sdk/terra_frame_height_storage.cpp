#include <terra/frame/height_storage.hpp>

#include "observed_allocations.hpp"

#include <algorithm>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using terra::frame::height_storage;
using terra::codec::hierarchy_status;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
terra::codec::height_patch patch(std::uint32_t dimension, std::int32_t value) {
  terra::codec::height_patch result;
  result.rows = result.columns = dimension;
  result.values.assign(std::size_t(dimension) * dimension, value);
  return result;
}
void begin_observation() {
  using namespace test_allocations;
  require(live_bytes == 0U, "previous observed allocations are still alive");
  peak_bytes = allocations = largest_allocation = 0U;
  measuring = true;
}
void verify_root(std::uint32_t n) {
  const auto input = patch(n + 1U, 37);
  const auto size = 2U * height_storage::fragment_bytes(n);
  height_storage small(size - 1U), exact(size);
  height_storage::handle output;
  begin_observation();
  const auto rejected = small.root(input, output);
  test_allocations::measuring = false;
  require(rejected == hierarchy_status::resource_limit && !output, "root bypassed production admission");
  require(test_allocations::allocations == 0U, "root rejection allocated before admission");
  begin_observation();
  require(exact.root(input, output) == hierarchy_status::ok, "exact root capacity failed");
  std::shared_ptr<const height_storage::block> prepared = output;
  output.reset();
  require(exact.resident_bytes() == size && exact.work_bytes() == 0U,
          "cache removal refunded a prepared root");
  require(prepared->value().fragments[0].values.front() == 37, "held root changed after cache removal");
  require(test_allocations::peak_bytes >= size && test_allocations::peak_bytes <= exact.peak_bytes() + 256U,
          "root allocation exceeded its payload credit and bounded block metadata");
  prepared.reset();
  test_allocations::measuring = false;
  require(exact.resident_bytes() == 0U && test_allocations::live_bytes == 0U,
          "last root reader did not release actual storage");
}
void verify_refinement(std::uint32_t n) {
  const auto root = patch(n + 1U, 19), detail = patch(n, 2);
  const auto fragment = height_storage::fragment_bytes(n);
  const auto peak = 6U * fragment + height_storage::workspace_bytes(n);
  for (const bool enough : {false, true}) {
    height_storage storage(peak - (enough ? 0U : 1U));
    height_storage::handle parent;
    require(storage.root(root, parent) == hierarchy_status::ok, "create refinement parent");
    begin_observation();
    {
      height_storage::refinement work;
      const auto status = storage.refine(parent->value(), detail, 0U, work);
      if (!enough) {
        test_allocations::measuring = false;
        require(status == hierarchy_status::resource_limit && test_allocations::allocations == 0U,
                "one-byte-short refinement allocated its codec scratch");
      } else {
        require(status == hierarchy_status::ok && storage.work_bytes() == 4U * fragment,
                "codec completion did not retain only its output destinations");
        require(test_allocations::peak_bytes == peak - 2U * fragment,
                "codec allocation observation differs from funded peak");
        std::array<height_storage::handle, 4> children;
        for (std::size_t i = 0U; i < children.size(); ++i) {
          require(storage.replace(children[i], i % 2U, work, i), "admitted child did not transfer");
          require(!storage.replace(children[i], i % 2U, work, i), "child credit was consumed twice");
        }
        require(storage.work_bytes() == 0U && storage.resident_bytes() == 6U * fragment,
                "output transfer duplicated or refunded live payload");
        children = {};
        test_allocations::measuring = false;
      }
    }
    require(storage.work_bytes() == 0U && storage.resident_bytes() == 2U * fragment &&
            test_allocations::live_bytes == 0U, "refinement lifetime leaked output or workspace");
  }
}
void verify_partial_refinement(std::uint32_t n) {
  terra::codec::height_diamond parent;
  require(terra::codec::make_cbdam_root_height(patch(n + 1U, 19), parent) == hierarchy_status::ok,
          "create partial parent");
  parent.fragments[1] = terra::codec::height_fragment();
  parent.fragment_mask = 1U;
  const auto detail = patch(n, 2);
  const auto fragment = height_storage::fragment_bytes(n);
  const auto quote = 2U * fragment + height_storage::workspace_bytes(n);
  require(height_storage::refinement_bytes(parent, 0U) == quote,
          "partial parent was quoted for absent child fragments");
  for (const bool enough : {false, true}) {
    height_storage storage(quote - (enough ? 0U : 1U));
    begin_observation();
    {
      height_storage::refinement work;
      const auto status = storage.refine(parent, detail, 0U, work);
      if (enough) {
        require(status == hierarchy_status::ok && test_allocations::peak_bytes == quote &&
                storage.work_bytes() == 2U * fragment,
                "partial refinement quote differs from observed allocation");
      } else {
        require(status == hierarchy_status::resource_limit && test_allocations::allocations == 0U,
                "partial refinement allocated without its complete grant");
      }
    }
    test_allocations::measuring = false;
    require(test_allocations::live_bytes == 0U && storage.work_bytes() == 0U,
            "partial refinement retained its scratch or outputs");
  }
}
void verify_shared_destination() {
  const std::uint32_t n = 64U;
  const auto input = patch(n + 1U, 37), detail = patch(n, 3);
  const auto fragment = height_storage::fragment_bytes(n);
  height_storage storage(1024U * 1024U);
  height_storage::handle parent, current;
  require(storage.root(input, parent) == hierarchy_status::ok &&
          storage.root(input, current) == hierarchy_status::ok, "create shared inputs");
  std::shared_ptr<const height_storage::block> prepared = current;
  const auto old_values = prepared->value().fragments[0].values;
  begin_observation();
  {
    height_storage::refinement unpriced;
    require(storage.refine(parent->value(), detail, 0U, unpriced) == hierarchy_status::ok, "prepare unpriced-copy case");
    require(!storage.replace(current, 0U, unpriced, 0U), "copy spent a different child's output credit");
    require(current.get() == prepared.get() && storage.resident_bytes() == 4U * fragment,
            "rejected copy changed the shared destination");
  }
  {
    height_storage::refinement work;
    require(storage.refine(parent->value(), detail, height_storage::copy_bytes(current, 0U), work) == hierarchy_status::ok,
            "admit shared destination copy");
    const auto replacement = work.value().children[0].values;
    require(storage.replace(current, 0U, work, 0U), "copy-on-write replacement failed");
    require(current.get() != prepared.get() && prepared->value().fragments[0].values == old_values &&
            current->value().fragments[0].values == replacement && current->value().fragments[1].values == prepared->value().fragments[1].values,
            "replacement changed prepared samples or omitted the unaffected fragment");
    require(storage.resident_bytes() == 6U * fragment && storage.work_bytes() == 3U * fragment,
            "copied destination and old reader do not own distinct payloads");
  }
  current.reset();
  test_allocations::measuring = false;
  require(test_allocations::live_bytes == 0U && storage.resident_bytes() == 4U * fragment,
          "retiring the successor released its predecessor or leaked output");
  prepared.reset(); parent.reset();
  require(storage.resident_bytes() == 0U && storage.work_bytes() == 0U, "shared readers leaked height payload");
  height_storage::refinement invalid;
  terra::codec::height_diamond shape;
  shape.dimension = 64U;
  require(storage.refine(shape, detail, std::numeric_limits<std::size_t>::max(), invalid) == hierarchy_status::resource_limit,
          "copy capacity overflow bypassed the limit");
}
}  // namespace

int main() {
  try {
    for (const auto n : {2U, 8U, 64U, 256U}) { verify_root(n); verify_refinement(n); verify_partial_refinement(n); }
    verify_shared_destination();
    std::cout << "Height payload ownership, observed production peaks and immutable replacement passed\n";
  } catch (const std::exception& error) {
    test_allocations::measuring = false;
    std::cerr << error.what() << '\n'; return 1;
  }
}
