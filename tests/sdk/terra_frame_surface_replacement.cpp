#include <terra/frame/surface_replacement.hpp>
#include "observed_allocations.hpp"
#include <algorithm>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <vector>

using terra::frame::replacement_point;
using terra::frame::surface_replacement_plan;
using points = std::vector<replacement_point>;
using groups = std::vector<std::vector<std::uint32_t>>;
void expect(bool value) { if (!value) throw std::runtime_error("replacement boundary contract failed"); }
points triangle(std::int64_t ax, std::int64_t ay, std::int64_t bx, std::int64_t by,
                std::int64_t cx, std::int64_t cy) {
  points result;
  const std::int64_t x[] = {ax,bx,cx}, y[] = {ay,by,cy};
  for (int i = 0; i < 3; ++i) {
    const int j = (i + 1) % 3;
    result.push_back({x[i],y[i],{{double(x[i]),double(y[i]),0.0}}});
    const auto u = (x[i]+x[j])/2, v = (y[i]+y[j])/2;
    result.push_back({u,v,{{double(u),double(v),0.0}}});
  }
  return result;
}
groups finish(surface_replacement_plan& plan, std::size_t budget = 1U,
              std::size_t* operations = nullptr) {
  std::size_t steps = 0U, work = 0U;
  expect(!plan.step(0U) && plan.last_step_operations() == 0U);
  for (;;) {
    const bool done = plan.step(budget);
    const auto used = plan.last_step_operations();
    expect(used > 0U && used <= budget);
    work += used;
    if (done) break;
    expect(plan.members().empty() && plan.take_members().empty());
    expect(++steps < 1000000U);
  }
  if (operations) *operations = work;
  expect(plan.valid());
  groups result;
  for (const auto& m : plan.members()) {
    if (result.size() <= m.group) result.resize(m.group + 1U);
    result[m.group].push_back(m.resource_id);
  }
  for (auto& group : result) std::sort(group.begin(), group.end());
  std::sort(result.begin(), result.end());
  return result;
}
void memory_contract() {
  using namespace test_allocations;
  constexpr std::size_t surfaces = 256U, dimension = 64U, point_count = 3U * dimension;
  const auto credit = surface_replacement_plan::payload_bound(surfaces, point_count);
  for (const bool dense : {false, true}) for (const unsigned cancel : {0U, 1U, 2U}) {
    live_bytes = peak_bytes = allocations = largest_allocation = 0U; measuring = true;
    {
      surface_replacement_plan plan(surfaces, point_count, false);
      // Preparing a cut must not reserve its multi-MiB edge array before input
      // arrives. A cancelled candidate should pay only for its processed input.
      expect(live_bytes <= 65536U && largest_allocation <= 65536U);
      for (std::size_t i = 0U; i < surfaces; ++i) {
        points boundary; boundary.reserve(point_count);
        const auto origin = static_cast<std::int64_t>(dense ? 0U : i / 2U * 512U);
        for (std::size_t edge = 0U; edge < 3U; ++edge) for (std::size_t j = 0U; j < dimension; ++j) {
          const auto t = static_cast<std::int64_t>(j), end = static_cast<std::int64_t>(dimension);
          const auto x = origin + (edge == 0U ? t : edge == 1U ? end - t : 0);
          const auto y = origin + (edge == 0U ? 0 : edge == 1U ? t : end - t);
          boundary.push_back({x,y,{{double(x),double(y),double(x+y)/8.0}}});
        }
        expect(plan.add(static_cast<std::uint32_t>(i+1U), i%2U != 0U, std::move(boundary)));
        if (cancel == 2U && i == 3U) break;
      }
      expect(largest_allocation <= 65536U);
      if (cancel == 2U) expect(peak_bytes <= 131072U);
      else expect(!plan.step(1U));
      const auto prepared_allocations = allocations;
      if (!cancel) {
        while (!plan.step(512U)) expect(plan.last_step_operations() <= 512U);
        expect(plan.valid() && plan.members().size() == surfaces);
        expect(plan.last_step_operations() <= 512U);
        expect(allocations == prepared_allocations); // Reuse sweep space on every line.
        expect(plan.members().back().group == (dense ? 0U : surfaces/2U-1U));
      }
    }
    measuring = false;
    std::fprintf(stderr, "boundary memory dense=%d cancel=%u peak=%zu credit=%zu live=%zu\n",
                 dense, cancel, peak_bytes, credit, live_bytes);
    expect(live_bytes == 0U && peak_bytes <= credit);
    // Include temporary input and bookkeeping, not only compact edge payload.
    // The previous whole-cut sweep reserves exceed this working-set envelope.
    expect(peak_bytes <= surfaces * point_count * 96U + 65536U);
  }
}
void retained_contract() {
  // Retained surfaces remain in the edge proof. Removing their edges entirely
  // could disconnect changed neighbours; collapsing the two identical sides
  // must produce the same complete groups, including the longitude seam.
  for (const bool globe : {false, true}) for (unsigned mask = 0U; mask < 16U; ++mask) {
    unsigned retained_count = 0U;
    for (unsigned i = 0U; i < 4U; ++i) if (mask & (1U<<i)) ++retained_count;
    surface_replacement_plan full(8U, 6U, globe), shared(8U, 6U, globe, retained_count);
    std::vector<points> old, next;
    for (unsigned i = 0U; i < 4U; ++i) {
      const auto offset = globe && i%2U ? (std::int64_t(4)<<28)-4 : 0;
      old.push_back(triangle(offset,0,offset+4,0,offset,4));
      next.push_back(old.back());
      const bool retained = mask & (1U<<i);
      if (!retained) for (auto& point : next.back()) point.world[2] = (i+1)*0.1;
      expect(full.add(i+1U, false, old.back()));
      expect(retained ? shared.retain(i+1U, old.back()) : shared.add(i+1U, false, old.back()));
    }
    for (unsigned i = 0U; i < 4U; ++i) {
      const bool retained = mask & (1U<<i);
      const auto id = retained ? i+1U : i+101U;
      expect(full.add(id, true, next[i]));
      if (!retained) expect(shared.add(id, true, next[i]));
    }
    expect(finish(full) == finish(shared));
    for (unsigned i = 0U; i < 4U; ++i) if (mask & (1U<<i)) {
      unsigned before = 0U, after = 0U;
      for (const auto& member : shared.members()) if (member.resource_id == i+1U)
        ++(member.after ? after : before);
      expect(before == 1U && after == 1U);
    }
  }
  surface_replacement_plan too_small(1U,6U,false);
  expect(!too_small.retain(1U,triangle(0,0,4,0,0,4)) && !too_small.valid());
  surface_replacement_plan overclaimed(2U,6U,false,1U);
  expect(overclaimed.add(1U,false,triangle(0,0,4,0,0,4)));
  expect(!overclaimed.add(2U,true,triangle(0,0,4,0,0,4)) && !overclaimed.valid());
  expect(surface_replacement_plan::payload_bound(2U,6U,2U) == std::numeric_limits<std::size_t>::max());

  using namespace test_allocations;
  std::size_t peaks[2]{}, work[2]{};
  for (const bool shared : {false,true}) {
    live_bytes = peak_bytes = allocations = largest_allocation = 0U; measuring = true;
    {
      surface_replacement_plan plan(512U,192U,false,shared ? 256U : 0U);
      for (std::uint32_t i = 0U; i < 256U; ++i) {
        points boundary;
        for (std::int64_t edge = 0; edge < 3; ++edge) for (std::int64_t t = 0; t < 64; ++t) {
          const auto x = i*128 + (edge == 0 ? t : edge == 1 ? 64-t : 0);
          const auto y = edge == 0 ? 0 : edge == 1 ? t : 64-t;
          boundary.push_back({x,y,{{double(x),double(y),0.0}}});
        }
        if (shared) expect(plan.retain(i+1U,std::move(boundary)));
        else expect(plan.add(i+1U,false,boundary) && plan.add(i+1U,true,std::move(boundary)));
      }
      while (!plan.step(512U)) work[shared] += plan.last_step_operations();
      work[shared] += plan.last_step_operations();
      expect(plan.valid() && plan.members().size() == 512U);
    }
    measuring = false; peaks[shared] = peak_bytes;
    expect(live_bytes == 0U);
    const auto credit = surface_replacement_plan::payload_bound(512U,192U,shared ? 256U : 0U);
    expect(peaks[shared] <= credit);
    if (shared) expect(credit * 3U < surface_replacement_plan::payload_bound(512U,192U) * 2U);
  }
  std::fprintf(stderr,"retained boundary peak=%zu/%zu operations=%zu/%zu\n",peaks[1],peaks[0],work[1],work[0]);
  expect(peaks[1]*3U <= peaks[0]*2U && work[1]*3U <= work[0]*2U);
}
int main() {
  memory_contract();
  retained_contract();
  using members = std::vector<terra::frame::replacement_member>;
  const members proof{{0,0,1},{0,0,2},{0,1,3},{1,0,4},{1,1,5},{1,1,6},{2,0,7},{2,1,7}};
  for (unsigned mask = 0U; mask < 4U; ++mask) {
    std::vector<std::uint32_t> displayed{7};
    const auto first = mask & 1U ? std::vector<std::uint32_t>{3} : std::vector<std::uint32_t>{1,2};
    const auto second = mask & 2U ? std::vector<std::uint32_t>{5,6} : std::vector<std::uint32_t>{4};
    displayed.insert(displayed.end(), first.begin(), first.end());
    displayed.insert(displayed.end(), second.begin(), second.end());
    members rebased, finished;
    expect(surface_replacement_plan::rebase(proof, displayed, rebased));
    expect(surface_replacement_plan::rebase(rebased, {3,5,6,7}, finished));
    expect(finished.size() == 8U);
    for (std::size_t i = 0U; i < finished.size(); i += 2U)
      expect(finished[i].group == finished[i+1U].group && finished[i].after == 0U &&
        finished[i+1U].after == 1U && finished[i].resource_id == finished[i+1U].resource_id);
  }
  members untouched{{0,0,99}};
  for (const auto& invalid_display : std::vector<std::vector<std::uint32_t>>{
      {1,3,4,7},{1,2,3,4,7},{3,5,6},{3,5,6,7,8},{3,5,6,7,7},{0,3,5,6,7}}) {
    expect(!surface_replacement_plan::rebase(proof, invalid_display, untouched));
    expect(untouched.size() == 1U && untouched[0].resource_id == 99U);
  }
  for (const auto& invalid_proof : std::vector<members>{
      {{UINT32_MAX,0,1}},{{0,2,1}},{{0,0,0}},{{0,0,1},{0,0,1}},{{0,0,1},{1,1,1}}})
    expect(!surface_replacement_plan::rebase(invalid_proof, {1}, untouched));
  expect(surface_replacement_plan::rebase({{0,0,8},{1,1,9}}, {}, untouched));
  expect(untouched.size() == 1U && untouched[0].after == 1U && untouched[0].resource_id == 9U);
  const auto a = triangle(0,0,4,0,0,4), b = triangle(4,4,0,4,4,0);
  // Hundreds of coincident endpoint events and active edges must remain
  // resumable even at a one-operation budget, with no partial proof published.
  constexpr std::uint32_t dense_count = 512U;
  std::size_t dense_operations = 0U;
  for (const auto budget : {1U,7U,512U}) {
    surface_replacement_plan dense(dense_count,6,false);
    groups expected(1);
    for (std::uint32_t i = 0U; i < dense_count; ++i) {
      expect(dense.add(i+1U, i >= dense_count/2U, a));
      expected.front().push_back(i+1U);
    }
    std::size_t operations = 0U;
    expect(finish(dense,budget,&operations) == expected);
    // One enqueue per edge, one operation per endpoint, one per output member.
    expect(operations >= dense_count * (6U + 12U + 1U));
    if (!dense_operations) dense_operations = operations;
    expect(operations == dense_operations);
    expect(dense.step(0U) && dense.last_step_operations() == 0U);
  }
  // Distinct components exercise resumable final grouping without merging
  // unrelated regions; the same proof is required at every slice size.
  for (const auto budget : {1U,13U,512U}) {
    surface_replacement_plan separate(256U,6,false);
    groups expected;
    for (std::uint32_t i = 0U; i < 128U; ++i) {
      const auto t = triangle(i*16U,0,i*16U+4U,0,i*16U,4);
      expect(separate.add(2U*i+1U,false,t) && separate.add(2U*i+2U,true,t));
      expected.push_back({2U*i+1U,2U*i+2U});
    }
    expect(finish(separate,budget) == expected);
  }
  surface_replacement_plan reversed(2,6,false);
  auto backwards = a; std::reverse(backwards.begin(), backwards.end());
  expect(reversed.add(1,false,a) && reversed.add(3,true,backwards));
  expect(finish(reversed) == groups{{1,3}});
  for (const bool changed : {false,true}) {
    auto c = a, d = b;
    if (changed) for (auto* p : {&c,&d}) for (auto& point : *p)
      if (point.u == 2 && point.v == 2) point.world[2] = 0.1;
    surface_replacement_plan plan(4,6,false);
    expect(plan.add(1,false,a) && plan.add(2,false,b) && plan.add(3,true,c) && plan.add(4,true,d));
    expect(finish(plan) == (changed ? groups{{1,2,3,4}} : groups{{1,3},{2,4}}));
  }
  for (const bool reverse : {false,true}) {
    surface_replacement_plan plan(5,6,false);
    expect(plan.add(1,reverse,a) && plan.add(2,reverse,b) &&
      plan.add(5,!reverse,triangle(0,0,4,0,2,2)) && plan.add(6,!reverse,triangle(0,0,2,2,0,4)) &&
      plan.add(2,!reverse,b));
    expect(finish(plan) == groups{{1,5,6},{2,2}});
  }
  constexpr std::int64_t seam = std::int64_t(4)<<28;
  auto east = triangle(seam-4,0,seam,0,seam,4), west = a;
  auto next_east = east, next_west = west;
  for (auto& p : next_east) if (p.u == seam) p.world[2] = 0.1;
  for (auto& p : next_west) if (p.u == 0) p.world[2] = 0.1;
  surface_replacement_plan globe(4,6,true);
  expect(globe.add(10,false,east) && globe.add(11,false,west) && globe.add(12,true,next_east) && globe.add(13,true,next_west));
  expect(finish(globe) == groups{{10,11,12,13}});
  surface_replacement_plan invalid(1,6,false);
  expect(!invalid.add(1,false,{{0,0,{{0,0,0}}},{0,0,{{0,0,0}}},{0,1,{{0,1,0}}}}));
  expect(!invalid.valid());
  expect(surface_replacement_plan::payload_bound(1000,192) < 32U*1024U*1024U);
  expect(surface_replacement_plan::payload_bound(std::numeric_limits<std::size_t>::max(),192) == std::numeric_limits<std::size_t>::max());
  surface_replacement_plan empty(0,6,false); expect(finish(empty).empty());
}
