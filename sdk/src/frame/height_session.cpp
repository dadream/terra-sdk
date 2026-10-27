#include <terra/frame/height_session.hpp>

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/height_query.hpp>
#include <terra/frame/height_storage.hpp>

#include <algorithm>
#include <cmath>

namespace terra {
namespace frame {
namespace {
std::size_t fragment_bytes(std::size_t n) { return height_storage::fragment_bytes(n); }
bool same(const height_session_request& a, const height_session_request& b) {
  return a.level == b.level && a.id == b.id && a.root == b.root;
}
}  // namespace

struct height_session::implementation {
  struct link { std::size_t node, fragment, slot; };
  struct node_state {
    codec::height_diamond height;
    codec::height_patch record;
    std::vector<link> children;
    std::array<std::uint32_t, 2U> data_level{{0U, 0U}};
    std::array<double, 2U> data_spacing{{0.0, 0.0}};
    bool root_ready = false, done = false, procedural = false;
    std::uint32_t blocked = 0U;
  };
  height_demand_planner planner;
  height_demand_request request;
  height_session_state status = height_session_state::idle;
  height_session_sample result;
  height_session_region region;
  std::vector<node_state> nodes;
  std::vector<height_session_request> pending, consumed;
  core::vector3d point{{0, 0, 0}};
  double scale = 1.0;
  std::size_t maximum = 0U, peak = 0U, cursor = 0U;
  bool changed = false;

  std::size_t bytes() const {
    std::size_t result = region.heights.values.capacity() * sizeof(std::int32_t);
    for (const auto& node : nodes) {
      result += node.record.values.capacity() * sizeof(std::int32_t);
      for (const auto& h : node.height.fragments) result += h.values.capacity() * sizeof(std::int32_t);
    }
    return result;
  }
  bool admit(std::size_t extra) {
    const auto total = bytes() + extra;
    if (total > maximum) {
      result.reasons |= height_capacity;
      status = height_session_state::failed; pending.clear();
      return false;
    }
    peak = std::max(peak, total);
    return true;
  }
  height_session_request record_for(std::size_t index) const {
    const auto& node = planner.plan().nodes[index];
    return {node.level, node.diamond.id(), node.level == 0U && !nodes[index].root_ready};
  }
  std::size_t find(const height_session_request& value) const {
    if (status != height_session_state::working && status != height_session_state::waiting)
      return nodes.size();
    if (std::none_of(pending.begin(), pending.end(), [&](const height_session_request& p) {
      return same(p, value);
    })) return nodes.size();
    for (std::size_t i = 0U; i < nodes.size(); ++i) if (same(record_for(i), value)) return i;
    return nodes.size();
  }
  void remove(const height_session_request& value) {
    consumed.push_back(value);
    pending.erase(std::remove_if(pending.begin(), pending.end(),
        [&](const height_session_request& p) { return same(p, value); }), pending.end());
    status = height_session_state::working; cursor = 0U;
  }
  void sample_fragment(std::size_t index, std::size_t fragment) {
    const auto& description = planner.plan().nodes[index];
    if (result.available && result.level > description.level) return;
    double height = 0.0;
    if (!sample_height_fragment(description.diamond, fragment,
        nodes[index].height.fragments[fragment], point, height)) return;
    result.available = true; result.level = description.level;
    result.data_level = nodes[index].data_level[fragment];
    result.id = description.diamond.id(); result.fragment = static_cast<std::uint32_t>(fragment);
    result.height_metres = height * scale;
    result.sample_spacing_metres = nodes[index].data_spacing[fragment];
  }
  void complete() {
    if (result.available && result.sample_spacing_metres <= request.sample_spacing_metres)
      status = height_session_state::ready;
    else if (result.available) {
      if (!planner.plan().spacing_reached) result.reasons |= height_level_limit;
      status = height_session_state::limited;
    } else status = height_session_state::unavailable;
    pending.clear();
    // Keep only the completed target fragment, never the dependency graph's
    // other heights. Its bytes remain charged until the receiver/end receipt.
    nodes.clear();
  }
  void process() {
    const auto& plan = planner.plan();
    if (cursor == nodes.size()) {
      cursor = 0U;
      if (std::all_of(nodes.begin(), nodes.end(), [](const node_state& n) { return n.done; })) complete();
      else if (!pending.empty()) { status = height_session_state::waiting; changed = false; }
      else if (changed) changed = false;
      else { result.reasons |= height_invalid; status = height_session_state::failed; }
      return;
    }
    const auto index = cursor++;
    auto& node = nodes[index]; const auto& description = plan.nodes[index];
    if (node.done) return;
    for (std::size_t f = 0U; f < 2U; ++f) {
      const auto parent = description.parents[f].index;
      if (parent != no_height_parent) node.blocked |= nodes[parent].blocked;
    }
    if (node.blocked) {
      result.reasons |= node.blocked; node.done = true; changed = true;
      node.height = codec::height_diamond(); node.record = codec::height_patch();
      return;
    }
    if (description.level > 0U &&
        (node.height.fragment_mask & description.fragment_mask) != description.fragment_mask) return;
    if (description.level > 0U && description.needs_detail) {
      bool inherited_absence = true;
      for (const auto& parent : description.parents) if (parent.index != no_height_parent)
        inherited_absence = inherited_absence && nodes[parent.index].procedural;
      node.procedural = node.procedural || inherited_absence;
    }
    if (description.level == 0U && !node.root_ready) {
      if (!node.record.empty()) {
        if (!admit(2U * fragment_bytes(request.patch_dimension))) return;
        if (codec::make_cbdam_root_height(node.record, node.height) != codec::hierarchy_status::ok) {
          result.reasons |= height_invalid; status = height_session_state::failed; return;
        }
        node.record = codec::height_patch(); node.root_ready = true; changed = true;
        for (std::size_t f = 0U; f < 2U; ++f) {
          node.data_spacing[f] = height_sample_spacing(description.diamond, f,
              request.patch_dimension, request.cylindrical, request.bounds, request.radius);
          sample_fragment(index, f);
        }
        return;
      }
    } else if (!description.needs_detail) {
      if (index == plan.target && result.available && result.level == description.level &&
          result.id == description.diamond.id()) {
        region.heights = std::move(node.height.fragments[result.fragment]);
        const std::size_t corners[] = {(1U + 2U * result.fragment) % 4U,
            (2U + 2U * result.fragment) % 4U, (2U * result.fragment) % 4U};
        for (std::size_t c = 0U; c < 3U; ++c) for (std::size_t axis = 0U; axis < 3U; ++axis)
          region.corners[c][axis] = description.diamond.corner(corners[c])[axis];
        region.geometry_spacing_metres = height_sample_spacing(description.diamond, result.fragment,
            request.patch_dimension, request.cylindrical, request.bounds, request.radius);
        region.height_scale = scale;
      }
      node.done = true; node.height = codec::height_diamond(); changed = true; return;
    } else if (!node.record.empty() || node.procedural) {
      const std::size_t n = request.patch_dimension;
      if (node.record.empty()) {
        if (!admit(n * n * 4U)) return;
        node.record.rows = node.record.columns = request.patch_dimension;
        node.record.values.assign(n * n, 0);
      }
      const auto scratch = height_storage::workspace_bytes(n);
      if (!admit(scratch + 4U * fragment_bytes(n))) return;
      codec::height_refinement refined;
      if (codec::refine_cbdam_height(node.height, node.record, refined) != codec::hierarchy_status::ok) {
        result.reasons |= height_invalid; status = height_session_state::failed; return;
      }
      for (const auto& target : node.children) {
        auto& child = nodes[target.node];
        auto& output = child.height;
        child.data_level[target.fragment] = node.procedural
            ? node.data_level[target.slot / 2U] : plan.nodes[target.node].level;
        child.data_spacing[target.fragment] = node.procedural
            ? node.data_spacing[target.slot / 2U]
            : height_sample_spacing(plan.nodes[target.node].diamond, target.fragment,
                request.patch_dimension, request.cylindrical, request.bounds, request.radius);
        output.dimension = request.patch_dimension;
        output.fragment_mask |= std::uint8_t(1U << target.fragment);
        output.fragments[target.fragment] = std::move(refined.children[target.slot]);
        sample_fragment(target.node, target.fragment);
      }
      node.done = true; node.height = codec::height_diamond();
      node.record = codec::height_patch(); changed = true;
      return;
    }
    const auto needed = record_for(index);
    if (pending.size() < maximum_requests && std::none_of(pending.begin(), pending.end(),
        [&](const height_session_request& p) { return same(p, needed); })) pending.push_back(needed);
  }
};

height_session::height_session() : implementation_(new implementation()) {}
height_session::~height_session() = default;
void height_session::clear() { implementation_.reset(new implementation()); }
height_session_state height_session::begin(const height_demand_request& request,
                                           double height_scale, std::size_t maximum_bytes) {
  clear(); auto& s = *implementation_;
  s.request = request; s.scale = height_scale; s.maximum = maximum_bytes;
  if (!std::isfinite(height_scale) || height_scale <= 0.0 || maximum_bytes == 0U ||
      maximum_bytes > 32U * 1024U * 1024U || request.maximum_node_count > 512U ||
      s.planner.begin(request) != height_demand_state::working) {
    s.result.reasons = height_invalid; return s.status = height_session_state::failed;
  }
  s.point = height_query_grid(request.u, request.v, request.cylindrical, request.bounds);
  return s.status = height_session_state::planning;
}
height_session_state height_session::step(std::size_t maximum_work) {
  auto& s = *implementation_;
  while (maximum_work && (s.status == height_session_state::planning || s.status == height_session_state::working)) {
    --maximum_work;
    if (s.status == height_session_state::planning) {
      const auto state = s.planner.step(1U);
      if (state == height_demand_state::ready) {
        const auto& plan = s.planner.plan();
        const std::size_t n = s.request.patch_dimension;
        const auto root_peak = (n + 1U) * (n + 1U) * 4U + 2U * fragment_bytes(n);
        const auto refinement_peak = height_storage::workspace_bytes(n) + n * n * 4U + 6U * fragment_bytes(n);
        if (s.maximum < (plan.nodes.size() == 1U ? root_peak : std::max(root_peak, refinement_peak))) {
          s.result.reasons = height_capacity; s.status = height_session_state::failed; continue;
        }
        s.nodes.resize(plan.nodes.size());
        // Each planned node consumes at most one root and one detail input.
        // This bounded identity ledger belongs to the metadata reservation and
        // remains alive after payload reconstruction completes.
        s.consumed.reserve(2U * plan.nodes.size());
        for (std::size_t i = 0U; i < plan.nodes.size(); ++i) for (std::size_t f = 0U; f < 2U; ++f) {
          const auto& parent = plan.nodes[i].parents[f];
          if (parent.index != no_height_parent)
            s.nodes[parent.index].children.push_back({i, f, 2U * parent.fragment + parent.child});
        }
        s.status = height_session_state::working;
      } else if (state != height_demand_state::working) {
        s.result.reasons = state == height_demand_state::resource_limit ? height_capacity : height_invalid;
        s.status = height_session_state::failed;
      }
    } else s.process();
  }
  return s.status;
}
height_input_state height_session::input_state(const height_session_request& request) const {
  const auto& s = *implementation_;
  if (std::any_of(s.consumed.begin(), s.consumed.end(), [&](const height_session_request& r) {
    return same(r, request);
  })) return height_input_state::consumed;
  return s.find(request) != s.nodes.size() ? height_input_state::pending : height_input_state::unknown;
}
bool height_session::can_decode(const height_session_request& request) const {
  const auto& s = *implementation_;
  const auto n = s.request.patch_dimension + (request.root ? 1U : 0U);
  return s.find(request) != s.nodes.size() && s.bytes() + std::size_t(n) * n * 4U <= s.maximum;
}
bool height_session::submit(const height_session_request& request, codec::height_patch&& record) {
  auto& s = *implementation_; const auto index = s.find(request);
  const auto dimension = s.request.patch_dimension + (request.root ? 1U : 0U);
  if (index == s.nodes.size() || record.rows != dimension || record.columns != dimension ||
      record.values.size() != std::size_t(dimension) * dimension) return false;
  if (!s.admit(record.values.capacity() * sizeof(std::int32_t))) return false;
  s.nodes[index].record = std::move(record); s.remove(request);
  return true;
}
bool height_session::unavailable(const height_session_request& request, bool failure) {
  auto& s = *implementation_; const auto index = s.find(request);
  if (index == s.nodes.size()) return false;
  if (!failure && !request.root) {
    // Repository absence is zero residual, not a missing parent height. Mixed
    // children may still have real records; inherit absence only from all parents.
    s.nodes[index].procedural = true;
    s.result.reasons |= height_no_data;
  } else s.nodes[index].blocked = failure ? height_request_failed : height_no_data;
  s.remove(request); return true;
}
height_session_state height_session::state() const { return implementation_->status; }
const height_session_sample& height_session::sample() const { return implementation_->result; }
const height_session_region& height_session::region() const { return implementation_->region; }
const std::vector<height_session_request>& height_session::requests() const { return implementation_->pending; }
std::size_t height_session::payload_bytes() const { return implementation_->bytes(); }
std::size_t height_session::peak_bytes() const { return implementation_->peak; }
std::size_t height_session::maximum_bytes() const { return implementation_->maximum; }
}  // namespace frame
}  // namespace terra
