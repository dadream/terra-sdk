#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/height_demand.hpp>
#include <terra/frame/height_query.hpp>
#include <terra/frame/height_session.hpp>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>

namespace {
using namespace terra;
using key = std::pair<std::uint32_t, core::grid_point>;
using frame::height_demand_state;

void expect(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

core::grid_diamond child(const core::grid_diamond& d, bool globe,
                          std::size_t f, std::size_t c) {
  return globe ? d.cylindrical_child_diamond(f, c) : d.planar_child_diamond(f, c);
}

// Nonlinear roots and signed residuals expose the wrong mirrored-parent path.
codec::height_patch record(const key& id, std::uint32_t dimension, bool root) {
  codec::height_patch result;
  result.rows = result.columns = dimension + (root ? 1U : 0U);
  std::uint32_t seed = id.first + 17U;
  for (const auto coordinate : id.second) seed = seed * 1664525U + coordinate + 1013904223U;
  for (std::size_t i = 0U; i < result.rows * result.columns; ++i) {
    seed = seed * 1664525U + 1013904223U;
    result.values.push_back(static_cast<std::int32_t>(seed % 1601U) - 800);
  }
  return result;
}

struct reference_height {
  core::grid_diamond diamond;
  codec::height_diamond height;
  std::uint8_t procedural_mask = 0U;
};
using reference_map = std::map<key, reference_height>;

// Independent oracle: expand the entire CBDAM level, without point lookup,
// demand closure, target selection or the planner's parent indices.
reference_map full_hierarchy(bool globe, std::uint32_t dimension, std::uint32_t depth,
                             const std::set<key>& absent = {}) {
  reference_map current;
  std::vector<core::grid_diamond> roots{core::planar_root()};
  if (globe) {
    const auto values = core::cylindrical_roots();
    roots.assign(values.begin(), values.end());
  }
  for (const auto& d : roots) {
    auto& value = current[{0U, d.id()}]; value.diamond = d;
    expect(codec::make_cbdam_root_height(record({0U, d.id()}, dimension, true), value.height)
        == codec::hierarchy_status::ok, "reference root failed");
  }
  for (std::uint32_t level = 0U; level < depth; ++level) {
    reference_map next;
    for (const auto& value : current) {
      codec::height_refinement refined;
      const bool procedural = absent.count(value.first) || (level > 0U &&
          value.second.procedural_mask == value.second.height.fragment_mask);
      auto detail = record(value.first, dimension, false);
      if (procedural) std::fill(detail.values.begin(), detail.values.end(), 0);
      expect(codec::refine_cbdam_height(value.second.height, detail, refined) == codec::hierarchy_status::ok,
          "reference refinement failed");
      for (std::size_t f = 0U; f < 2U; ++f) for (std::size_t c = 0U; c < 2U; ++c) {
        if (!refined.has_child(f, c)) continue;
        const auto d = child(value.second.diamond, globe, f, c);
        auto& output = next[{level + 1U, d.id()}]; output.diamond = d;
        const auto inherited = d.parent_id(0U) == value.first.second ? 0U : 1U;
        output.height.dimension = dimension;
        output.height.fragment_mask |= std::uint8_t(1U << inherited);
        if (procedural) output.procedural_mask |= std::uint8_t(1U << inherited);
        output.height.fragments[inherited] = std::move(refined.children[2U * f + c]);
      }
    }
    current = std::move(next);
  }
  return current;
}

std::vector<codec::height_diamond> reconstruct(const frame::height_demand_plan& plan,
                                             std::uint32_t dimension,
                                             bool mirror_missing_parent = false) {
  std::vector<codec::height_diamond> heights(plan.nodes.size());
  std::map<std::size_t, codec::height_refinement> refinements;
  for (std::size_t i = 0U; i < plan.nodes.size(); ++i) {
    const auto& node = plan.nodes[i]; auto& h = heights[i];
    if (!node.level) {
      expect(codec::make_cbdam_root_height(record({0U, node.diamond.id()}, dimension, true), h)
          == codec::hierarchy_status::ok, "demand root failed");
      continue;
    }
    for (std::size_t f = 0U; f < 2U; ++f) {
      if ((node.fragment_mask & (1U << f)) == 0U) continue;
      const auto& parent = node.parents[f];
      expect(parent.index < i, "dependencies are not parent-before-child");
      const auto& parent_node = plan.nodes[parent.index];
      expect(parent_node.needs_detail && parent_node.level + 1U == node.level &&
          parent_node.diamond.id() == node.diamond.parent_id(f), "wrong parent record");
      if (mirror_missing_parent || !refinements.count(parent.index)) {
        auto input = heights[parent.index];
        if (mirror_missing_parent) input.fragment_mask = std::uint8_t(1U << parent.fragment);
        expect(codec::refine_cbdam_height(input,
            record({parent_node.level, parent_node.diamond.id()}, dimension, false),
            refinements[parent.index]) == codec::hierarchy_status::ok,
            "demand refinement failed");
      }
      const auto& refined = refinements.at(parent.index);
      expect(refined.has_child(parent.fragment, parent.child), "required parent fragment missing");
      h.dimension = dimension; h.fragment_mask |= std::uint8_t(1U << f);
      h.fragments[f] = refined.children[2U * parent.fragment + parent.child];
    }
  }
  return heights;
}

frame::height_demand_plan finish(frame::height_demand_request request, std::size_t slice) {
  frame::height_demand_planner planner;
  expect(planner.begin(request) == height_demand_state::working, "query start failed");
  expect(planner.step(0U) == height_demand_state::working && planner.work_count() == 0U,
         "zero work consumed a slice");
  while (planner.state() == height_demand_state::working) {
    const auto before = planner.work_count();
    expect(planner.plan().nodes.empty(), "partial plan escaped before dependency completion");
    planner.step(slice);
    expect(planner.work_count() - before <= slice, "planner exceeded the work slice");
    expect(planner.node_count() <= request.maximum_node_count, "planner exceeded node capacity");
    expect(planner.work_count() < 100000U, "planner failed to finish in bounded work");
  }
  if (planner.state() != height_demand_state::ready) {
    std::cerr << "query " << request.cylindrical << ' ' << request.u << ' ' << request.v
              << " depth " << request.maximum_level << " status " << int(planner.state()) << '\n';
    throw std::runtime_error("query planning failed");
  }
  expect(planner.plan().target < planner.plan().nodes.size(), "no target");
  return planner.plan();
}

void verify_oracle(bool globe) {
  frame::height_demand_request request;
  request.cylindrical = globe; request.patch_dimension = 8U;
  request.maximum_level = 5U; request.sample_spacing_metres = 1e-4;
  request.bounds = core::bounds2d({{-180.0, -90.0}}, {{180.0, 90.0}});
  const auto reference = full_hierarchy(globe, request.patch_dimension, request.maximum_level);
  std::size_t cases = 0U, maximum_nodes = 0U, missing_parent_mismatches = 0U;
  for (const double u : {-180.0, -179.99, -135.0, -90.0, -89.99, -45.0, 0.0,
                          0.0001, 35.6, 45.0, 90.0, 90.01, 135.0, 179.99, 180.0}) {
    for (const double v : {-90.0, -89.999, -45.0, -0.001, 0.0, 0.001, 40.74863,
                            45.0, 89.999, 90.0}) {
      request.u = u; request.v = v;
      const auto plan = finish(request, 1U);
      const auto values = reconstruct(plan, request.patch_dimension);
      const auto& target = plan.nodes[plan.target];
      expect(target.level == request.maximum_level && !plan.spacing_reached,
             "source level limit was presented as meeting requested spacing");
      expect(!target.needs_detail, "planner downloaded the target's unnecessary residual");
      const auto& expected = reference.at({target.level, target.diamond.id()}).height;
      expect(expected.has_fragment(plan.fragment) &&
          values[plan.target].fragments[plan.fragment].values == expected.fragments[plan.fragment].values,
          "independent reconstruction differs from the complete CBDAM hierarchy");
      const auto mirrored = reconstruct(plan, request.patch_dimension, true);
      if (mirrored[plan.target].fragments[plan.fragment].values != expected.fragments[plan.fragment].values)
        ++missing_parent_mismatches;
      const auto point = frame::height_query_grid(u, v, globe, request.bounds);
      double actual = 0.0, oracle = 0.0;
      expect(frame::sample_height_fragment(target.diamond, plan.fragment,
          values[plan.target].fragments[plan.fragment], point, actual) &&
          frame::sample_height_fragment(target.diamond, plan.fragment,
          expected.fragments[plan.fragment], point, oracle) && actual == oracle,
          "query sample differs from reference");
      std::set<key> keys;
      for (const auto& node : plan.nodes)
        expect(keys.insert({node.level, node.diamond.id()}).second, "dependency downloaded twice");
      maximum_nodes = std::max(maximum_nodes, plan.nodes.size()); ++cases;
    }
  }
  expect(maximum_nodes < reference.size(), "point query expanded the complete level");
  expect(missing_parent_mismatches > 0U, "oracle cannot detect incomplete parent reconstruction");
  std::cout << "height_demand mode=" << (globe ? "globe" : "planar")
            << " full_hierarchy_cases=" << cases << " max_nodes=" << maximum_nodes
            << " missing_parent_mismatches=" << missing_parent_mismatches << '\n';
}

void verify_controls() {
  frame::height_demand_request request;
  request.u = 116.5623; request.v = 40.74863;
  const auto serial = finish(request, 1U), batch = finish(request, 100000U);
  expect(serial.spacing_reached && serial.sample_spacing_metres <= 30.0,
         "horizontal spacing demand did not converge");
  expect(serial.nodes.size() == batch.nodes.size() && serial.target == batch.target &&
      serial.fragment == batch.fragment, "work slice changed topology");
  for (std::size_t i = 0U; i < serial.nodes.size(); ++i) {
    const auto& a = serial.nodes[i]; const auto& b = batch.nodes[i];
    expect(a.level == b.level && a.diamond.id() == b.diamond.id() &&
        a.fragment_mask == b.fragment_mask && a.needs_detail == b.needs_detail,
        "work slice changed a dependency");
    for (std::size_t f = 0U; f < 2U; ++f)
      expect(a.parents[f].index == b.parents[f].index &&
          a.parents[f].fragment == b.parents[f].fragment && a.parents[f].child == b.parents[f].child,
          "work slice changed a parent edge");
  }
  frame::height_demand_planner planner;
  request.maximum_node_count = serial.nodes.size() - 1U;
  planner.begin(request); planner.step(100000U);
  expect(planner.state() == height_demand_state::resource_limit && planner.plan().nodes.empty() &&
      planner.node_count() == 0U, "incomplete dependencies survived capacity rejection");
  request.maximum_node_count = serial.nodes.size();
  expect(finish(request, 7U).nodes.size() == serial.nodes.size(), "exact capacity failed");
  planner.begin(request); planner.step(3U); planner.clear();
  expect(planner.state() == height_demand_state::idle && planner.node_count() == 0U &&
      planner.work_count() == 0U && planner.plan().nodes.empty(), "clear retained stale work");
  planner.begin(request); planner.step(2U);
  request.u = -123.2; request.v = -23.7;
  planner.begin(request); planner.step(100000U);
  expect(planner.state() == height_demand_state::ready &&
      planner.plan().nodes[planner.plan().target].diamond.id() != serial.nodes[serial.target].diamond.id(),
      "new demand published old query work");
  request.sample_spacing_metres = 1e8; request.maximum_node_count = 1U;
  const auto coarse = finish(request, 1U);
  expect(coarse.nodes.size() == 1U && coarse.nodes.front().level == 0U && coarse.spacing_reached,
         "coarse query downloaded unnecessary intermediate records");
  request.sample_spacing_metres = std::numeric_limits<double>::quiet_NaN();
  expect(planner.begin(request) == height_demand_state::invalid_argument && planner.plan().nodes.empty(),
         "invalid query retained a previous ready plan");
  request.sample_spacing_metres = 1.0;
  request.u = 181.0;
  expect(planner.begin(request) == height_demand_state::invalid_argument, "invalid longitude accepted");
  request.u = 0.0; request.cylindrical = false;
  expect(planner.begin(request) == height_demand_state::invalid_argument, "degenerate bounds accepted");

  request = frame::height_demand_request(); request.sample_spacing_metres = 1e-9;
  std::size_t max_nodes = 0U;
  for (const double u : {-180.0, -179.9999, -90.0, 0.0, 90.0, 116.5623, 180.0})
    for (const double v : {-90.0, -0.0001, 0.0, 40.74863, 90.0}) {
      request.u = u; request.v = v;
      const auto plan = finish(request, 7U);
      expect(plan.nodes[plan.target].level == 39U && !plan.spacing_reached,
             "deep query failed to report topology limit");
      max_nodes = std::max(max_nodes, plan.nodes.size());
    }
  std::cout << "height_demand depth=39 max_nodes=" << max_nodes << '\n';
}

void verify_session() {
  frame::height_demand_request request;
  request.patch_dimension = 8U; request.maximum_level = 5U;
  request.u = 116.5623; request.v = 40.74863; request.sample_spacing_metres = 1e-4;
  const auto plan = finish(request, 3U);
  const auto reference = full_hierarchy(true, 8U, 5U);
  frame::height_session session;
  std::vector<frame::height_session_request> receipts;
  std::set<key> absent_records, downloaded;
  const auto run = [&](bool absent, bool failure) {
    downloaded.clear();
    expect(session.begin(request, 0.015625, 2U * 1024U * 1024U) == frame::height_session_state::planning,
        "independent session did not start");
    for (const auto& r : receipts)
      expect(session.input_state(r) == frame::height_input_state::unknown, "new query retained old receipts");
    receipts.clear();
    for (std::size_t turn = 0; turn < 10000U; ++turn) {
      session.step(3U);
      expect(session.payload_bytes() <= session.maximum_bytes() && session.peak_bytes() <= session.maximum_bytes(),
          "query exceeded admitted payload/workspace");
      if (session.state() >= frame::height_session_state::ready) {
        for (const auto& r : receipts)
          expect(session.input_state(r) == frame::height_input_state::consumed, "completion lost receipt identity");
        return;
      }
      if (session.state() != frame::height_session_state::waiting) continue;
      const auto before = session.payload_bytes();
      expect(session.step(1000U) == frame::height_session_state::waiting && session.payload_bytes() == before,
          "query polled work while waiting for records");
      auto pending = session.requests();
      expect(!pending.empty() && pending.size() <= frame::height_session::maximum_requests, "unbounded query frontier");
      std::reverse(pending.begin(), pending.end());
      for (const auto& r : pending) {
        expect(session.input_state(r) == frame::height_input_state::pending, "missing pending input identity");
        if (!r.root && ((absent && r.level >= 2U) || absent_records.count({r.level, r.id})))
          expect(session.unavailable(r, failure), "absence was not accepted");
        else {
          expect(session.can_decode(r), "valid record could not be admitted");
          auto data = record({r.level, r.id}, request.patch_dimension, r.root);
          if (!r.root) downloaded.insert({r.level, r.id});
          expect(session.submit(r, std::move(data)), "query rejected requested record");
          expect(!session.can_decode(r), "duplicate submission remained requested");
        }
        expect(session.input_state(r) == frame::height_input_state::consumed, "consumed input remained unknown");
        receipts.push_back(r);
      }
    }
    throw std::runtime_error("query did not finish");
  };
  run(false, false);
  expect(session.state() == frame::height_session_state::limited && session.sample().reasons == frame::height_level_limit,
      "topology limit was not explicit");
  const auto& target = plan.nodes[plan.target];
  double expected = 0;
  expect(frame::sample_height_fragment(target.diamond, plan.fragment,
      reference.at({target.level, target.diamond.id()}).height.fragments[plan.fragment],
      frame::height_query_grid(request.u, request.v, true, request.bounds), expected), "oracle sample missing");
  expect(session.sample().available && session.sample().level == 5U &&
      session.sample().height_metres == expected * 0.015625 &&
      session.region().heights.values == reference.at({target.level, target.diamond.id()}).height.fragments[plan.fragment].values &&
      session.payload_bytes() == session.region().heights.values.capacity() * sizeof(std::int32_t),
      "queried region differs from complete hierarchy or retains dependency payload");
  run(true, false);
  expect(session.sample().available && session.sample().level == 5U && session.sample().data_level <= 2U &&
      (session.sample().reasons & frame::height_no_data) && !(session.sample().reasons & frame::height_request_failed),
      "missing detail improved precision or became a network failure");
  std::set<key> all_missing;
  for (const auto& node : plan.nodes) if (node.level >= 2U)
    all_missing.insert({node.level, node.diamond.id()});
  const auto sparse = full_hierarchy(true, 8U, 5U, all_missing);
  frame::sample_height_fragment(target.diamond, plan.fragment,
      sparse.at({target.level, target.diamond.id()}).height.fragments[plan.fragment],
      frame::height_query_grid(request.u, request.v, true, request.bounds), expected);
  expect(session.sample().height_metres == expected * 0.015625,
      "absent residual query differs from complete zero-residual reconstruction");
  // Missing one dependency cannot suppress real records in mixed descendants.
  absent_records.insert(*all_missing.begin());
  run(false, false);
  const auto mixed = full_hierarchy(true, 8U, 5U, absent_records);
  frame::sample_height_fragment(target.diamond, plan.fragment,
      mixed.at({target.level, target.diamond.id()}).height.fragments[plan.fragment],
      frame::height_query_grid(request.u, request.v, true, request.bounds), expected);
  expect(session.sample().level == 5U && session.sample().height_metres == expected * 0.015625 &&
      std::any_of(downloaded.begin(), downloaded.end(), [](const key& k) { return k.first > 2U; }),
      "missing dependency suppressed a real mixed descendant");
  absent_records.clear();
  run(true, true);
  expect(session.sample().available && (session.sample().reasons & frame::height_request_failed),
      "request failure lost its reason");
  session.begin(request, 1.0, 16U);
  while (session.state() < frame::height_session_state::ready) session.step(8U);
  expect(session.requests().empty() && session.state() == frame::height_session_state::failed &&
      session.sample().reasons == frame::height_capacity, "impossible query requested I/O before capacity rejection");
  session.clear();
  expect(session.payload_bytes() == 0U && session.requests().empty() && session.state() == frame::height_session_state::idle,
      "query cancellation retained work");
  request.sample_spacing_metres = 1e8;
  run(false, false);
  expect(session.state() == frame::height_session_state::ready && session.sample().level == 0U &&
      !session.sample().reasons, "coarse ready query fetched detail");
}
}  // namespace

int main() {
  verify_oracle(false);
  verify_oracle(true);
  verify_controls();
  verify_session();
}
