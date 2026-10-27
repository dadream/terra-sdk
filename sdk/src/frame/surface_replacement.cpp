#include <terra/frame/surface_replacement.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <set>
#include <tuple>

namespace terra {
namespace frame {
namespace {
struct line_key {
  std::int64_t dx, dy, intercept;
  bool operator<(const line_key& other) const {
    return std::tie(dx, dy, intercept) < std::tie(other.dx, other.dy, other.intercept);
  }
};
struct edge {
  std::uint32_t node, next, slot, end;
  int direction;
  std::int64_t lo, hi;
  // Cyclic input already stores the next endpoint as the next edge's start.
  // Keep it once, in perimeter order; direction selects the low/high endpoint.
  core::vector3d a;
};
// Edges dominate the temporary workspace. Keep indexed access without a
// whole-cut contiguous allocation competing with long-lived mesh buffers.
// Pages belong to this task, are created as input arrives, and die with it.
class edge_storage {
  static constexpr std::size_t page_size = 1024U;
  std::size_t capacity_ = 0U, size_ = 0U;
  std::vector<std::unique_ptr<edge[]>> pages_;
public:
  void reserve(std::size_t capacity) {
    capacity_ = capacity;
    pages_.reserve(capacity / page_size + (capacity % page_size != 0U));
  }
  std::size_t size() const { return size_; }
  edge& operator[](std::size_t index) { return pages_[index / page_size][index % page_size]; }
  const edge& operator[](std::size_t index) const { return pages_[index / page_size][index % page_size]; }
  void push_back(const edge& value) {
    if (size_ % page_size == 0U) {
      const auto remaining = capacity_ - size_;
      pages_.emplace_back(new edge[remaining < page_size ? remaining : page_size]);
    }
    (*this)[size_++] = value;
  }
};
struct event {
  std::uint32_t edge_id = 0U;
  bool start = false;
};
struct line_edges {
  std::uint32_t head = UINT32_MAX, count = 0U;
};
struct node {
  std::uint32_t id = 0U, parent = 0U, group = UINT32_MAX;
  std::uint8_t rank = 0U;
  std::uint8_t sides = 0U;
};
std::int64_t gcd(std::int64_t a, std::int64_t b) {
  while (b) { const auto next = a % b; a = b; b = next; }
  return a;
}
}

struct surface_replacement_plan::implementation {
  std::size_t maximum_surfaces, maximum_inputs, maximum_points, maximum_line_edges = 0U;
  bool global, valid = true, begun = false, complete = false;
  std::vector<node> nodes;
  edge_storage edges;
  std::map<line_key, line_edges> lines;
  std::map<line_key, line_edges>::iterator line;
  std::vector<event> events;
  std::vector<std::uint32_t> active;
  std::vector<replacement_member> output;
  enum class phase { prepare, events, compare, join, groups };
  phase stage = phase::prepare;
  std::uint32_t preparing_edge = UINT32_MAX, group_count = 0U;
  std::size_t cursor = 0U, last_step_operations = 0U;
  std::size_t member_count = 0U;
  bool retained_after = false;
  std::int64_t position = 0;
  struct direction_state {
    std::uint32_t first = UINT32_MAX, old_edge = 0U, next_edge = 0U;
    std::size_t old_count = 0U, next_count = 0U;
  };
  direction_state directions[2];

  implementation(std::size_t surfaces, std::size_t points, bool globe, std::size_t retained)
      : maximum_surfaces(surfaces), maximum_inputs(surfaces), maximum_points(points), global(globe) {
    if (surface_replacement_plan::payload_bound(surfaces, points, retained) == std::numeric_limits<std::size_t>::max()) {
      valid = false; maximum_surfaces = maximum_inputs = maximum_points = 0U; return;
    }
    maximum_inputs -= retained;
    nodes.reserve(maximum_inputs); edges.reserve(maximum_inputs * points);
    output.reserve(surfaces);
  }
  std::int64_t coordinate(const event& value) const {
    const auto& segment = edges[value.edge_id];
    return value.start ? segment.lo : segment.hi;
  }
  auto later() const {
    return [this](const event& a, const event& b) {
      return coordinate(a) > coordinate(b);
    };
  }
  void enqueue(event value) {
    events.push_back(value);
    std::push_heap(events.begin(), events.end(), later());
  }
  event dequeue() {
    std::pop_heap(events.begin(), events.end(), later());
    const auto value = events.back(); events.pop_back(); return value;
  }
  std::uint32_t root(std::uint32_t id) {
    while (nodes[id].parent != id) {
      nodes[id].parent = nodes[nodes[id].parent].parent;
      id = nodes[id].parent;
    }
    return id;
  }
  void join(std::uint32_t first, std::uint32_t second) {
    first = root(first); second = root(second);
    if (first == second) return;
    if (nodes[first].rank < nodes[second].rank) std::swap(first, second);
    nodes[second].parent = first;
    if (nodes[first].rank == nodes[second].rank) ++nodes[first].rank;
  }
  bool compatible(std::int64_t lo, std::int64_t hi) const {
    const auto at = [this](const edge& value, std::int64_t t, std::size_t axis) {
      const auto a = (value.direction > 0 ? value.a : edges[value.end].a)[axis];
      const auto b = (value.direction > 0 ? edges[value.end].a : value.a)[axis];
      return a + (b - a) *
          static_cast<double>(t - value.lo) / static_cast<double>(value.hi - value.lo);
    };
    for (const auto& direction : directions) {
      if (direction.first == UINT32_MAX) continue;
      if (direction.old_count != 1U || direction.next_count != 1U) return false;
      for (const auto t : {lo, hi}) for (std::size_t axis = 0U; axis < 3U; ++axis)
        if (std::abs(at(edges[direction.old_edge], t, axis) -
            at(edges[direction.next_edge], t, axis)) > 1e-6) return false;
    }
    return true;
  }
  // Each call handles one edge, endpoint, active-edge comparison/join, output
  // member, or constant-size transition. Equal-coordinate endpoints may pause,
  // but an interval is compared only after all its endpoint changes are applied.
  void advance() {
    switch (stage) {
      case phase::prepare:
        if (preparing_edge != UINT32_MAX) {
          const auto id = preparing_edge; const auto& value = edges[id];
          enqueue({id, true}); enqueue({id, false});
          preparing_edge = value.next;
        } else {
          stage = phase::events;
          if (!events.empty()) position = coordinate(events.front());
        }
        break;
      case phase::events:
        if (events.empty()) {
          ++line;
          if (line == lines.end()) { stage = phase::groups; cursor = 0U; }
          else { stage = phase::prepare; preparing_edge = line->second.head; }
        } else if (coordinate(events.front()) == position) {
          const auto change = dequeue();
          auto& value = edges[change.edge_id];
          if (change.start) {
            value.slot = static_cast<std::uint32_t>(active.size());
            active.push_back(change.edge_id);
          } else {
            active[value.slot] = active.back();
            edges[active.back()].slot = value.slot;
            active.pop_back();
          }
        } else {
          directions[0] = direction_state(); directions[1] = direction_state();
          cursor = 0U; stage = phase::compare;
        }
        break;
      case phase::compare:
        if (cursor < active.size()) {
          const auto id = active[cursor++]; const auto& value = edges[id];
          auto& direction = directions[value.direction > 0 ? 1 : 0];
          if (direction.first == UINT32_MAX) direction.first = value.node;
          else join(direction.first, value.node);
          if (nodes[value.node].sides & 1U) { direction.old_edge = id; ++direction.old_count; }
          if (nodes[value.node].sides & 2U) { direction.next_edge = id; ++direction.next_count; }
        } else {
          stage = compatible(position, coordinate(events.front())) ? phase::events : phase::join;
          position = coordinate(events.front()); cursor = 0U;
        }
        break;
      case phase::join:
        if (cursor < active.size()) join(edges[active.front()].node, edges[active[cursor++]].node);
        else stage = phase::events;
        break;
      case phase::groups:
        if (cursor < nodes.size()) {
          const auto parent = root(static_cast<std::uint32_t>(cursor));
          if (nodes[parent].group == UINT32_MAX) nodes[parent].group = group_count++;
          const auto& value = nodes[cursor];
          output.push_back({nodes[parent].group, value.sides == 2U || retained_after ? 1U : 0U, value.id});
          if (value.sides == 3U && !retained_after) retained_after = true;
          else { retained_after = false; ++cursor; }
        } else complete = true;
        break;
    }
  }
};

std::size_t surface_replacement_plan::payload_bound(std::size_t surfaces, std::size_t points,
                                                   std::size_t retained) {
  // Includes worst-case explicit array capacity, per-line map payload/headroom,
  // output grouping and one boundary's generation/sort scratch. Allocator and
  // container bookkeeping are conservative allowances, not process RSS.
  // Sweep arrays actually reserve only the largest line after input is sealed;
  // this pre-input credit conservatively allows every edge on that line.
  // One byte per edge also covers the page index (one pointer per 1024 edges);
  // the fixed headroom covers a partial page's pointer. Edge pages never pad
  // beyond the admitted input capacity.
  constexpr std::size_t per_edge = sizeof(edge) + 2U * sizeof(event) + sizeof(std::uint32_t) + 1U;
  constexpr std::size_t per_surface = sizeof(node) + sizeof(replacement_member) + 64U + 3U * 128U;
  const auto limit = std::numeric_limits<std::size_t>::max();
  if (retained > surfaces / 2U || points < 3U || points > UINT32_MAX || surfaces > UINT32_MAX / points ||
      points > (limit - per_surface) / per_edge || points > (limit - 4096U) / 80U ||
      surfaces > (limit - points * 80U - 4096U) / (points * per_edge + per_surface)) return limit;
  return (surfaces - retained) * points * per_edge + surfaces * per_surface + points * 80U + 4096U;
}

surface_replacement_plan::surface_replacement_plan(std::size_t surfaces, std::size_t points, bool global,
                                                   std::size_t retained)
    : impl_(new implementation(surfaces, points, global, retained)) {}
surface_replacement_plan::~surface_replacement_plan() = default;

bool surface_replacement_plan::add(std::uint32_t id, bool after, std::vector<replacement_point> points) {
  return add_sides(id, after ? 2U : 1U, std::move(points));
}

bool surface_replacement_plan::retain(std::uint32_t id, std::vector<replacement_point> points) {
  return add_sides(id, 3U, std::move(points));
}

bool surface_replacement_plan::add_sides(std::uint32_t id, std::uint8_t sides,
                                       std::vector<replacement_point> points) {
  auto& state = *impl_;
  const std::size_t members = sides == 3U ? 2U : 1U;
  if (!state.valid || state.begun || !id || state.nodes.size() >= state.maximum_inputs ||
      members > state.maximum_surfaces - state.member_count ||
      points.size() < 3U || points.size() > state.maximum_points) return state.valid = false;
  constexpr std::int64_t maximum_coordinate = std::int64_t(4) << 28;
  for (const auto& point : points) {
    if (point.u < 0 || point.v < 0 || point.u > maximum_coordinate || point.v > maximum_coordinate ||
        !std::all_of(point.world.begin(), point.world.end(), [](double v) {return std::isfinite(v);}))
      return state.valid = false;
  }
  // CBDAM supplies its three edges in perimeter order. Normalize winding from
  // local differences, preserving exact tiny triangles at large grid offsets.
  double orientation = 0.0;
  for (std::size_t i = 1U; i + 1U < points.size(); ++i) {
    const auto& a = points[i]; const auto& b = points[i + 1U]; const auto& o = points[0];
    orientation += static_cast<double>(a.u - o.u) * (b.v - o.v) -
        static_cast<double>(a.v - o.v) * (b.u - o.u);
  }
  if (orientation == 0.0) return state.valid = false;
  if (orientation < 0.0) std::reverse(points.begin(), points.end());
  const auto index = static_cast<std::uint32_t>(state.nodes.size());
  const auto first_edge = static_cast<std::uint32_t>(state.edges.size());
  state.nodes.push_back({id, index, UINT32_MAX, 0U, sides});
  state.member_count += members;
  for (std::size_t i = 0U; i < points.size(); ++i) {
    const auto& a = points[i]; const auto& b = points[(i + 1U) % points.size()];
    auto dx = b.u - a.u, dy = b.v - a.v;
    const auto divisor = gcd(std::abs(dx), std::abs(dy));
    if (!divisor) return state.valid = false;
    const auto direction = dx > 0 || (dx == 0 && dy > 0) ? 1 : -1;
    dx /= divisor * direction; dy /= divisor * direction;
    auto intercept = dx * a.v - dy * a.u;
    // Match the unified cylindrical model's two copies of the longitude seam.
    if (state.global && dx == 0 && a.u == maximum_coordinate) intercept = 0;
    constexpr std::int64_t exact_limit = std::int64_t(1) << 53;
    if (intercept < -exact_limit || intercept > exact_limit) return state.valid = false;
    const line_key key{dx, dy, intercept};
    auto found = state.lines.find(key);
    if (found == state.lines.end()) {
      if (state.lines.size() >= state.maximum_inputs * 3U) return state.valid = false;
      found = state.lines.emplace(key, line_edges()).first;
    }
    const auto& lo = direction > 0 ? a : b;
    const auto& hi = direction > 0 ? b : a;
    edge value{};
    value.node = index; value.next = found->second.head; value.direction = direction;
    value.lo = dx ? lo.u : lo.v; value.hi = dx ? hi.u : hi.v; value.a = a.world;
    value.end = first_edge + static_cast<std::uint32_t>((i + 1U) % points.size());
    found->second.head = static_cast<std::uint32_t>(state.edges.size());
    ++found->second.count;
    state.maximum_line_edges = std::max(state.maximum_line_edges, std::size_t(found->second.count));
    state.edges.push_back(value);
  }
  return true;
}

bool surface_replacement_plan::step(std::size_t maximum_operations) {
  auto& state = *impl_;
  state.last_step_operations = 0U;
  if (!state.valid || state.complete) return true;
  if (!maximum_operations) return false;
  if (!state.begun) {
    state.events.reserve(state.maximum_line_edges * 2U);
    state.active.reserve(state.maximum_line_edges);
    state.begun = true; state.line = state.lines.begin();
    if (state.line == state.lines.end()) state.stage = implementation::phase::groups;
    else state.preparing_edge = state.line->second.head;
  }
  while (!state.complete && state.last_step_operations < maximum_operations) {
    state.advance(); ++state.last_step_operations;
  }
  return state.complete;
}
std::size_t surface_replacement_plan::last_step_operations() const {return impl_->last_step_operations;}
bool surface_replacement_plan::valid() const {return impl_->valid;}
const std::vector<replacement_member>& surface_replacement_plan::members() const {
  static const std::vector<replacement_member> empty;
  return impl_->complete ? impl_->output : empty;
}
std::vector<replacement_member> surface_replacement_plan::take_members() {
  return impl_->complete ? std::move(impl_->output) : std::vector<replacement_member>();
}

bool surface_replacement_plan::rebase(const std::vector<replacement_member>& proof,
    const std::vector<std::uint32_t>& submitted, std::vector<replacement_member>& rebased) {
  std::uint32_t groups = 0U, next = 0U;
  for (const auto& member : proof) {
    if (member.group >= proof.size() || member.after > 1U || !member.resource_id) return false;
    groups = std::max(groups, member.group + 1U);
  }
  std::vector<std::set<std::uint32_t>> before(groups), after(groups);
  std::map<std::uint32_t, std::uint32_t> membership;
  for (const auto& member : proof) {
    const auto entry = membership.emplace(member.resource_id, member.group);
    if (entry.first->second != member.group ||
        !(member.after ? after : before)[member.group].insert(member.resource_id).second) return false;
  }
  const std::set<std::uint32_t> displayed(submitted.begin(), submitted.end());
  if (displayed.size() != submitted.size() || displayed.count(0U)) return false;
  auto remaining = displayed;
  std::vector<replacement_member> result;
  for (std::uint32_t group = 0U; group < groups; ++group) {
    std::set<std::uint32_t> current;
    for (const auto* side : {&before[group], &after[group]})
      for (const auto id : *side) if (displayed.count(id)) current.insert(id);
    if (current == after[group]) {
      for (const auto id : current) {
        result.push_back({next, 0U, id}); result.push_back({next++, 1U, id});
      }
    } else if (current == before[group]) {
      for (const auto id : current) result.push_back({next, 0U, id});
      for (const auto id : after[group]) result.push_back({next, 1U, id});
      ++next;
    } else return false;
    for (const auto id : current) remaining.erase(id);
  }
  if (!remaining.empty()) return false;
  rebased = std::move(result);
  return true;
}

}  // namespace frame
}  // namespace terra
