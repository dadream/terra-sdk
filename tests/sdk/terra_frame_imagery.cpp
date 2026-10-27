#include <terra/frame/imagery.hpp>
#include "observed_allocations.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

terra::frame::imagery_surface surface(std::uint32_t index) {
  terra::frame::imagery_surface value;
  value.draw_index = index;
  value.source = terra::imagery::node_key(0, 0, 0);
  terra::frame::measurement_region region;
  region.value.uv = terra::core::bounds2d(terra::core::vector2d{{0.0, 0.0}},
                                   terra::core::vector2d{{1.0, 1.0}});
  region.value.pixels_per_uv = 4096.0;
  value.regions.push_back(region);
  value.hull = {{{0.0, 0.0}}, {{1.0, 0.0}}, {{1.0, 1.0}}, {{0.0, 1.0}}};
  return value;
}

std::set<std::string> tiles(const terra::frame::imagery_cut& cut) {
  std::set<std::string> result;
  for (const auto& draw : *cut.draws) result.insert(std::to_string(draw.tile.level) + "/" +
      std::to_string(draw.tile.row) + "/" + std::to_string(draw.tile.column));
  return result;
}

void verify_snapshot_ownership() {
  using namespace test_allocations;
  constexpr std::size_t region_count = 16384U;
  for (const bool cancel : {false, true}) {
    live_bytes = peak_bytes = allocations = largest_allocation = 0U;
    measuring = true;
    std::size_t additional_peak = 0U;
    {
      terra::frame::imagery_controller controller;
      terra::frame::imagery_budget budget;
      budget.maximum_level = 0U;
      std::vector<terra::frame::imagery_surface> input{surface(7U)};
      input.front().regions.resize(region_count, input.front().regions.front());
      const auto before = live_bytes;
      peak_bytes = before;
      require(controller.begin(std::move(input), budget), "owned snapshot was rejected");
      additional_peak = peak_bytes - before;
      // Beginning an owned snapshot must not allocate a per-region index
      // array either. This fixed allowance is independent of its region count.
      require(additional_peak <= 4096U,
              "begin allocated region-sized work outside the continuation budget");
      if (!cancel) {
        auto cut = controller.update_step(1U, 1U, 0.0);
        require(cut.complete && cut.rebuilding && !cut.decisions_complete && cut.draws->empty(),
                "large input normalization escaped the initialization work budget");
        std::size_t rounds = 1U;
        while (!cut.decisions_complete) {
          require(cut.priority_update_count <= 1U && ++rounds < 1024U,
                  "input initialization exceeded its work allowance or failed to converge");
          cut = controller.update_step(1U, 1U, 0.0);
        }
        require(cut.complete && cut.decisions_complete && cut.draws->size() == 1U &&
                    cut.draws->front().draw_index == 7U && cut.maximum_pixel_error == 16.0,
                "transferred snapshot changed the imagery cut");
      }
    }
    measuring = false;
    std::fprintf(stderr, "imagery snapshot cancel=%d additional_peak=%zu live=%zu\n",
                 cancel, additional_peak, live_bytes);
    require(live_bytes == 0U, "owned snapshot survived controller destruction");
  }
  // Retained inputs still have value semantics, including continuation after
  // caller mutation/destruction and replacement of an older measurement epoch.
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_level = 0U;
  std::vector<terra::frame::imagery_surface> input{surface(9U)};
  require(controller.begin(input, budget), "borrowed snapshot was rejected");
  input.front().regions.front().value.pixels_per_uv = 256.0;
  require(controller.update_step(1U, 1U, 0.0).maximum_pixel_error == 16.0,
          "caller mutation changed an active snapshot");
  const auto replacement = controller.plan(std::move(input), budget);
  require(replacement.complete && replacement.maximum_pixel_error == 1.0,
          "snapshot replacement retained the previous measurement");
}

void verify_retained_inputs() {
  using namespace terra::frame;
  imagery_controller controller, foreign;
  imagery_budget budget; budget.maximum_level = 0U;
  auto a = surface(7U), b = surface(8U);
  a.regions.assign(4096U, a.regions.front());
  b.regions.assign(4096U, b.regions.front());
  b.source = terra::imagery::node_key(0, 0, 1);
  const auto old = controller.plan({a, b}, budget);
  require(old.complete && old.decisions_complete, "retained input fixture did not settle");
  auto first = controller.retain_surface(7U), second = controller.retain_surface(8U);
  require(first && second && first != second && !controller.retain_surface(999U), "input identities are not independent");
  imagery_surface next_a, next_b;
  next_a.draw_index = 80U; next_a.retained_input = first;
  next_b.draw_index = 70U; next_b.retained_input = second;
  auto added = surface(9U); added.source = terra::imagery::node_key(0, 0, 2);
  std::vector<imagery_surface> next{next_b, added, next_a};
  test_allocations::largest_allocation = 0U; test_allocations::measuring = true;
  const auto accepted = controller.begin(std::move(next), budget);
  test_allocations::measuring = false;
  require(accepted && test_allocations::largest_allocation < 4096U,
      "retaining immutable inputs copied their region payloads");
  imagery_cut cut;
  std::size_t work = 0U;
  do {
    cut = controller.update_step(1U, 1U, 0.0);
    work += cut.priority_update_count;
    require(work < 10U, "retained input repeated thousands of normalized regions");
  } while (!cut.decisions_complete);
  std::set<std::uint32_t> indices;
  for (const auto& draw : *cut.draws) indices.insert(draw.draw_index);
  require(indices == std::set<std::uint32_t>{9U,70U,80U}, "input identity was confused with reordered draw positions");
  require(controller.retain_surface(80U) == first && controller.retain_surface(70U) == second,
      "reordered members lost immutable input identity");
  require(old.draws->at(0).draw_index == 7U && old.draws->at(1).draw_index == 8U,
      "retargeting mutated an old output snapshot");
  require(!foreign.begin({next_a}, budget), "a foreign controller borrowed unaccounted input");
  controller.clear();
  require(controller.input_allocated_bytes() > 8192U * sizeof(measurement_region),
      "clear refunded externally retained measurement payloads");
  first.reset(); second.reset(); next_a.retained_input.reset(); next_b.retained_input.reset();
  require(controller.input_allocated_bytes() == 0U, "last input owner did not release its allocation");
}

void verify_retained_cell_measurements() {
  using namespace terra::frame;
  imagery_controller controller, oracle;
  imagery_budget budget;
  budget.maximum_level = 2U; budget.maximum_texture_count = 128U;
  auto a = surface(1U), removed = surface(2U), added = surface(3U);
  a.regions.assign(2048U, a.regions.front());
  removed.regions.assign(2048U, removed.regions.front());
  removed.source = terra::imagery::node_key(0, 0, 1);
  added.source = terra::imagery::node_key(0, 0, 2);
  added.regions.front().value.pixels_per_uv = 64.0;
  const auto old = controller.plan({a, removed}, budget);
  require(old.complete && old.decisions_complete && old.draws->size() == 32U,
      "cell reuse fixture did not refine both roots");
  imagery_surface retained; retained.draw_index = 9U;
  retained.retained_input = controller.retain_surface(1U);
  a.draw_index = 9U;
  // Rebinding a retained surface also permits a different tile-size budget.
  // Its per-cell cached error must be rescaled, not reused as the old SSE.
  budget.tile_size = 512U;
  const auto expected = oracle.plan({added, a}, budget);
  require(controller.begin({added, retained}, budget), "local successor rejected");
  imagery_cut cut;
  std::size_t priorities = 0U;
  do {
    cut = controller.update_step(1U, 1U, 0.0, 0U);
    priorities += cut.priority_update_count;
    require(!controller.reference_work_bytes(), "retained cell copied its region index allocation");
    require(priorities < 128U, "local successor replayed dense unchanged cell measurements");
  } while (!cut.decisions_complete);
  const auto equal = [](const imagery_cut& actual, const imagery_cut& reference) {
    require(actual.complete && actual.decisions_complete && actual.draws->size() == reference.draws->size(),
        "retained cell changed cut completeness");
    for (std::size_t i = 0U; i < actual.draws->size(); ++i) {
      const auto& left = actual.draws->at(i); const auto& right = reference.draws->at(i);
      require(left.draw_index == right.draw_index && left.tile.level == right.tile.level &&
          left.tile.row == right.tile.row && left.tile.column == right.tile.column && left.pixel_error == right.pixel_error,
          "retained cell changed draw binding, selection or exact SSE");
    }
  };
  equal(cut, expected);
  require(old.draws->front().draw_index == 1U && old.maximum_pixel_error == 4.0,
      "cell reuse mutated a previously published cut");
  // Evicted index arrays are only a cache miss: never reuse a remembered error
  // as proof that a now-empty reference covers this new cut.
  controller.reclaim_references(std::size_t(-1), 4096U, true);
  require(controller.reference_allocated_bytes() == 0U, "terminal index cache did not retire");
  equal(controller.plan({retained, added}, budget), oracle.plan({a, added}, budget));
  // Replacing the measurement at the same source/draw position must invalidate
  // old fine intersections rather than inherit their input identity.
  a.regions.assign(1U, a.regions.front()); a.regions.front().value.pixels_per_uv = 64.0;
  equal(controller.plan({a, added}, budget), oracle.plan({a, added}, budget));
}

void verify_reuse_lookup_work() {
  using namespace terra::frame;
  for (const std::uint32_t count : {64U, 256U}) {
    imagery_controller controller, oracle;
    imagery_budget budget;
    budget.maximum_level = 1U; budget.maximum_texture_count = 4U;
    budget.maximum_draw_count = 4096U;
    std::vector<imagery_surface> fresh;
    for (std::uint32_t i = 0U; i < count; ++i) {
      auto item = surface(i); item.regions.front().value.pixels_per_uv = 1024.0;
      fresh.push_back(std::move(item));
    }
    const auto old = controller.plan(fresh, budget);
    require(old.decisions_complete && old.draws->size() == 4U * count,
        "reuse lookup fixture did not refine its common root");
    std::vector<imagery_surface> retained;
    for (std::uint32_t i = 0U; i < count; ++i) {
      imagery_surface item; item.draw_index = count + i;
      item.retained_input = controller.retain_surface(i);
      retained.push_back(std::move(item)); fresh[i].draw_index = count + i;
    }
    std::reverse(retained.begin(), retained.end());
    std::reverse(fresh.begin(), fresh.end());
    budget.tile_size = 512U;
    const auto expected = oracle.plan(fresh, budget);
    require(controller.begin(std::move(retained), budget), "reuse lookup successor rejected");
    imagery_cut cut;
    std::size_t work = 0U;
    do {
      cut = controller.update_step(1U, 1U, 0.0, 0U);
      work += cut.priority_update_count;
      require(cut.complete && cut.priority_update_count <= 1U && cut.change_count <= 1U &&
          !controller.reference_work_bytes(), "reuse lookup lost bounded work or copied cached indices");
      require(work < 10000U, "reuse lookup did not converge");
    } while (!cut.decisions_complete);
    std::fprintf(stderr, "imagery reuse members=%u work=%zu\n", count, work);
    require(work <= 2U * count + 32U,
        "retained members repeatedly scanned the same cached child references");
    require(cut.draws->size() == expected.draws->size() && cut.maximum_pixel_error == 1.0,
        "reuse lookup changed coverage or rescaled SSE");
    for (std::size_t i = 0U; i < cut.draws->size(); ++i) {
      const auto& a = cut.draws->at(i); const auto& b = expected.draws->at(i);
      require(a.draw_index == b.draw_index && a.tile.level == b.tile.level &&
          a.tile.row == b.tile.row && a.tile.column == b.tile.column && a.pixel_error == b.pixel_error,
          "reuse lookup disagrees with independent fresh planning");
    }
    require(old.draws->front().draw_index == 0U && old.maximum_pixel_error == 2.0,
        "reuse lookup mutated its old publication");
  }
}

void verify_reuse_lookup_lifetime() {
  using namespace terra::frame;
  for (const unsigned mode : {0U, 1U, 2U, 3U}) {
    imagery_controller controller, oracle;
    const auto base = controller.allocated_bytes();
    imagery_budget budget;
    budget.maximum_level = 1U; budget.maximum_texture_count = 4U;
    budget.maximum_draw_count = 4096U;
    auto original = surface(1U); original.regions.front().value.pixels_per_uv = 1024.0;
    require(controller.plan({original}, budget).decisions_complete, "duplicate seed did not settle");
    auto input = controller.retain_surface(1U);
    std::vector<imagery_surface> shared, fresh;
    for (std::uint32_t i = 0U; i < 32U; ++i) {
      imagery_surface item; item.draw_index = 100U + i; item.retained_input = input;
      shared.push_back(std::move(item));
      auto copy = original; copy.draw_index = 200U + i; fresh.push_back(std::move(copy));
    }
    auto old = controller.plan(shared, budget);
    require(old.decisions_complete && old.draws->size() == 128U, "duplicate members did not refine");
    std::reverse(shared.begin(), shared.end());
    for (std::size_t i = 0U; i < shared.size(); ++i) shared[i].draw_index = 200U + i;
    budget.tile_size = 512U;
    require(controller.begin(shared, budget), "duplicate reuse rejected");
    imagery_cut cut;
    for (unsigned step = 0U;; ++step) {
      cut = controller.update_step(1U, 1U, 0.0, mode == 0U ? 0U : std::size_t(-1));
      require(cut.complete && cut.priority_update_count <= 1U && cut.change_count <= 1U && step < 4096U,
          "duplicate lookup escaped its bounded continuation");
      if (mode == 0U) require(!controller.reference_work_bytes(), "duplicate lookup aliased or recopied region payloads");
      if (step == 1U && mode == 1U) {
        require(controller.reclaim_references(std::size_t(-1), 4096U, true).released_bytes > 0U,
            "lookup pressure fixture did not reclaim cached indices");
      }
      if (step == 1U && mode >= 2U) {
        if (mode == 2U) {
          auto changed = surface(900U); changed.regions.front().value.pixels_per_uv = 64.0;
          shared = {changed}; fresh = {changed};
        } else {
          std::reverse(shared.begin(), shared.end());
          for (std::size_t i = 0U; i < shared.size(); ++i) shared[i].draw_index = fresh[i].draw_index;
        }
        require(controller.begin(shared, budget), "cancelled lookup could not replace its input");
      }
      if (cut.decisions_complete) break;
    }
    const auto expected = oracle.plan(fresh, budget);
    require(cut.draws->size() == expected.draws->size() && cut.maximum_pixel_error == expected.maximum_pixel_error,
        "lookup pressure/cancellation changed coverage or SSE");
    for (std::size_t i = 0U; i < cut.draws->size(); ++i) {
      const auto& a = cut.draws->at(i); const auto& b = expected.draws->at(i);
      require(a.draw_index == b.draw_index && a.tile.level == b.tile.level &&
          a.tile.row == b.tile.row && a.tile.column == b.tile.column && a.pixel_error == b.pixel_error,
          "duplicate, reclaimed or cancelled lookup used another member's cached reference");
    }
    require(old.draws->front().draw_index == 100U && old.maximum_pixel_error == 2.0,
        "lookup retirement mutated an immutable publication");
    old.draws.reset(); cut.draws.reset();
    controller.clear();
    require(controller.allocated_bytes() == base + controller.input_allocated_bytes(),
        "lookup retirement retained registry or reference metadata");
  }
}

void verify_input_registry_credit() {
  using namespace terra::frame;
  imagery_controller controller;
  const auto base = controller.allocated_bytes();
  imagery_budget budget; budget.maximum_level = 0U;
  std::vector<imagery_surface> members;
  for (std::uint32_t i = 0U; i < 64U; ++i) members.push_back(surface(i));
  require(controller.plan(std::move(members), budget).decisions_complete, "registry seed rejected");
  std::vector<std::shared_ptr<const imagery_surface_input>> handles;
  for (std::uint32_t i = 0U; i < 64U; ++i) handles.push_back(controller.retain_surface(i));
  controller.clear();
  const auto retained_bytes = controller.input_allocated_bytes();
  members.reserve(handles.size());
  for (const auto& handle : handles) {
    imagery_surface member; member.draw_index = static_cast<std::uint32_t>(members.size());
    member.retained_input = handle; members.push_back(std::move(member));
  }
  const auto quote = imagery_controller::input_work_bytes(members.size(), 0U, 0U, 0U);
  require(controller.begin(std::move(members), budget), "credited registry rejected");
  const auto owned = controller.input_allocated_bytes() - retained_bytes;
  require(owned > handles.size() * sizeof(imagery_surface) && owned <= quote,
      "member registry is missing from the producer-owned input quote or exceeds it");
  controller.clear();
  require(controller.input_allocated_bytes() == retained_bytes, "registry retirement refunded immutable inputs");
  handles.clear();
  require(controller.input_allocated_bytes() == 0U && controller.allocated_bytes() == base,
      "registry or retained input survived its final owner");
}

void verify_output_lifetime() {
  terra::frame::imagery_cut held;
  {
    terra::frame::imagery_controller controller;
    terra::frame::imagery_budget budget;
    budget.maximum_texture_count = budget.maximum_draw_count = 4096U;
    held = controller.plan({surface(3U)}, budget);
    require(held.draws->size() >= 256U, "output lifetime fixture did not create a large cut");
    test_allocations::allocations = 0U;
    test_allocations::measuring = true;
    const auto repeated = controller.update_step(0U, 0U, 0.0);
    test_allocations::measuring = false;
    require(repeated.draws == held.draws && test_allocations::allocations == 0U,
            "unchanged large output allocated another draw list");
    controller.clear();
    auto distant = surface(42U); distant.regions.front().value.pixels_per_uv = 64.0;
    const auto next = controller.plan({distant}, budget);
    require(next.draws != held.draws && next.draws->size() == 1U,
            "reset reused a stale draw snapshot");
  }
  require(held.draws->size() >= 256U && held.draws->front().draw_index == 3U &&
              held.draws->front().pixel_error == 1.0,
          "output snapshot borrowed the destroyed controller");
}

void verify_memory_ownership() {
  using namespace test_allocations;
  live_bytes = peak_bytes = allocations = largest_allocation = 0U;
  measuring = true;
  {
    terra::frame::imagery_controller a, b;
    const auto base_a = a.allocated_bytes(), base_b = b.allocated_bytes();
    // Account control blocks are fixed bootstrap overhead; every owned input,
    // map/vector/string capacity and snapshot below must match real new/delete.
    const auto bootstrap = live_bytes - base_a - base_b;
    unsigned observation = 0U;
    const auto check = [&]() {
      ++observation;
      if (live_bytes != a.allocated_bytes() + b.allocated_bytes() + bootstrap)
        std::fprintf(stderr, "imagery memory observation=%u actual=%zu a=%zu b=%zu bootstrap=%zu\n",
          observation, live_bytes, a.allocated_bytes(), b.allocated_bytes(), bootstrap);
      require(live_bytes == a.allocated_bytes() + b.allocated_bytes() + bootstrap,
              "imagery allocation ownership disagrees with real new/delete");
    };
    terra::frame::imagery_budget budget;
    budget.maximum_level = 2U; budget.maximum_texture_count = 16U;
    {
      auto input = surface(1U);
      input.regions.resize(2048U, input.regions.front());
      std::vector<terra::frame::imagery_surface> values;
      values.push_back(std::move(input));
      require(a.begin(std::move(values), budget), "accounted input failed");
    }
    check();
    auto other = b.plan({surface(2U)}, budget);
    check();
    const auto independent = b.allocated_bytes();
    terra::frame::imagery_cut held;
    for (unsigned i = 0U; i < 4096U; ++i) {
      auto cut = a.update_step(1U, 1U, 0.0);
      if (!cut.rebuilding && !held.draws) held = cut;
      check();
      require(b.allocated_bytes() == independent, "interleaving charged another imagery owner");
      if (cut.decisions_complete) break;
      require(i != 4095U, "accounted work did not complete");
    }
    check();
    require(a.peak_allocated_bytes() >= a.allocated_bytes(), "allocation peak is below residency");
    require(a.accept_cut({terra::imagery::node_key(0, 0, 0)}, 1U), "accounted collapse failed");
    check();
    a.clear();
    require(a.allocated_bytes() > base_a, "clear refunded a retained immutable output");
    check();
    held.draws.reset();
    require(a.allocated_bytes() == base_a, "released output retained its old tree ownership");
    check();
    b.clear(); other.draws.reset();
    require(b.allocated_bytes() == base_b, "reset retained child or exchange work");
    check();
    // A source callback may enter another controller on the same thread. Its
    // scope must restore the first owner before later nodes/strings allocate.
    budget.maximum_level = 0U;
    budget.resource_key = [&](const terra::imagery::node_key&, double) {
      terra::frame::imagery_budget other_budget; other_budget.maximum_level = 0U;
      b.plan({surface(9U)}, other_budget);
      return std::string(128U, '\0');
    };
    require(a.plan({surface(7U)}, budget).complete, "resource identity was truncated at a zero byte");
    check();
    std::fprintf(stderr, "imagery owned bytes=%zu other=%zu bootstrap=%zu peak=%zu\n",
      a.allocated_bytes(), b.allocated_bytes(), bootstrap, a.peak_allocated_bytes());
  }
  measuring = false;
  require(live_bytes == 0U, "imagery accounts escaped destruction");
}

void verify_reference_credit() {
  terra::frame::imagery_controller controller, oracle;
  terra::frame::imagery_budget budget;
  budget.maximum_level = 2U; budget.maximum_texture_count = 16U;
  auto input = surface(1U);
  input.regions.resize(2048U, input.regions.front());
  const auto expected = oracle.plan({input}, budget);
  require(controller.begin({input}, budget), "reference input rejected");
  terra::frame::imagery_cut cut;
  for (unsigned i = 0; !controller.reference_work_bytes(); ++i) {
    require(i < 256U, "reference work quote never appeared");
    cut = controller.update_step(1U, 1U, 0.0, 0U);
  }
  require(controller.reference_allocated_bytes() == 0U, "unfunded reference was allocated");
  const auto first = controller.reference_work_bytes();
  const auto held = cut.draws;
  for (unsigned i = 0; i < 3U; ++i) {
    cut = controller.update_step(16U, 64U, 0.0, first - 1U);
    require(controller.reference_work_bytes() == first && controller.reference_allocated_bytes() == 0U &&
        cut.draws == held && !cut.decisions_complete, "refusal consumed the cursor or changed its cut");
  }
  unsigned grants = 0U;
  for (unsigned i = 0; !cut.decisions_complete; ++i) {
    require(i < 4096U, "funded reference continuation failed to converge");
    const auto grant = controller.reference_work_bytes(), before = controller.reference_allocated_bytes();
    if (grant) ++grants;
    cut = controller.update_step(1U, 8U, 0.0, grant);
    require(controller.reference_allocated_bytes() <= before + grant, "reference exceeded its allocation grant");
  }
  require(grants > 8U && cut.draws->size() == expected.draws->size(), "reference grants lost topology");
  for (std::size_t i = 0; i < cut.draws->size(); ++i) {
    const auto& a = (*cut.draws)[i]; const auto& b = (*expected.draws)[i];
    require(a.tile.level == b.tile.level && a.tile.row == b.tile.row &&
        a.tile.column == b.tile.column && a.pixel_error == b.pixel_error, "reference waits changed texture selection");
  }
  require(controller.reference_allocated_bytes() > 0U && oracle.reference_allocated_bytes() > 0U,
      "reference residency was not recorded");
  controller.clear();
  require(controller.reference_allocated_bytes() == 0U && controller.reference_work_bytes() == 0U,
      "reference reset retained its buffers or pending quote");
  require(held && !held->empty(), "reset invalidated immutable display output");
}

void verify_output_credit() {
  auto input = surface(8U);
  terra::frame::imagery_budget budget;
  budget.maximum_level = 4U; budget.maximum_texture_count = 128U;
  terra::frame::imagery_controller controller, oracle;
  const auto expected = oracle.plan({input}, budget);
  require(controller.begin({input}, budget), "funded output input rejected");
  terra::frame::imagery_cut cut;
  std::shared_ptr<const std::vector<terra::frame::imagery_draw>> retained;
  std::size_t refusals = 0U;
  for (unsigned round = 0U; ; ++round) {
    require(round < 8192U, "funded output failed to converge");
    cut = controller.update_step(1U, 1U, 0.0, std::size_t(-1), 0U);
    if (cut.output_pending) {
      ++refusals;
      const auto needed = controller.output_work_bytes(), before = controller.output_allocated_bytes();
      require(needed > 0U, "output refusal omitted its allocation quote");
      const auto pending = controller.update_step(1U, 1U, 0.0, std::size_t(-1), needed - 1U);
      require(pending.output_pending && controller.output_work_bytes() == needed &&
          controller.output_allocated_bytes() == before && pending.change_count == 0U &&
          pending.priority_update_count == 0U, "output refusal allocated or advanced past publication");
      cut = controller.update_step(1U, 1U, 0.0, std::size_t(-1), needed);
      require(!cut.output_pending && controller.output_work_bytes() == 0U &&
          controller.output_allocated_bytes() <= before + needed,
          "exact output credit did not fund the immutable snapshot");
      if (!retained && cut.draws && !cut.draws->empty()) retained = cut.draws;
    }
    if (cut.decisions_complete) break;
  }
  require(refusals > 1U && tiles(cut) == tiles(expected) &&
      cut.maximum_pixel_error == expected.maximum_pixel_error, "output admission changed imagery selection");
  require(retained && !retained->empty(), "output fixture retained no publication");
  const auto retained_bytes = retained->capacity() * sizeof(terra::frame::imagery_draw);
  cut.draws.reset(); controller.clear();
  require(controller.output_allocated_bytes() == retained_bytes,
      "reset refunded a retained immutable output snapshot");
  retained.reset();
  require(controller.output_allocated_bytes() == 0U, "released output snapshot retained credit");
  require(controller.begin({input}, budget), "interleaved output input rejected");
  cut = controller.update_step(16U, 128U, 0.0, 4U * sizeof(std::size_t), 0U);
  const auto reference_quote = controller.reference_work_bytes(), output_quote = controller.output_work_bytes();
  require(cut.output_pending && reference_quote && output_quote, "fixture lost independent allocation stops");
  cut = controller.update_step(16U, 128U, 0.0, 0U, output_quote);
  require(!cut.output_pending && controller.reference_work_bytes() == reference_quote,
      "output publication lost an unconsumed index allocation quote");
}

void verify_reference_reclamation() {
  for (bool projective : {false, true}) {
    auto input = surface(5U);
    input.regions.clear();
    for (unsigned row = 0; row < 8U; ++row) for (unsigned col = 0; col < 8U; ++col) {
      terra::frame::measurement_region region;
      region.value.uv = terra::core::bounds2d({{col / 8.0, row / 8.0}}, {{(col + 1U) / 8.0, (row + 1U) / 8.0}});
      region.value.pixels_per_uv = 2048.0 + 64.0 * col;
      if (projective) {
        region.flags=3U;region.value.projection = {{0.0, 512.0, 0.0, 0.0, 0.0, 512.0, 0.02, 0.5, 0.25}};
        region.value.triangle = {{{{col / 8.0, row / 8.0}}, {{(col + 1U) / 8.0, row / 8.0}},
          {{col / 8.0, (row + 1U) / 8.0}}}};
      }
      input.regions.push_back(region);
    }
    terra::frame::imagery_budget budget;
    budget.maximum_level = 4U; budget.maximum_texture_count = 256U;
    terra::frame::imagery_controller oracle, controller;
    require(oracle.begin({input}, budget), "oracle input rejected");
    terra::frame::imagery_cut expected;
    std::size_t expected_work = 0U;
    do {
      expected = oracle.update_step(1U, 1U, 0.0);
      expected_work += expected.priority_update_count;
    } while (!expected.decisions_complete);
    require(controller.begin({input}, budget), "reclaimable input rejected");
    terra::frame::imagery_cut cut;
    std::size_t released = 0U, trims = 0U, actual_work = 0U;
    for (unsigned round = 0; ; ++round) {
      require(round < 8192U, "reclaimed references did not resume to completion");
      cut = controller.update_step(1U, 1U, 0.0);
      require(cut.priority_update_count <= 1U, "reclamation escaped its work allowance");
      actual_work += cut.priority_update_count;
      if (round % 17U == 9U || cut.decisions_complete) {
        bool restart = true;
        for (;;) {
          const auto before = controller.reference_allocated_bytes();
          const auto progress = controller.reclaim_references(std::size_t(-1), 3U, restart);
          restart = false; ++trims;
          require(progress.visited <= 3U && before - controller.reference_allocated_bytes() == progress.released_bytes,
              "reference trim violated its work or release receipt");
          released += progress.released_bytes;
          if (!progress.pending) break;
        }
      }
      if (cut.decisions_complete) break;
    }
    require(released && trims > 4U && controller.reference_allocated_bytes() < oracle.reference_allocated_bytes(),
        "consumed reference caches were not reclaimable");
    require(actual_work == expected_work, "reclamation repeated pending refinement work");
    require(tiles(cut) == tiles(expected) && cut.maximum_pixel_error == expected.maximum_pixel_error &&
        cut.selected_texture_count == expected.selected_texture_count && cut.draws->size() == expected.draws->size(),
        "reclaiming reference caches changed spatial selection or quality");
    for (std::size_t i = 0; i < cut.draws->size(); ++i)
      require((*cut.draws)[i].pixel_error == (*expected.draws)[i].pixel_error,
          "reclamation changed a selected regional error");
    const auto snapshot = cut.draws;
    require(controller.update_step(1U, 1U, 0.0).draws == snapshot, "reclamation republished the same cut");
    // Admission notifications do not alter index eligibility. Interleaving
    // them with a no-op scan must not repeatedly rewind its cursor.
    for (unsigned round = 0; ; ++round) {
      require(round < 4096U, "empty admission notifications restarted reclamation forever");
      require(controller.accept_cut({}, 100U + round), "empty admission rejected");
      const auto progress = controller.reclaim_references(1U, 3U, round == 0U);
      require(progress.released_bytes == 0U, "reclaimed index cache grew during notification");
      if (!progress.pending) break;
    }
  }
}

void verify_initialization_replacement() {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_level = 0U;
  auto large = surface(1U);
  large.regions.resize(4096U, large.regions.front());
  auto replacement = surface(2U);
  replacement.regions.front().value.pixels_per_uv = 64.0;
  for (const unsigned steps : {0U, 1U, 31U, 63U}) {
    require(controller.begin({large}, budget), "large replacement input was rejected");
    for (unsigned i = 0; i < steps; ++i) {
      const auto partial = controller.update_step(1U, 1U, 0.0);
      require(partial.rebuilding && partial.draws->empty(), "incomplete roots escaped initialization");
    }
    const auto cut = controller.plan({replacement}, budget);
    require(cut.decisions_complete && cut.draws->size() == 1U &&
                cut.draws->front().draw_index == 2U && cut.maximum_pixel_error == 0.25,
            "replacement resumed obsolete initialization work");
  }
  // A cheap root estimate cannot grant source capacity before normalization.
  auto other = replacement;
  other.source.column = 1;
  budget.maximum_texture_count = 1U;
  require(controller.begin({replacement, other}, budget), "input staging did not accept valid regions");
  require(!controller.update_step(1U, 1U, 0.0).complete,
          "normalization published a base cut outside the physical resource budget");
  require(controller.plan({replacement}, budget).complete,
          "a rejected initialization poisoned the next valid snapshot");
}

void verify_initialization_boundaries() {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_level = 0U;
  const auto held = controller.plan({surface(17U)}, budget);
  unsigned bindings = 0U;
  budget.resource_key = [&](const terra::imagery::node_key&, double) {
    ++bindings;
    return std::string("root");
  };
  auto empty = surface(0U); empty.regions.clear();
  std::vector<terra::frame::imagery_surface> input(1024U, empty);
  input.push_back(surface(23U));
  require(controller.begin(std::move(input), budget), "empty surface sequence was rejected");
  const auto paused = controller.update_step(1U, 0U, 0.0);
  require(paused.rebuilding && paused.draws->empty() && bindings == 0U,
          "zero credits performed root initialization");
  for (unsigned i = 0U; i < 16U; ++i) {
    const auto cut = controller.update_step(1U, 1U, 0.0);
    require(cut.rebuilding && cut.draws->empty() && cut.priority_update_count == 1U && bindings == 0U,
            "empty surfaces escaped the 64-boundary initialization allowance");
  }
  const auto complete = controller.update_step(1U, 2U, 0.0);
  require(complete.decisions_complete && complete.draws->size() == 1U &&
              complete.draws->front().draw_index == 23U && bindings == 1U,
          "bounded surface grouping failed to finish or bound the root twice");

  // Late invalid data must fail without exposing partial roots. Native callers
  // receive this failure from update_step; plan still completes validation.
  for (unsigned invalid = 0U; invalid < 3U; ++invalid) {
    auto large = surface(29U);
    large.regions.resize(129U, large.regions.front());
    auto& last = large.regions.back();
    if (invalid == 0U) last.value.pixels_per_uv = std::numeric_limits<double>::quiet_NaN();
    else if (invalid == 1U) last.value.pixels_per_uv = -1.0;
    else last.value.uv.maximum[1] = std::numeric_limits<double>::infinity();
    bindings = 0U;
    require(controller.begin({large}, budget), "begin scanned individual input regions");
    for (unsigned i = 0U; i < 2U; ++i) {
      const auto cut = controller.update_step(1U, 1U, 0.0);
      require(cut.rebuilding && cut.draws->empty() && bindings == 0U,
              "initialization read beyond its region allowance");
    }
    require(!controller.update_step(1U, 1U, 0.0).complete && bindings == 0U,
            "invalid region published or bound a partial root");
    require(!controller.plan({large}, budget).complete,
            "synchronous planning accepted an invalid region");
    require(controller.plan({surface(31U)}, budget).decisions_complete,
            "failed initialization prevented subsequent planning");
  }
  require(held.draws->size() == 1U && held.draws->front().draw_index == 17U,
          "initialization replacement mutated a retained display cut");
  require(controller.plan({}, budget).decisions_complete,
          "empty input did not complete initialization");
}

void verify_child_measurement_slices() {
  constexpr std::size_t region_count = 8192U;
  for (const bool projective : {false, true}) {
    terra::frame::imagery_budget budget;
    budget.maximum_level = 1U;
    budget.maximum_texture_count = 4U;
    auto small = surface(41U);
    small.regions[0].value.pixels_per_uv = 512.0;
    if (projective) {
      auto& region = small.regions[0];
      region.flags=3U;region.value.projection = {{0.0, 512.0, 0.0, 0.0, 0.0, 512.0, 0.02, 0.5, 0.25}};
      region.value.triangle = {{{{0.0, 0.0}}, {{1.0, 0.0}}, {{0.0, 1.0}}}};
      auto other = region;
      other.value.triangle = {{{{1.0, 1.0}}, {{0.0, 1.0}}, {{1.0, 0.0}}}};
      small.regions.push_back(other);
    }
    terra::frame::imagery_controller oracle;
    const auto expected = oracle.plan({small}, budget);
    auto large = small;
    large.regions.clear();
    for (std::size_t i = 0U; i < region_count; ++i) large.regions.push_back(small.regions[i % small.regions.size()]);
    // Repeated convex edges define exactly the same domain. They also expose
    // an otherwise unbounded hull-only loop, independently of region clipping.
    for (unsigned i = 1U; i < 128U; ++i) large.hull.insert(large.hull.end(), small.hull.begin(), small.hull.end());
    terra::frame::imagery_controller controller;
    require(controller.begin({large}, budget), "dense child fixture was rejected");
    terra::frame::imagery_cut cut;
    unsigned initialization = 0U;
    do {
      cut = controller.update_step(0U, 1U, 0.0);
      require(++initialization < 256U && cut.complete && cut.change_count == 0U,
              "dense root initialization failed");
    } while (cut.rebuilding);
    const auto root_tiles = tiles(cut);
    const auto root_output = cut.draws;
    require(root_tiles.size() == 1U && !cut.decisions_complete, "dense fixture has no pending refinement");
    unsigned slices = 0U, changes = 0U;
    do {
      cut = controller.update_step(1U, 1U, 0.0);
      require(cut.complete && !cut.rebuilding && cut.priority_update_count <= 1U && cut.change_count <= 1U,
              "child measurement violated its work allowance");
      changes += cut.change_count;
      require(cut.change_count ? cut.draws != root_output : cut.draws == root_output,
              "measurement progress rebuilt the draw snapshot or changed cut retained old identity");
      if (!cut.change_count) require(tiles(cut) == root_tiles && !cut.decisions_complete &&
          cut.pending_refinement_count > 0U, "incomplete children replaced the parent or lost their queue entry");
      require(++slices < 1024U, "child measurement did not converge");
      if (!cut.decisions_complete && slices % 17U == 0U)
        require(controller.accept_cut({small.source}, slices), "unchanged-parent receipt rejected pending child work");
    } while (!cut.decisions_complete);
    require(slices >= 4U * region_count / 64U && changes == 1U,
            "dense child scanning escaped the per-priority work limit");
    require(root_output->size() == 1U && root_output->front().tile.level == 0,
            "refinement mutated a retained parent snapshot");
    require(tiles(cut) == tiles(expected) && cut.draws->size() == expected.draws->size() &&
                cut.maximum_pixel_error == expected.maximum_pixel_error &&
                cut.limited_by_level == expected.limited_by_level,
            "sliced children changed the independent compact-domain result");
    std::fprintf(stderr, "imagery child projective=%d regions=%zu hull=%zu slices=%u\n",
                 projective, region_count, large.hull.size(), slices);
    require(controller.begin({large}, budget), "dense retained cut could not rebase");
    unsigned retained_slices = 0U;
    do {
      cut = controller.update_step(1U, 1U, 0.0);
      require(cut.complete && cut.change_count == 0U && ++retained_slices < 1024U,
              "retained child measurement changed topology or failed to converge");
      if (!cut.decisions_complete) require(cut.rebuilding,
          "partially remeasured retained children became publishable");
    } while (!cut.decisions_complete);
    require(tiles(cut) == tiles(expected) && cut.maximum_pixel_error == expected.maximum_pixel_error,
            "retained child slices changed the current-view cut");

    // Replace a dense partial child job with a distant view. No continuation
    // may read its old regions or mark its incomplete children as current.
    auto distant = surface(42U);
    distant.regions.front().value.pixels_per_uv = 64.0;
    for (const unsigned cancel_after : {1U, 127U, 255U}) {
      controller.clear();
      require(controller.begin({large}, budget), "child cancellation fixture was rejected");
      do { cut = controller.update_step(0U, 1U, 0.0); } while (cut.rebuilding);
      for (unsigned i = 0U; i < cancel_after; ++i) {
        cut = controller.update_step(1U, 1U, 0.0);
        require(!cut.decisions_complete && cut.change_count == 0U, "child cancellation was tested after commitment");
      }
      require(controller.begin({distant}, budget), "view replacement rejected a partial child job");
      cut = controller.update_step(1U, 1U, 0.0);
      cut = controller.update_step(1U, 1U, 0.0);
      require(cut.decisions_complete && cut.draws->size() == 1U && cut.draws->front().draw_index == 42U &&
                  cut.maximum_pixel_error == 0.25, "view replacement resumed stale child work");
      require(tiles(controller.plan({small}, budget)) == tiles(expected), "replaced child work poisoned later refinement");
    }
    for (const unsigned cancel_after : {127U, 255U}) {
      using namespace test_allocations;
      live_bytes = peak_bytes = allocations = largest_allocation = 0U;
      measuring = true;
      {
        terra::frame::imagery_controller cancelled;
        require(cancelled.begin({large}, budget), "child ownership fixture was rejected");
        auto partial = cancelled.update_step(0U, 1U, 0.0);
        while (partial.rebuilding) partial = cancelled.update_step(0U, 1U, 0.0);
        for (unsigned i = 0U; i < cancel_after; ++i) partial = cancelled.update_step(1U, 1U, 0.0);
        require(!partial.decisions_complete, "child ownership fixture already completed");
        cancelled.clear();
      }
      measuring = false;
      require(live_bytes == 0U, "partial child scratch survived reset/destruction");
    }
  }
  terra::frame::imagery_controller controller, oracle;
  terra::frame::imagery_budget budget;
  budget.maximum_level = 2U; budget.maximum_texture_count = 16U;
  auto small = surface(51U), dense = small;
  dense.regions.resize(1024U, small.regions.front());
  const auto expected = oracle.plan({small}, budget);
  require(controller.begin({dense}, budget), "ancestor receipt fixture was rejected");
  auto cut = controller.update_step(1U, 1024U, 0.0);
  require(cut.selected_texture_count == 4U && cut.change_count == 1U, "ancestor fixture did not split its root");
  for (unsigned i = 0U; i < 5U; ++i) {
    cut = controller.update_step(1U, 1U, 0.0);
    require(!cut.decisions_complete && cut.change_count == 0U, "ancestor fixture has no partial grandchild measurement");
  }
  require(controller.accept_cut({small.source}, 1U), "ancestor collapse rejected a partial child task");
  cut = controller.update_step(1U, 1U, 0.0);
  require(cut.decisions_complete && cut.selected_texture_count == 1U && cut.limited_by_partition_budget,
          "ancestor collapse retained work from a removed leaf");
  require(controller.accept_cut({}, 2U), "ancestor capacity recovery was rejected");
  unsigned recovery = 0U;
  do {
    cut = controller.update_step(1U, 1U, 0.0);
    require(cut.complete && ++recovery < 1024U, "ancestor recovery did not converge");
  } while (!cut.decisions_complete);
  require(tiles(cut) == tiles(expected) && cut.maximum_pixel_error == expected.maximum_pixel_error,
          "ancestor receipt poisoned subsequent child measurement");
}

void verify_fixed_error_return() {
  terra::frame::imagery_budget budget;
  budget.requested_pixel_error = 1.25;
  budget.maximum_texture_count = 512U;
  budget.maximum_draw_count = 1024U;
  for (const double error : {1.1, 1.2, 1.25, 4.8}) {
    auto target = surface(0U), near = target;
    target.regions[0].value.pixels_per_uv = error * 256.0;
    near.regions[0].value.pixels_per_uv = error * 512.0;
    terra::frame::imagery_controller cold, warm;
    const auto reference = cold.plan({target}, budget);
    require(reference.complete && reference.decisions_complete &&
                reference.maximum_pixel_error <= budget.requested_pixel_error,
            "fixed-error imagery reference failed its target");
    for (const std::size_t window : {32U, 1U}) {
      const auto fine = warm.plan({near}, budget);
      require(fine.selected_texture_count > reference.selected_texture_count,
              "imagery return fixture did not visit finer detail");
      require(warm.begin({target}, budget), "imagery return could not begin");
      terra::frame::imagery_cut returned;
      std::size_t rounds = 0U;
      do {
        returned = warm.update_step(window, window, 0.0);
        require(returned.change_count <= window && returned.priority_update_count <= window &&
                    ++rounds < 1024U,
                "imagery return exceeded its work window or failed to converge");
      } while (!returned.decisions_complete);
      require(returned.complete && tiles(returned) == tiles(reference) &&
                  returned.maximum_pixel_error <= budget.requested_pixel_error,
              "zoom-out retained optional imagery despite a target-compliant parent");
      for (unsigned idle = 0U; idle < 10U; ++idle) {
        const auto parked = warm.update_step(window, window, 0.0);
        require(parked.decisions_complete && parked.change_count == 0U &&
                    tiles(parked) == tiles(reference),
                "fixed-error imagery oscillated at a stationary view");
      }
    }
  }
}

void verify_target_priority(bool constrain_draws) {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.requested_pixel_error = 1.25;
  budget.maximum_texture_count = constrain_draws ? 512U : 17U;
  budget.maximum_draw_count = constrain_draws ? 17U : 512U;
  auto quiet = surface(0U), urgent = surface(1U);
  urgent.source.column = 1;
  quiet.regions[0].value.pixels_per_uv = 1.3 * 256.0;
  require(controller.plan({quiet}, budget).selected_texture_count == 4U,
          "target-priority fixture did not retain a fine region");
  quiet.regions[0].value.pixels_per_uv = 1.2 * 256.0;
  urgent.regions[0].value.pixels_per_uv = 2.8 * 256.0;
  require(controller.begin({quiet, urgent}, budget), "target-priority planning failed");
  terra::frame::imagery_cut cut;
  std::size_t rounds = 0U;
  do {
    cut = controller.update_step(1U, 1U, 0.0);
    require(cut.complete && cut.change_count <= 1U && cut.priority_update_count <= 1U &&
                cut.selected_texture_count <= budget.maximum_texture_count &&
                cut.draws->size() <= budget.maximum_draw_count,
            "target-priority replacement exceeded a bounded work or capacity limit");
    require(++rounds < 128U, "target-priority replacement did not converge");
  } while (!cut.decisions_complete);
  require(cut.maximum_pixel_error <= budget.requested_pixel_error &&
              cut.selected_texture_count == 17U && !cut.limited_by_texture_budget &&
              !cut.limited_by_draw_budget,
          "retained sub-target detail blocked a feasible requested-quality cut");
  std::size_t quiet_count = 0U;
  for (const auto& draw : *cut.draws) if (draw.draw_index == 0U) ++quiet_count;
  require(quiet_count == 1U, "replacement did not release the redundant fine region");
  const auto admitted = tiles(cut);
  for (double error : {1.21, 1.24, 1.2}) {
    quiet.regions[0].value.pixels_per_uv = error * 256.0;
    cut = controller.plan({quiet, urgent}, budget);
    require(tiles(cut) == admitted && cut.change_count == 0U,
            "sub-target camera jitter churned the quality-prioritized cut");
  }
  quiet.regions[0].value.pixels_per_uv = 1.26 * 256.0;
  controller.clear();
  cut = controller.plan({quiet, urgent}, budget);
  require(cut.maximum_pixel_error > budget.requested_pixel_error &&
              (constrain_draws ? cut.limited_by_draw_budget : cut.limited_by_texture_budget),
          "a truly insufficient budget was reported as meeting requested quality");
}

void verify_impossible_exchange(bool constrain_draws) {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_texture_count = constrain_draws ? 512U : 4U;
  budget.maximum_draw_count = constrain_draws ? 8U : 512U;
  auto quiet = surface(0U), urgent = surface(1U);
  quiet.regions[0].value.pixels_per_uv = 1.3 * 256.0;
  urgent.source.column = 1;
  urgent.regions[0].value.pixels_per_uv = 8.0 * 256.0;
  if (!constrain_draws) {
    // A partial donor releases only one physical image. The urgent split
    // needs three more, so even the complete exchange cannot fit.
    quiet.hull = {{{0.0, 0.0}}, {{0.49, 0.0}}, {{0.49, 1.0}}, {{0.0, 1.0}}};
    quiet.regions[0].value.uv.maximum[0] = 0.49;
  }
  require(controller.plan({quiet}, budget).selected_texture_count == (constrain_draws ? 4U : 2U),
          "impossible-exchange fixture did not retain detail");
  // Keep the donor above the target: ordinary target-compliant coarsening is
  // independently legal and would not exercise an atomic capacity exchange.
  std::vector<terra::frame::imagery_surface> input{quiet, urgent};
  if (constrain_draws) {
    // Twelve urgent draws alone exceed the total budget of eight.
    urgent.draw_index = 2U; input.push_back(urgent);
    urgent.draw_index = 3U; input.push_back(urgent);
  }
  for (std::uint64_t epoch = 1U; epoch <= 3U; ++epoch) {
    require(controller.begin(input, budget) && controller.accept_cut({}, epoch),
            "impossible-exchange epoch was rejected");
    terra::frame::imagery_cut cut;
    std::size_t rounds = 0U;
    do {
      cut = controller.update_step(1U, 1U, 0.0);
      require(cut.complete && cut.change_count == 0U && cut.priority_update_count <= 1U,
              "an infeasible exchange changed the retained cut");
      require(++rounds < 64U, "infeasible exchange did not finish pricing");
      if (!cut.rebuilding) require(std::count_if(cut.draws->begin(), cut.draws->end(),
          [](const terra::frame::imagery_draw& draw) { return draw.draw_index == 0U; }) ==
          (constrain_draws ? 4 : 2), "an infeasible exchange published a coarsened donor");
    } while (!cut.decisions_complete);
    require(constrain_draws ? cut.limited_by_draw_budget : cut.limited_by_texture_budget,
            "infeasible exchange lost the actual limiting budget");
  }
}

void verify_nested_exchange(int cancel_after, bool shared_images) {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_texture_count = 512U;
  budget.maximum_draw_count = 22U;
  if (shared_images) budget.resource_key = [](const terra::imagery::node_key& key, double) {
    // Across both roots, neighbouring internal nodes share physical images.
    return std::to_string(key.level) + "/" + std::to_string(key.row) + "/" +
        std::to_string(key.column / 2);
  };
  auto quiet = surface(0U), urgent = surface(1U);
  quiet.regions[0].value.pixels_per_uv = 2.6 * 256.0;
  require(controller.plan({quiet}, budget).draws->size() == 16U,
          "nested-exchange fixture did not retain two levels");
  // Both donor levels still need refinement; only the complete capacity
  // exchange may replace them with their lower-precision ancestor.
  urgent.source.column = 1;
  urgent.regions[0].value.pixels_per_uv = 8.0 * 256.0;
  std::vector<terra::frame::imagery_surface> input{quiet};
  for (unsigned i = 1U; i <= 5U; ++i) { urgent.draw_index = i; input.push_back(urgent); }
  require(controller.begin(input, budget), "nested-exchange input was rejected");
  std::size_t changes = 0U, rounds = 0U, hidden_changes = 0U;
  bool notified = false, cancelled = false;
  terra::frame::imagery_cut cut;
  do {
    cut = controller.update_step(1U, 1U, 0.0);
    changes += cut.change_count;
    require(cut.complete && cut.change_count <= 1U && cut.priority_update_count <= 1U &&
                cut.draws->size() <= budget.maximum_draw_count,
            "nested exchange exceeded bounded work or capacity");
    require(++rounds < 256U, "nested exchange did not converge");
    if (cut.rebuilding) hidden_changes += cut.change_count;
    else if (changes) require(std::count_if(cut.draws->begin(), cut.draws->end(),
        [](const terra::frame::imagery_draw& draw) { return draw.draw_index == 0U; }) == 1,
        "nested exchange published a donor-only intermediate cut");
    if (cancel_after >= 0 && changes == static_cast<std::size_t>(cancel_after) &&
        cut.rebuilding && (changes || rounds > 24U)) {
      // New camera input can supersede pricing or a partially committed
      // exchange; the abandoned urgent target must never be split afterwards.
      quiet.regions[0].value.pixels_per_uv = 0.5 * 256.0;
      require(controller.begin({quiet}, budget), "exchange cancellation rejected new input");
      cut = controller.update_step(1U, 1U, 0.0);
      for (unsigned i = 0U; !cut.decisions_complete && i < 64U; ++i)
        cut = controller.update_step(1U, 1U, 0.0);
      require(cut.complete && cut.decisions_complete && cut.draws->size() == 1U &&
                  cut.draws->front().draw_index == 0U && cut.maximum_pixel_error == 0.5,
              "cancelled exchange leaked old demand into the new view");
      cancelled = true;
      break;
    }
    if (changes == 1U && !notified) {
      require(controller.accept_cut({}, 42U), "admission notification interrupted exchange");
      require(!controller.accept_cut({quiet.source, urgent.source}, 42U),
              "an incomplete exchange accepted a consumer replacement");
      notified = true;
    }
  } while (!cut.decisions_complete);
  if (cancel_after >= 0) require(cancelled, "cancellation did not exercise a pending exchange");
  else {
    require(changes == 6U && hidden_changes == 5U && cut.draws->size() == 21U &&
                cut.maximum_pixel_error == 4.0 && cut.limited_by_draw_budget,
            "nested exchange did not replace five donors with one urgent split");
    std::set<std::string> physical;
    for (const auto& draw : *cut.draws) physical.insert(shared_images ?
        budget.resource_key(draw.tile, draw.pixel_error) : std::to_string(draw.tile.level) + "/" +
            std::to_string(draw.tile.row) + "/" + std::to_string(draw.tile.column));
    require(cut.selected_texture_count == physical.size(), "exchange lost shared physical resource counts");
    const auto retained = tiles(cut);
    const auto repeat = controller.plan(input, budget);
    require(repeat.change_count == 0U && tiles(repeat) == retained,
            "unchanged input repeated the admitted exchange");
  }
}

void verify_shared_exchange(bool optional_donor) {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_texture_count = 5U;
  budget.resource_key = [](const terra::imagery::node_key& key, double) {
    const auto root = key.column >> key.level;
    if (root == 2) return std::string("shared");
    if (key.level == 0) return std::string(root == 0 ? "quiet" : "urgent");
    if (key.row == 0 && key.column % 2 == 0) return std::string("shared");
    return std::to_string(root) + "/" + std::to_string(key.row) + "/" + std::to_string(key.column);
  };
  auto quiet = surface(0U), urgent = surface(1U), fixed = surface(2U);
  quiet.regions[0].value.pixels_per_uv = 1.3 * 256.0;
  require(controller.plan({quiet}, budget).selected_texture_count == 4U,
          "shared-exchange fixture did not retain fine images");
  // Preserve the feasible full-quality case as well as a precision-losing
  // exchange. Only the latter must keep the donor until the exchange commits.
  if (optional_donor) quiet.regions[0].value.pixels_per_uv = 1.2 * 256.0;
  urgent.source.column = 1;
  urgent.regions[0].value.pixels_per_uv = (optional_donor ? 1.3 : 2.0) * 256.0;
  fixed.source.column = 2; fixed.regions[0].value.pixels_per_uv = 0.5 * 256.0;
  require(controller.begin({quiet, urgent, fixed}, budget), "shared exchange was rejected");
  terra::frame::imagery_cut cut;
  std::size_t rounds = 0U, changes = 0U;
  do {
    cut = controller.update_step(1U, 1U, 0.0);
    changes += cut.change_count;
    require(++rounds < 64U && cut.selected_texture_count <= 5U,
            "shared exchange exceeded its physical-image budget");
    if (!optional_donor && changes == 1U)
      require(cut.rebuilding, "shared exchange published only its donor");
  } while (!cut.decisions_complete);
  require(changes == 2U && cut.draws->size() == 6U && cut.selected_texture_count == 5U &&
              (optional_donor ? cut.maximum_pixel_error <= budget.requested_pixel_error &&
                  !cut.limited_by_texture_budget :
                  cut.maximum_pixel_error == 1.3 && cut.limited_by_texture_budget),
          "exchange failed to retain an image shared by donor, target and another root");
}

void verify_projective_snapshot() {
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.maximum_texture_count = 200U;
  auto value = surface(0U);
  value.source = terra::imagery::node_key(5, 17, 23);
  value.regions.clear();
  // Many small regions traverse common ancestors, then need local clipping.
  // The supplied bound is deliberately loose: accepting it as an exact whole
  // region error would change both the selected levels and their reported SSE.
  for (int row = 0; row < 8; ++row) for (int column = 0; column < 8; ++column) {
    const double u = column / 8.0, v = row / 8.0, size = 1.0 / 8.0;
    terra::frame::measurement_region region;
    region.value.uv = {{{u, v}}, {{u + size, v + size}}};
    region.value.triangle = {{{{u, v}}, {{u + size, v}}, {{u, v + size}}}};
    region.flags=3U;region.value.projection = {{-500, 2000, 0, -250, 0, 1000, 1, 0, 8}};
    region.value.pixels_per_uv = 1e6;
    if ((row + column) % 5 == 0){region.flags|=4U;region.value.numerator_bound = 8000.0;}
    value.regions.push_back(region);
  }
  for (const double depth : {1.0, 4.0, 0.25, 1.0}) {
    for (auto& region : value.regions) region.value.projection[6] = depth;
    require(controller.begin({value}, budget), "projective snapshot was rejected");
    terra::frame::imagery_cut cut;
    std::size_t rounds = 0U;
    do {
      cut = controller.update_step(2U, 3U, 0.0);
      require(++rounds < 2048U, "projective snapshot did not converge");
    } while (!cut.decisions_complete);
    require(cut.complete && !cut.draws->empty(), "projective snapshot lost coverage");
    double maximum = 0.0;
    for (const auto& draw : *cut.draws) {
      const double scale = std::ldexp(1.0, draw.tile.level - value.source.level);
      const double u = draw.tile.column / scale - value.source.column;
      const double v = draw.tile.row / scale - value.source.row;
      const terra::core::bounds2d cell({{u, v}}, {{u + 1.0 / scale, v + 1.0 / scale}});
      double expected = 0.0;
      for (const auto& region : value.regions) {
        expected = std::max(expected, terra::frame::imagery_region_error(region, cell) /
            (budget.tile_size * scale));
      }
      require(std::abs(draw.pixel_error - expected) <= 1e-10 * std::max(1.0, expected),
              "retained region error disagrees with direct node-local clipping");
      maximum = std::max(maximum, expected);
    }
    require(std::abs(cut.maximum_pixel_error - maximum) <= 1e-10 * std::max(1.0, maximum),
            "projective snapshot retained another view's maximum error");
    for (const auto& region : value.regions) require(region.value.pixels_per_uv == 1e6,
        "planning modified caller-owned measurement input");
  }
}

}  // namespace

int main() {
  verify_retained_inputs();
  verify_retained_cell_measurements();
  verify_reuse_lookup_work();
  verify_reuse_lookup_lifetime();
  verify_input_registry_credit();
  verify_snapshot_ownership();
  verify_output_lifetime();
  verify_memory_ownership();
  verify_reference_credit();
  verify_output_credit();
  verify_reference_reclamation();
  verify_initialization_replacement();
  verify_initialization_boundaries();
  verify_child_measurement_slices();
  verify_projective_snapshot();
  verify_fixed_error_return();
  verify_target_priority(false);
  verify_target_priority(true);
  verify_impossible_exchange(false);
  verify_impossible_exchange(true);
  verify_shared_exchange(false);
  verify_shared_exchange(true);
  for (const bool shared : {false, true}) {
    verify_nested_exchange(-1, shared);
    for (const int cancel_after : {0, 1, 4, 5}) verify_nested_exchange(cancel_after, shared);
  }
  terra::frame::measurement_region projected;
  projected.flags=3U;projected.value.projection = {{0, 1, 0, 0, 0, 1, 1, 0, 99}};
  projected.value.triangle = {{{{0, 0}}, {{0.001, 0}}, {{0, 1}}}};
  projected.value.pixels_per_uv = 100.0;
  const double local_error = terra::frame::imagery_region_error(projected,
      terra::core::bounds2d({{0, 0}}, {{1, 1}}));
  require(local_error >= 1.0 && local_error < 1.06,
          "one triangle combined a distant derivative numerator with near depth");
  require(terra::frame::imagery_region_error(projected,
      terra::core::bounds2d({{0.001, 0}}, {{1, 1}})) == 0.0,
      "a shared triangle boundary created demand outside its visible area");
  terra::frame::imagery_controller controller;
  terra::frame::imagery_budget budget;
  budget.requested_pixel_error = 1.0;
  budget.maximum_texture_count = 512U;
  budget.maximum_draw_count = 1024U;
  const auto whole = surface(0U);
  const auto full = controller.plan({whole}, budget);
  require(full.complete && full.selected_texture_count == 256U &&
              full.maximum_pixel_error == 1.0, "screen-space target did not select the correct pyramid cut");
  auto first = surface(1U), second = surface(2U);
  first.hull = {{{0.0, 0.0}}, {{1.0, 0.0}}, {{0.0, 1.0}}};
  second.hull = {{{1.0, 0.0}}, {{1.0, 1.0}}, {{0.0, 1.0}}};
  controller.clear();
  const auto fragmented = controller.plan({first, second}, budget);
  require(fragmented.complete && tiles(fragmented) == tiles(full),
          "terrain fragmentation changed the spatial texture cut");
  budget.maximum_texture_count = 100U;
  const auto limited = controller.plan({whole}, budget);
  require(limited.complete && limited.limited_by_texture_budget &&
              limited.selected_texture_count == 100U && limited.feasible_pixel_error == 2.0,
          "capacity must admit local refinement without resetting the original demand");
  require(limited.requested_pixel_error == 1.0 && limited.pending_refinement_count > 0U,
          "unmet original demand was discarded");
  require(limited.draws->front().tile.level >= 3, "capacity pressure reset the cut to roots");
  budget.maximum_texture_count = 512U;
  budget.maximum_draw_count = 32U;
  const auto draw_limited = controller.plan({whole}, budget);
  require(draw_limited.complete && draw_limited.limited_by_draw_budget &&
              draw_limited.draws->size() == 31U && draw_limited.feasible_pixel_error == 4.0,
          "draw budget did not constrain the feasible texture error");
  budget.maximum_draw_count = 1024U;
  auto unbounded = whole;
  unbounded.regions[0].value.pixels_per_uv = std::numeric_limits<double>::infinity();
  const auto projection_limited = controller.plan({unbounded}, budget);
  require(projection_limited.complete && projection_limited.selected_texture_count == 31U &&
              std::isinf(projection_limited.maximum_pixel_error),
          "invalid measurement erased previously admitted detail");
  controller.clear();
  unbounded.source.column = 1;
  const auto partly_invalid = controller.plan({whole, unbounded}, budget);
  require(partly_invalid.selected_texture_count == 257U,
          "an invalid region blocked refinement of the valid region");
  const auto returned = controller.plan({whole}, budget);
  require(tiles(returned) == tiles(full), "a camera/budget round trip failed to restore the fine cut");
  controller.clear();
  require(controller.begin({whole}, budget), "incremental planning could not begin");
  terra::frame::imagery_cut stepped;
  std::size_t rounds = 0U;
  do {
    stepped = controller.update_step(3U, 5U, 4.0);
    require(stepped.complete && stepped.change_count <= 3U && stepped.priority_update_count <= 5U,
            "a continuation exceeded its topology/priority budget");
    require(stepped.selected_texture_count <= budget.maximum_texture_count,
            "a partial cut exceeded the hard capacity");
    require(++rounds < 256U, "incremental planning did not converge");
  } while (!stepped.decisions_complete);
  require(rounds > 1U && tiles(stepped) == tiles(full), "continuations lost their refinement queue");
  budget.maximum_level = 2U;
  const auto level_limited = controller.plan({whole}, budget);
  require(level_limited.complete && level_limited.limited_by_level &&
              level_limited.maximum_pixel_error == 4.0, "source maximum level was ignored");
  controller.clear();
  budget.maximum_level = 17U;
  budget.maximum_texture_count = 40U;
  auto quiet = surface(0U);
  quiet.regions[0].value.pixels_per_uv = 1024.0;
  const auto quiet_cut = controller.plan({quiet}, budget);
  require(quiet_cut.selected_texture_count == 16U, "reallocation fixture is invalid");
  auto urgent = surface(1U);
  urgent.source.column = 1;
  const auto reallocated = controller.plan({quiet, urgent}, budget);
  std::size_t quiet_count = 0U, urgent_count = 0U;
  for (const auto& draw : *reallocated.draws) {
    if (draw.draw_index == 0U) ++quiet_count;
    else ++urgent_count;
  }
  require(quiet_count < 16U && urgent_count > 24U && reallocated.limited_by_texture_budget,
          "coarsening priority did not release lower-error slots for urgent refinement");
  budget.maximum_texture_count = 512U;
  const auto recovered = controller.plan({quiet, urgent}, budget);
  require(recovered.maximum_pixel_error <= 1.0 && !recovered.limited_by_texture_budget,
          "capacity recovery did not resume the unmet original precision demand");
  controller.clear();
  const auto retained = controller.plan({whole}, budget);
  require(!retained.rebuilding, "a completed cut was still marked rebuilding");
  require(controller.begin({whole}, budget), "retained cut could not refresh its measurements");
  std::size_t repeated_changes = 0U;
  bool rebuilding_seen = false;
  do {
    stepped = controller.update_step(3U, 7U, 0.0);
    if (stepped.rebuilding) {
      rebuilding_seen = true;
      require(!stepped.decisions_complete && stepped.selected_texture_count == 1U,
              "temporary root coverage was marked as a usable measured cut");
    }
    repeated_changes += stepped.change_count;
  } while (!stepped.decisions_complete);
  require(rebuilding_seen && !stepped.rebuilding &&
              tiles(stepped) == tiles(retained) && repeated_changes == 0U,
          "unchanged measurements reconstructed the actual texture topology");
  auto reduced_budget = budget;
  reduced_budget.maximum_texture_count = 16U;
  require(controller.begin({whole}, reduced_budget), "capacity reduction could not begin");
  stepped = controller.update_step(1U, 4096U, 0.0);
  require(stepped.rebuilding && !stepped.decisions_complete,
          "an over-budget cut was exposed before bounded coarsening finished");
  for (unsigned round = 0; !stepped.decisions_complete && round < 1024U; ++round)
    stepped = controller.update_step(1U, 4096U, 0.0);
  require(stepped.decisions_complete && !stepped.rebuilding && stepped.limited_by_texture_budget &&
              stepped.selected_texture_count <= reduced_budget.maximum_texture_count,
          "a valid capacity-limited cut was hidden as rebuilding");
  require(controller.begin({whole}, budget), "capacity restoration could not begin");
  stepped = controller.update_step(1U, 4096U, 0.0);
  require(!stepped.rebuilding && !stepped.decisions_complete && stepped.selected_texture_count > 1U,
          "usable partial refinement was hidden as rebuilding");
  controller.plan({whole}, budget);
  auto distant = whole;
  distant.regions[0].value.pixels_per_uv = 64.0;
  require(controller.begin({distant}, budget), "large ascent could not begin");
  const auto initialized = controller.update_step(1U, 1U, 0.0);
  require(initialized.rebuilding && !initialized.decisions_complete &&
              initialized.priority_update_count == 1U && initialized.change_count == 0U,
          "root normalization consumed an unaccounted work credit");
  const auto coarse = controller.update_step(1U, 1U, 0.0);
  require(coarse.decisions_complete && !coarse.rebuilding && coarse.selected_texture_count == 1U &&
              coarse.priority_update_count == 1U && coarse.change_count == 1U,
          "a valid coarse parent remeasured its obsolete fine subtree");
  require(tiles(controller.plan({whole}, budget)) == tiles(retained),
          "a zoom reversal resurrected stale splits or lost fine demand");
  std::vector<terra::imagery::node_key> accepted;
  accepted.emplace_back(3, 0, 0);
  for (const auto& draw : *retained.draws) {
    if (draw.tile.row < 2 && draw.tile.column < 2) continue;
    accepted.push_back(draw.tile);
  }
  require(controller.accept_cut(accepted, 1U), "partition admission could not update the actual cut");
  const auto denied = controller.plan({whole}, budget);
  require(denied.limited_by_partition_budget && denied.pending_refinement_count > 0U &&
              denied.selected_texture_count == retained.selected_texture_count - 3U,
          "partition-denied demand was forgotten or immediately repeated");
  require(controller.accept_cut({}, 2U), "resource epoch could not wake denied demand");
  const auto resumed = controller.plan({whole}, budget);
  require(tiles(resumed) == tiles(retained) && !resumed.limited_by_partition_budget,
          "freed capacity did not resume the original texture precision");
  controller.clear();
  std::vector<terra::frame::imagery_surface> roots;
  for (unsigned i = 0; i < 8; ++i) {
    auto root = surface(i);
    root.source = terra::imagery::node_key(0, i / 4, i % 4);
    root.regions[0].value.pixels_per_uv = 64.0;
    roots.push_back(root);
  }
  budget.maximum_texture_count = 2U;
  budget.resource_key = [](const terra::imagery::node_key& node, double error) {
    if (node.level == 0 && error * 2.0 <= 1.0) return std::string("shared/") + std::to_string(node.column / 2);
    return std::to_string(node.level) + "/" + std::to_string(node.row) + "/" + std::to_string(node.column);
  };
  const auto shared = controller.plan(roots, budget);
  require(shared.complete && shared.draws->size() == 8U && shared.selected_texture_count == 2U,
          "shared source images were budgeted as eight independent internal roots");
  budget.requested_pixel_error = -1.0;
  require(!controller.plan({whole}, budget).complete, "invalid imagery budget was accepted");
  return 0;
}
