#include <terra/frame/height_demand.hpp>

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/height_query.hpp>

#include <cmath>
#include <map>
#include <utility>

namespace terra {
namespace frame {
namespace {
using key = std::pair<std::uint32_t, core::grid_point>;

std::uint8_t valid_mask(const core::grid_diamond& diamond) {
  std::uint8_t mask = 0U;
  for (std::size_t f = 0U; f < 2U; ++f) {
    bool valid = true;
    for (const auto coordinate : diamond.parent_id(f))
      valid = valid && coordinate >= core::grid_coordinate_min &&
          coordinate <= core::grid_coordinate_max;
    if (valid) mask |= std::uint8_t(1U << f);
  }
  return mask;
}

bool contains(const core::grid_diamond& diamond, std::size_t fragment,
              const core::vector3d& point) {
  core::vector2d uv;
  return (valid_mask(diamond) & (1U << fragment)) != 0U &&
      height_fragment_coordinates(diamond, fragment, point, uv);
}

bool valid_request(const height_demand_request& request) {
  if (!std::isfinite(request.u) || !std::isfinite(request.v) ||
      !std::isfinite(request.sample_spacing_metres) ||
      request.sample_spacing_metres <= 0.0 || request.maximum_level >= 40U ||
      request.patch_dimension == 0U ||
      request.patch_dimension > codec::maximum_cbdam_patch_dimension ||
      request.maximum_node_count == 0U || request.maximum_node_count > 4096U)
    return false;
  if (request.cylindrical)
    return std::isfinite(request.radius) && request.radius > 0.0 &&
        request.u >= -180.0 && request.u <= 180.0 &&
        request.v >= -90.0 && request.v <= 90.0;
  for (std::size_t axis = 0U; axis < 2U; ++axis) {
    const double low = request.bounds.minimum[axis];
    const double high = request.bounds.maximum[axis];
    const double coordinate = axis == 0U ? request.u : request.v;
    if (!std::isfinite(low) || !std::isfinite(high) || low >= high ||
        !std::isfinite(high - low) || coordinate < low || coordinate > high)
      return false;
  }
  return true;
}
}  // namespace

struct height_demand_planner::implementation {
  enum class phase { target, dependencies, locate, emit };
  struct entry {
    height_demand_node node;
    std::size_t output_index = no_height_parent;
  };
  height_demand_request request;
  height_demand_state status = height_demand_state::idle;
  phase next = phase::target;
  height_demand_plan result, pending;
  core::vector3d point{{0, 0, 0}};
  core::grid_diamond target;
  std::uint32_t target_level = 0U;
  std::uint8_t target_fragment = 0U;
  std::map<key, entry> entries;
  std::vector<key> queue;
  std::size_t cursor = 0U, parent_fragment = 0U, work = 0U;
  key sought;
  std::vector<core::grid_diamond> frontier;
  std::uint32_t locate_level = 0U;
  std::map<key, entry>::iterator emitting;

  std::vector<core::grid_diamond> roots() const {
    if (!request.cylindrical) return {core::planar_root()};
    const auto values = core::cylindrical_roots();
    return {values.begin(), values.end()};
  }

  core::grid_diamond child(const core::grid_diamond& diamond,
                          std::size_t f, std::size_t c) const {
    return request.cylindrical ? diamond.cylindrical_child_diamond(f, c)
                               : diamond.planar_child_diamond(f, c);
  }

  void fail(height_demand_state value) {
    status = value;
    entries.clear(); queue.clear(); frontier.clear(); pending = height_demand_plan();
  }

  bool insert(std::uint32_t level, const core::grid_diamond& diamond,
              std::uint8_t mask) {
    const key id{level, diamond.id()};
    if (entries.count(id)) return true;
    if (entries.size() >= request.maximum_node_count) {
      fail(height_demand_state::resource_limit);
      return false;
    }
    entry value;
    value.node.level = level;
    value.node.diamond = diamond;
    value.node.fragment_mask = mask;
    entries.emplace(id, value);
    queue.push_back(id);
    return true;
  }

  void select_target() {
    const double spacing = height_sample_spacing(target, target_fragment,
        request.patch_dimension, request.cylindrical, request.bounds, request.radius);
    if (!std::isfinite(spacing) || spacing <= 0.0) {
      fail(height_demand_state::invalid_argument);
      return;
    }
    if (spacing <= request.sample_spacing_metres || target_level == request.maximum_level) {
      pending.sample_spacing_metres = spacing;
      pending.spacing_reached = spacing <= request.sample_spacing_metres;
      pending.fragment = target_fragment;
      if (insert(target_level, target, std::uint8_t(1U << target_fragment)))
        next = phase::dependencies;
      return;
    }
    for (std::size_t c = 0U; c < 2U; ++c) {
      const auto candidate = child(target, target_fragment, c);
      const std::uint8_t f = candidate.parent_id(0U) == target.id() ? 0U : 1U;
      if (!contains(candidate, f, point)) continue;
      target = candidate; target_fragment = f; ++target_level;
      return;
    }
    fail(height_demand_state::invalid_topology);
  }

  bool link(entry& output, std::size_t fragment, entry& parent) {
    for (std::size_t f = 0U; f < 2U; ++f) {
      if ((parent.node.fragment_mask & (1U << f)) == 0U) continue;
      for (std::size_t c = 0U; c < 2U; ++c) {
        const auto candidate = child(parent.node.diamond, f, c);
        if (candidate.id() != output.node.diamond.id() ||
            candidate.parent_id(fragment) != parent.node.diamond.id()) continue;
        auto& dependency = output.node.parents[fragment];
        dependency.fragment = static_cast<std::uint8_t>(f);
        dependency.child = static_cast<std::uint8_t>(c);
        parent.node.needs_detail = true;
        return true;
      }
    }
    fail(height_demand_state::invalid_topology);
    return false;
  }

  void dependencies() {
    if (cursor == queue.size()) {
      pending.nodes.reserve(entries.size());
      emitting = entries.begin(); next = phase::emit;
      return;
    }
    auto& value = entries.at(queue[cursor]);
    if (value.node.level == 0U || parent_fragment == 2U) {
      ++cursor; parent_fragment = 0U;
      return;
    }
    const auto f = parent_fragment;
    if ((value.node.fragment_mask & (1U << f)) == 0U) { ++parent_fragment; return; }
    sought = {value.node.level - 1U, value.node.diamond.parent_id(f)};
    const auto found = entries.find(sought);
    if (found != entries.end()) {
      if (link(value, f, found->second)) ++parent_fragment;
      return;
    }
    // Resolve the other parent geometrically; following just the sample's one
    // triangle would mirror a missing half during lifting and change heights.
    frontier = roots(); locate_level = 0U; next = phase::locate;
  }

  void locate() {
    if (locate_level == sought.first) {
      for (const auto& diamond : frontier) {
        if (diamond.id() != sought.second) continue;
        if (insert(locate_level, diamond, valid_mask(diamond))) next = phase::dependencies;
        return;
      }
      fail(height_demand_state::invalid_topology);
      return;
    }
    const core::vector3d location{{double(sought.second[0]), double(sought.second[1]),
                                  double(sought.second[2])}};
    std::map<core::grid_point, core::grid_diamond> candidates;
    for (const auto& diamond : frontier) {
      for (std::size_t f = 0U; f < 2U; ++f) {
        if (!contains(diamond, f, location)) continue;
        for (std::size_t c = 0U; c < 2U; ++c) {
          const auto value = child(diamond, f, c);
          const auto inherited = value.parent_id(0U) == diamond.id() ? 0U : 1U;
          if (contains(value, inherited, location)) candidates.emplace(value.id(), value);
        }
      }
    }
    // Point membership has bounded local valence, even at root/pole seams.
    // Never turn a malformed query into a full-level breadth-first traversal.
    if (candidates.empty() || candidates.size() > 32U) {
      fail(height_demand_state::invalid_topology);
      return;
    }
    frontier.clear();
    for (const auto& candidate : candidates) frontier.push_back(candidate.second);
    ++locate_level;
  }

  void emit() {
    if (emitting == entries.end()) {
      result = std::move(pending);
      entries.clear(); queue.clear(); frontier.clear();
      status = height_demand_state::ready;
      return;
    }
    auto& value = emitting->second;
    value.output_index = pending.nodes.size();
    if (value.node.level > 0U) for (std::size_t f = 0U; f < 2U; ++f) {
      if ((value.node.fragment_mask & (1U << f)) == 0U) continue;
      const auto& parent = entries.at({value.node.level - 1U, value.node.diamond.parent_id(f)});
      value.node.parents[f].index = parent.output_index;
    }
    if (emitting->first == key{target_level, target.id()}) pending.target = value.output_index;
    pending.nodes.push_back(value.node);
    ++emitting;
  }

  void advance() {
    ++work;
    switch (next) {
      case phase::target: select_target(); break;
      case phase::dependencies: dependencies(); break;
      case phase::locate: locate(); break;
      case phase::emit: emit(); break;
    }
  }
};

height_demand_planner::height_demand_planner() : implementation_(new implementation()) {}
height_demand_planner::~height_demand_planner() = default;

void height_demand_planner::clear() { implementation_.reset(new implementation()); }

height_demand_state height_demand_planner::begin(const height_demand_request& request) {
  clear();
  auto& p = *implementation_;
  if (!valid_request(request)) return p.status = height_demand_state::invalid_argument;
  p.request = request;
  p.point = height_query_grid(request.u, request.v, request.cylindrical, request.bounds);
  for (const auto& root : p.roots()) for (std::uint8_t f = 0U; f < 2U; ++f) {
    if (!contains(root, f, p.point)) continue;
    p.target = root; p.target_fragment = f;
    return p.status = height_demand_state::working;
  }
  return p.status = height_demand_state::invalid_topology;
}

height_demand_state height_demand_planner::step(std::size_t maximum_work) {
  auto& p = *implementation_;
  while (maximum_work && p.status == height_demand_state::working) {
    --maximum_work; p.advance();
  }
  return p.status;
}
height_demand_state height_demand_planner::state() const { return implementation_->status; }
const height_demand_plan& height_demand_planner::plan() const { return implementation_->result; }
std::size_t height_demand_planner::work_count() const { return implementation_->work; }
std::size_t height_demand_planner::node_count() const {
  return implementation_->status == height_demand_state::ready
      ? implementation_->result.nodes.size() : implementation_->entries.size();
}
}  // namespace frame
}  // namespace terra
