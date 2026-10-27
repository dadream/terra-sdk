#include <terra/frame/lod.hpp>

#include <terra/core/coordinate_transform.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <utility>

#if defined(__EMSCRIPTEN__)
extern "C" double terra_monotonic_milliseconds();
#endif

namespace terra {
namespace frame {
namespace {

using vector3 = core::vector3d;

vector3 add(const vector3& left, const vector3& right) {
  return {{left[0] + right[0], left[1] + right[1], left[2] + right[2]}};
}

vector3 subtract(const vector3& left, const vector3& right) {
  return {{left[0] - right[0], left[1] - right[1], left[2] - right[2]}};
}

vector3 scale(const vector3& value, double factor) {
  return {{value[0] * factor, value[1] * factor, value[2] * factor}};
}

double dot(const vector3& left, const vector3& right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

vector3 cross(const vector3& left, const vector3& right) {
  return {{left[1] * right[2] - left[2] * right[1],
           left[2] * right[0] - left[0] * right[2],
           left[0] * right[1] - left[1] * right[0]}};
}

double length(const vector3& value) {
  return std::sqrt(dot(value, value));
}

vector3 normalized(const vector3& value) {
  const double value_length = length(value);
  return value_length == 0.0 ? vector3{{0.0, 0.0, 0.0}}
                             : scale(value, 1.0 / value_length);
}

std::uint64_t morton_chunk(const core::grid_point& point, bool high) {
  const std::uint32_t offset =
      static_cast<std::uint32_t>(-core::grid_coordinate_min);
  const std::uint32_t mask = (std::uint32_t(1) << 16U) - 1U;
  const std::uint32_t values[] = {
      offset + static_cast<std::uint32_t>(point[0]),
      offset + static_cast<std::uint32_t>(point[1]),
      offset + static_cast<std::uint32_t>(point[2])};
  std::uint64_t result = 0U;
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    const std::uint32_t value = high ? values[axis] >> 16U
                                     : values[axis] & mask;
    for (std::uint32_t bit = 0U; bit < 21U; ++bit) {
      const std::uint64_t encoded_bit =
          ((value >> bit) & 1U) == 0U ? 1U : 0U;
      result |= encoded_bit << (3U * bit + axis);
    }
  }
  return result;
}

struct morton_less {
  bool operator()(const core::grid_point& left,
                  const core::grid_point& right) const {
    const std::uint64_t left_high = morton_chunk(left, true);
    const std::uint64_t right_high = morton_chunk(right, true);
    if (left_high != right_high) {
      return left_high < right_high;
    }
    return morton_chunk(left, false) < morton_chunk(right, false);
  }
};

std::uint64_t priority_order_key(float priority, float threshold) {
  if (!std::isfinite(priority) || priority <= 0.0F) {
    return 0U;
  }
  const double unit = std::max(std::fabs(static_cast<double>(threshold)),
                               1.0e-12);
  const double scaled =
      static_cast<double>(priority) * 4096.0 / unit;
  const double maximum =
      static_cast<double>(std::numeric_limits<std::uint64_t>::max());
  if (scaled >= maximum) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return static_cast<std::uint64_t>(scaled + 0.5);
}

struct oriented_box {
  vector3 center{{0.0, 0.0, 0.0}};
  std::array<vector3, 3> axes{{vector3{{1.0, 0.0, 0.0}},
                               vector3{{0.0, 1.0, 0.0}},
                               vector3{{0.0, 0.0, 1.0}}}};
  vector3 half_side{{0.0, 0.0, 0.0}};
};

bool valid_fragment(const core::grid_diamond& diamond, std::size_t fragment) {
  const core::grid_point& point = diamond.corner(2U * fragment + 1U);
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    if (point[axis] < core::grid_coordinate_min ||
        point[axis] > core::grid_coordinate_max) {
      return false;
    }
  }
  return true;
}

std::size_t fragment_from_parent(const core::grid_diamond& diamond,
                                 const core::grid_point& parent) {
  return diamond.corner(1U) == parent ? 0U : 1U;
}

core::vector3d uvh_from_grid(const core::grid_point& point) {
  const double grid_to_degrees =
      90.0 / static_cast<double>(core::grid_coordinate_max);
  const core::grid_value half_root = core::grid_coordinate_max / 2;
  double longitude_grid = 0.0;
  if (point[2] == half_root) {
    longitude_grid = -2.0 * core::grid_coordinate_max +
                     static_cast<double>(point[0] + half_root);
  } else if (point[0] == half_root) {
    longitude_grid = -1.0 * core::grid_coordinate_max +
                     static_cast<double>(-point[2] + half_root);
  } else if (point[2] == -half_root) {
    longitude_grid = static_cast<double>(-point[0] + half_root);
  } else if (point[0] == -half_root) {
    longitude_grid = core::grid_coordinate_max +
                     static_cast<double>(point[2] + half_root);
  }
  return {{longitude_grid * grid_to_degrees,
           static_cast<double>(point[1]) * grid_to_degrees, 0.0}};
}

vector3 xyz_from_grid(const core::coordinate_transform& transform,
                      const core::grid_point& point, double height = 0.0) {
  auto uvh = uvh_from_grid(point);
  uvh[2] = height;
  return transform.xyz_from_uvh(uvh);
}

oriented_box make_box(const core::grid_diamond& diamond,
                      const core::coordinate_transform& transform,
                      double minimum_height = 0.0, double maximum_height = 0.0) {
  const vector3 normal = transform.up_from_uvh(uvh_from_grid(diamond.id()));
  // The bound encloses the measured elevation interval. Including a sea-level
  // center here extrudes every elevated patch down to zero, inflating both
  // visibility and projected error even after its real heights are available.
  const vector3 center_point = xyz_from_grid(transform, diamond.id(), minimum_height);
  const vector3 p0 = xyz_from_grid(transform, diamond.corner(0U));
  const vector3 p1 = xyz_from_grid(
      transform, valid_fragment(diamond, 0U) ? diamond.corner(1U)
                                             : diamond.corner(3U));

  const vector3 direction = normalized(subtract(p1, p0));
  const vector3 x = normalized(subtract(direction, scale(normal, dot(normal, direction))));
  const vector3 z = normal;
  const vector3 y = scale(cross(x, z), -1.0);
  const std::array<vector3, 3> axes{{x, y, z}};
  const core::grid_point grid_points[] = {diamond.id(), diamond.corner(0U),
      valid_fragment(diamond, 0U) ? diamond.corner(1U) : diamond.corner(3U), diamond.corner(2U),
      valid_fragment(diamond, 1U) ? diamond.corner(3U) : diamond.corner(1U)};
  vector3 minimum{{dot(center_point, axes[0]), dot(center_point, axes[1]), dot(center_point, axes[2])}};
  vector3 maximum = minimum;
  for (const auto& grid_point : grid_points) {
    for (const double height : {minimum_height, maximum_height}) {
      const auto point = xyz_from_grid(transform, grid_point, height);
      for (std::size_t axis = 0U; axis < 3U; ++axis) {
        const double local = dot(point, axes[axis]);
        minimum[axis] = std::min(minimum[axis], local);
        maximum[axis] = std::max(maximum[axis], local);
      }
    }
  }

  oriented_box result;
  result.axes = axes;
  vector3 local_center{{0.0, 0.0, 0.0}};
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    result.half_side[axis] = 0.5 * (maximum[axis] - minimum[axis]);
    local_center[axis] = 0.5 * (maximum[axis] + minimum[axis]);
    result.center = add(result.center,
                        scale(result.axes[axis], local_center[axis]));
  }
  return result;
}

bool is_visible(const oriented_box& box,
                const std::array<plane4d, 6>& planes) {
  for (const plane4d& plane : planes) {
    const vector3 normal{{plane[0], plane[1], plane[2]}};
    double far_distance = dot(normal, box.center) + plane[3];
    for (std::size_t axis = 0U; axis < 3U; ++axis) {
      far_distance += std::fabs(dot(normal, box.axes[axis])) *
                      box.half_side[axis];
    }
    if (far_distance <= 0.0) {
      return false;
    }
  }
  return true;
}

double distance_to(const oriented_box& box, const vector3& point) {
  const vector3 relative = subtract(point, box.center);
  double squared_distance = 0.0;
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    const double local = dot(relative, box.axes[axis]);
    if (local < -box.half_side[axis]) {
      const double delta = local + box.half_side[axis];
      squared_distance += delta * delta;
    } else if (local > box.half_side[axis]) {
      const double delta = local - box.half_side[axis];
      squared_distance += delta * delta;
    }
  }
  return std::sqrt(squared_distance);
}

double projected_area(const oriented_box& box, const vector3& direction) {
  double area = 0.0;
  for (std::size_t axis = 0U; axis < 3U; ++axis) {
    const std::size_t side0 = (axis + 1U) % 3U;
    const std::size_t side1 = (axis + 2U) % 3U;
    const double side_area = 4.0 * box.half_side[side0] * box.half_side[side1];
    area += std::fabs(dot(direction, box.axes[axis])) * side_area;
  }
  return area;
}

struct node {
  core::grid_diamond diamond;
  bool leaf = true;
  bool blocked = false;
  std::array<bool, 2> has_fragment{{false, false}};
  oriented_box bounds;
  double minimum_height = 0.0;
  double maximum_height = 0.0;
  // 0..7 are certified shared UV patterns; 8 is an independent allocation.
  std::array<std::uint8_t, 2> texture_patterns{{8U, 8U}};
  std::uint8_t accounted_fragment_mask = 0U;
  bool accounted_split = false;
};

using level_map = std::map<core::grid_point, node, morton_less>;

struct mesh_cut_cost {
  std::size_t fragments = 0U;
  std::array<std::size_t, 9> coordinates{{}};

  void add(std::uint8_t pattern) { ++fragments; ++coordinates[pattern]; }
  void remove(std::uint8_t pattern) { --fragments; --coordinates[pattern]; }
  std::size_t bytes(std::uint32_t dimension) const {
    std::size_t unique_coordinates = coordinates[8U];
    for (std::size_t i = 0U; i < 8U; ++i) unique_coordinates += coordinates[i] ? 1U : 0U;
    const std::size_t vertices = (std::size_t(dimension) + 1U) * (dimension + 2U) / 2U;
    return vertices * sizeof(float) * (3U * fragments + 2U * unique_coordinates);
  }
};

struct selection_context {
  core::coordinate_transform transform;
  std::uint32_t patch_dimension;
  const camera_snapshot& camera;
  std::size_t maximum_level;
  std::size_t maximum_node_count;
  std::size_t node_count;
  std::vector<level_map> levels;
  const std::vector<lod_detail_key>& unavailable_details;

  selection_context(double radius, std::uint32_t patch_dimension_value,
                    const camera_snapshot& camera_value,
                    std::size_t maximum_level_value,
                    std::size_t maximum_node_count_value,
                    const std::vector<lod_detail_key>& unavailable)
      : transform(core::coordinate_transform::cylindrical(radius)),
        patch_dimension(patch_dimension_value),
        camera(camera_value),
        maximum_level(maximum_level_value),
        maximum_node_count(maximum_node_count_value),
        node_count(0U),
        levels(1U),
        unavailable_details(unavailable) {}
};

lod_patch priority(std::size_t level, const node& value,
                   const selection_context& context) {
  lod_patch result;
  result.level = level;
  result.id = value.diamond.id();
  for (std::size_t corner = 0U; corner < result.corners.size(); ++corner) {
    result.corners[corner] = value.diamond.corner(corner);
  }
  for (std::size_t fragment = 0U; fragment < value.has_fragment.size();
       ++fragment) {
    if (value.has_fragment[fragment]) {
      result.fragment_mask |= std::uint8_t(1U) << fragment;
    }
  }
  result.visible = is_visible(value.bounds, context.camera.clip_planes);
  if (!result.visible || level >= context.maximum_level) {
    return result;
  }
  const double distance = distance_to(value.bounds, context.camera.position);
  if (distance == 0.0) {
    result.priority = static_cast<float>(std::uint32_t(1) << 30U);
    return result;
  }
  const vector3 direction = normalized(
      subtract(value.bounds.center, context.camera.position));
  result.priority = static_cast<float>(
      std::sqrt(projected_area(value.bounds, direction)) /
      (static_cast<double>(context.patch_dimension) * distance));
  return result;
}

bool detail_is_unavailable(const selection_context& context,
                           std::size_t level,
                           const core::grid_point& id) {
  return std::any_of(
      context.unavailable_details.begin(),
      context.unavailable_details.end(),
      [level, &id](const lod_detail_key& key) {
        return key.level == level && key.id == id;
      });
}

bool refine(selection_context& context, std::size_t level,
            const core::grid_point& id,
            std::vector<std::pair<std::size_t, core::grid_point>>* affected = nullptr) {
  if (level >= context.maximum_level || level >= context.levels.size() ||
      context.node_count + 4U > context.maximum_node_count) {
    return false;
  }
  level_map::iterator current = context.levels[level].find(id);
  if (current == context.levels[level].end() || !current->second.leaf) {
    return false;
  }

  if (detail_is_unavailable(context, level, id)) {
    return false;
  }

  if (level > 0U) {
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      current = context.levels[level].find(id);
      if (!current->second.has_fragment[fragment] &&
          valid_fragment(current->second.diamond, fragment)) {
        const core::grid_point parent =
            current->second.diamond.parent_id(fragment);
        refine(context, level - 1U, parent, affected);
      }
    }
  }

  current = context.levels[level].find(id);
  for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!current->second.has_fragment[fragment] &&
        valid_fragment(current->second.diamond, fragment)) {
      return false;
    }
  }
  if (context.node_count + 4U > context.maximum_node_count) {
    return false;
  }
  const core::grid_diamond parent_diamond = current->second.diamond;
  const std::array<bool, 2> parent_fragments = current->second.has_fragment;
  current->second.leaf = false;
  if (affected) affected->emplace_back(level, id);
  if (context.levels.size() == level + 1U) {
    context.levels.push_back(level_map());
  }

  for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!parent_fragments[fragment]) {
      continue;
    }
    for (std::size_t child_index = 0U; child_index < 2U; ++child_index) {
      const core::grid_diamond child =
          parent_diamond.cylindrical_child_diamond(fragment, child_index);
      const core::grid_point child_id = child.id();
      const std::size_t child_fragment =
          fragment_from_parent(child, parent_diamond.id());
      std::pair<level_map::iterator, bool> inserted =
          context.levels[level + 1U].emplace(child_id, node());
      if (inserted.second) {
        ++context.node_count;
        inserted.first->second.diamond = child;
        inserted.first->second.minimum_height = current->second.minimum_height;
        inserted.first->second.maximum_height = current->second.maximum_height;
        inserted.first->second.bounds = make_box(child, context.transform, current->second.minimum_height, current->second.maximum_height);
      }
      inserted.first->second.has_fragment[child_fragment] = true;
      if (affected) affected->emplace_back(level + 1U, child_id);
    }
  }
  return true;
}

lod_patch fixed_patch(std::size_t level, const node& value) {
  lod_patch result;
  result.level = level;
  result.id = value.diamond.id();
  result.visible = true;
  for (std::size_t corner = 0U; corner < result.corners.size(); ++corner) {
    result.corners[corner] = value.diamond.corner(corner);
  }
  for (std::size_t fragment = 0U; fragment < value.has_fragment.size();
       ++fragment) {
    if (value.has_fragment[fragment]) {
      result.fragment_mask |= std::uint8_t(1U) << fragment;
    }
  }
  return result;
}

bool refine_planar(std::vector<level_map>& levels, std::size_t& node_count,
                   std::size_t maximum_node_count, std::size_t level,
                   const core::grid_point& id) {
  if (level >= levels.size() || node_count + 4U > maximum_node_count) {
    return false;
  }
  level_map::iterator current = levels[level].find(id);
  if (current == levels[level].end() || !current->second.leaf) {
    return false;
  }
  if (level > 0U) {
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      current = levels[level].find(id);
      if (!current->second.has_fragment[fragment] &&
          valid_fragment(current->second.diamond, fragment)) {
        const core::grid_point parent =
            current->second.diamond.parent_id(fragment);
        static_cast<void>(refine_planar(
            levels, node_count, maximum_node_count, level - 1U, parent));
      }
    }
  }
  current = levels[level].find(id);
  for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!current->second.has_fragment[fragment] &&
        valid_fragment(current->second.diamond, fragment)) {
      return false;
    }
  }
  if (node_count + 4U > maximum_node_count) {
    return false;
  }
  const core::grid_diamond parent_diamond = current->second.diamond;
  const std::array<bool, 2> parent_fragments = current->second.has_fragment;
  current->second.leaf = false;
  if (levels.size() == level + 1U) {
    levels.push_back(level_map());
  }
  for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
    if (!parent_fragments[fragment]) {
      continue;
    }
    for (std::size_t child_index = 0U; child_index < 2U; ++child_index) {
      const core::grid_diamond child =
          parent_diamond.planar_child_diamond(fragment, child_index);
      const core::grid_point child_id = child.id();
      const std::size_t child_fragment =
          fragment_from_parent(child, parent_diamond.id());
      std::pair<level_map::iterator, bool> inserted =
          levels[level + 1U].emplace(child_id, node());
      if (inserted.second) {
        ++node_count;
        inserted.first->second.diamond = child;
      }
      inserted.first->second.has_fragment[child_fragment] = true;
    }
  }
  return true;
}

}  // namespace

struct cylindrical_lod_controller::implementation {
  enum class refinement_readiness {
    ready,
    waiting,
    unavailable,
    inconsistent
  };

  using record_request_key =
      std::pair<lod_record_kind,
                std::pair<std::size_t, core::grid_point>>;
  using record_request_index = std::map<record_request_key, std::size_t>;
  using resource_key = std::pair<std::size_t, core::grid_point>;

  struct candidate {
    std::size_t level = 0U;
    core::grid_point id{{0, 0, 0}};
    std::uint64_t error_order = 0U;
  };

  struct refine_less {
    bool operator()(const candidate& left, const candidate& right) const {
      if (left.error_order != right.error_order) {
        return left.error_order > right.error_order;
      }
      if (left.level != right.level) {
        return left.level < right.level;
      }
      return morton_less()(left.id, right.id);
    }
  };

  struct coarsen_less {
    bool operator()(const candidate& left, const candidate& right) const {
      if (left.level != right.level) {
        return left.level > right.level;
      }
      if (left.error_order != right.error_order) {
        return left.error_order < right.error_order;
      }
      return morton_less()(left.id, right.id);
    }
  };

  struct step_clock {
    double started = 0.0;
    double maximum_milliseconds = 0.0;

    static double now() {
#if defined(__EMSCRIPTEN__)
      return terra_monotonic_milliseconds();
#else
      return std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
    }

    explicit step_clock(double maximum) : maximum_milliseconds(maximum) {
      if (maximum_milliseconds > 0.0) started = now();
    }

    bool expired() const {
      return maximum_milliseconds > 0.0 &&
          now() - started >= maximum_milliseconds;
    }
  };

  struct resource_index {
    std::set<resource_key> available_roots;
    std::set<resource_key> available_details;
    std::set<resource_key> unavailable_details;
    std::vector<lod_height_range> height_ranges;

    resource_index() = default;

    explicit resource_index(const lod_resource_state& resources) {
      for (const lod_detail_key& key : resources.available_roots) {
        available_roots.emplace(key.level, key.id);
      }
      for (const lod_detail_key& key : resources.available_details) {
        available_details.emplace(key.level, key.id);
      }
      for (const lod_detail_key& key : resources.unavailable_details) {
        unavailable_details.emplace(key.level, key.id);
      }
      for (const auto& range : resources.height_ranges) {
        if (std::isfinite(range.minimum) && std::isfinite(range.maximum) && range.minimum <= range.maximum) height_ranges.push_back(range);
      }
      std::sort(height_ranges.begin(), height_ranges.end(), [](const lod_height_range& a, const lod_height_range& b) {
        return a.key.level != b.key.level ? a.key.level < b.key.level : a.key.id < b.key.id;
      });
    }

    const lod_height_range* height_range(const resource_key& key) const {
      const auto found = std::lower_bound(height_ranges.begin(), height_ranges.end(), key,
          [](const lod_height_range& range, const resource_key& value) {
            return range.key.level != value.first ? range.key.level < value.first : range.key.id < value.second;
          });
      return found != height_ranges.end() && found->key.level == key.first && found->key.id == key.second ? &*found : nullptr;
    }

    bool detail_available(std::size_t level,
                          const core::grid_point& id) const {
      return available_details.count(resource_key(level, id)) != 0U;
    }

    bool detail_unavailable(std::size_t level,
                            const core::grid_point& id) const {
      return unavailable_details.count(resource_key(level, id)) != 0U;
    }

    bool root_available(const core::grid_point& id) const {
      return available_roots.count(resource_key(0U, id)) != 0U;
    }
  };

  double radius = 0.0;
  std::uint32_t patch_dimension = 0U;
  std::size_t maximum_level = 0U;
  std::size_t maximum_node_count = 0U;
  std::size_t admission_node_count = 0U;
  std::size_t visible_mesh_capacity = 0U;
  std::size_t split_capacity = 0U;
  mesh_cut_cost visible_mesh_cost;
  std::size_t admitted_splits = 0U;
  bool admission_limited = false;
  bool coarsening_only = false;
  std::size_t node_count = 0U;
  std::vector<level_map> levels;
  std::map<resource_key, lod_patch> evaluated_patches;
  std::set<candidate, refine_less> desired_refinements;
  std::set<candidate, refine_less> ready_refinements;
  std::set<candidate, coarsen_less> ready_coarsenings;
  // Capacity reclamation orders complete sibling closures by error rather
  // than the level-first order used by normal threshold coarsening.
  std::set<candidate, refine_less> reclaimable_coarsenings;
  std::set<resource_key> dirty_nodes;
  // A split is protected on behalf of an unfinished requesting diamond, not
  // forever for this camera. Completed requests release their dependency pins.
  std::map<resource_key, resource_key> refinement_protected;
  // Coarsening is one side of a capacity exchange. Do not immediately refine
  // its victims again before the requesting split has consumed the freed room.
  std::map<resource_key, resource_key> coarsening_requests;
  bool reclaim_cursor_valid = false;
  resource_key reclaim_goal;
  candidate reclaim_after;
  resource_index indexed_resources;
  bool resources_initialized = false;
  std::uint64_t resource_revision = 0U;
  std::uint64_t height_revision = 0U;
  camera_snapshot evaluated_camera;
  float evaluated_threshold = 0.0F;
  bool view_initialized = false;
  bool scanning_priorities = false;
  std::size_t scan_level = 0U;
  std::size_t scan_remaining = 0U;
  level_map::const_iterator scan_position;
  lod_cut published_cut;
  std::size_t published_request_frontier_count = 0U;
  bool unpublished_topology = false;

  bool configured() const {
    return std::isfinite(radius) && radius > 0.0 &&
           patch_dimension > 0U && maximum_level > 0U &&
           maximum_node_count >= 8U && !levels.empty();
  }

  void reset() {
    coarsening_only = false;
    radius = 0.0;
    patch_dimension = 0U;
    maximum_level = 0U;
    maximum_node_count = 0U;
    node_count = 0U;
    levels.clear();
    evaluated_patches.clear();
    desired_refinements.clear();
    ready_refinements.clear();
    ready_coarsenings.clear();
    reclaimable_coarsenings.clear();
    visible_mesh_cost = mesh_cut_cost();
    admitted_splits = 0U;
    dirty_nodes.clear();
    refinement_protected.clear();
    coarsening_requests.clear();
    reclaim_cursor_valid = false;
    indexed_resources = resource_index();
    resources_initialized = false;
    resource_revision = 0U;
    height_revision = 0U;
    view_initialized = false;
    scanning_priorities = false;
    scan_level = 0U;
    scan_remaining = 0U;
    published_cut = lod_cut();
    published_request_frontier_count = 0U;
    unpublished_topology = false;
  }

  void initialize(double radius_value,
                  std::uint32_t patch_dimension_value,
                  std::size_t maximum_level_value,
                  std::size_t maximum_node_count_value) {
    reset();
    if (!std::isfinite(radius_value) || radius_value <= 0.0 ||
        patch_dimension_value == 0U || maximum_level_value == 0U ||
        maximum_node_count_value < 8U) {
      return;
    }
    radius = radius_value;
    patch_dimension = patch_dimension_value;
    maximum_level = std::min<std::size_t>(maximum_level_value, 40U);
    maximum_node_count = maximum_node_count_value;
    levels.push_back(level_map());
    const core::coordinate_transform transform =
        core::coordinate_transform::cylindrical(radius);
    const std::array<core::grid_diamond, 8> roots =
        core::cylindrical_roots();
    for (const core::grid_diamond& root : roots) {
      node root_node;
      root_node.diamond = root;
      root_node.has_fragment = {{true, true}};
      describe_texture_patterns(0U, root_node);
      // Root coverage survives every cut, including when its normal draw is
      // invisible or refined. A visible root aliases that same physical mesh.
      for (const auto pattern : root_node.texture_patterns) visible_mesh_cost.add(pattern);
      root_node.bounds = make_box(root, transform);
      levels[0U].emplace(root.id(), root_node);
      account_node(0U, levels[0U].at(root.id()), true);
      ++node_count;
      const lod_patch patch = fixed_patch(0U, root_node);
      published_cut.patches.push_back(patch);
      lod_record_request request;
      request.kind = lod_record_kind::root;
      request.patch = patch;
      published_cut.record_requests.push_back(request);
    }
    published_cut.complete = true;
    published_cut.graph_level_count = 1U;
    published_cut.leaf_count_by_level.push_back(8U);
  }

  static candidate make_candidate(const lod_patch& patch, float threshold) {
    candidate result;
    result.level = patch.level;
    result.id = patch.id;
    result.error_order = priority_order_key(patch.priority, threshold);
    return result;
  }

  candidate make_reclaim_candidate(const lod_patch& patch) const {
    auto result = make_candidate(patch, evaluated_threshold);
    result.error_order = ~result.error_order;
    return result;
  }

  void erase_candidates(const lod_patch& patch) {
    const candidate refine_key = make_candidate(patch, evaluated_threshold);
    desired_refinements.erase(refine_key);
    ready_refinements.erase(refine_key);
    ready_coarsenings.erase(make_candidate(patch, evaluated_threshold));
    reclaimable_coarsenings.erase(make_reclaim_candidate(patch));
  }

  void classify(const lod_patch& patch, const node& state) {
    if (state.leaf && patch.visible &&
        patch.priority > evaluated_threshold && patch.level < maximum_level) {
      const candidate key = make_candidate(patch, evaluated_threshold);
      desired_refinements.insert(key);
      if (!refinement_deferred({patch.level, patch.id}, {patch.level, patch.id}) &&
          !indexed_resources.detail_unavailable(patch.level, patch.id) &&
          (indexed_resources.detail_available(patch.level, patch.id) ||
           (patch.level > 0U && ((!state.has_fragment[0U] && valid_fragment(state.diamond, 0U)) ||
                               (!state.has_fragment[1U] && valid_fragment(state.diamond, 1U))))) &&
          (patch.level != 0U || indexed_resources.root_available(patch.id))) {
        ready_refinements.insert(key);
      }
    }
    if (!state.leaf && can_coarsen(patch.level, state)) {
      reclaimable_coarsenings.insert(make_reclaim_candidate(patch));
      // Selection has one requested error, like the desktop CBDAM cut. A
      // parent already meeting it must not retain optional finer children
      // forever after zooming out. Persistent queues, dependency protection
      // and bounded publication remain responsible for incremental updates;
      // the renderer owns the old surface until replacement is presented.
      if (patch.priority < evaluated_threshold &&
          protected_priority({patch.level, patch.id}) == 0.0F) {
        ready_coarsenings.insert(make_candidate(patch, evaluated_threshold));
      }
    }
  }

  void describe_texture_patterns(std::size_t level, node& state) const {
    auto patch = fixed_patch(level, state);
    patch.fragment_mask = 3U;
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      texture_grid_pattern pattern;
      state.texture_patterns[fragment] = describe_cylindrical_texture_pattern(
          patch, fragment, patch_dimension, pattern) ? static_cast<std::uint8_t>(pattern.orientation) : 8U;
    }
  }

  void account_node(std::size_t level, node& state, bool visible) {
    admitted_splits -= state.accounted_split ? 1U : 0U;
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      const auto bit = std::uint8_t(1U << fragment);
      if (state.accounted_fragment_mask & bit) visible_mesh_cost.remove(state.texture_patterns[fragment]);
      const bool charged = level > 0U && state.leaf && visible && state.has_fragment[fragment];
      if (charged) visible_mesh_cost.add(state.texture_patterns[fragment]);
      state.accounted_fragment_mask = charged ? state.accounted_fragment_mask | bit
          : state.accounted_fragment_mask & ~bit;
    }
    state.accounted_split = !state.leaf;
    admitted_splits += state.accounted_split ? 1U : 0U;
  }

  void account_mutation(std::size_t level, node& state) {
    const auto patch = evaluated_patches.find({level, state.diamond.id()});
    // New children reserve visible fragments until their bounded priority
    // work proves them invisible. Existing nodes retain their evaluated view.
    account_node(level, state, patch == evaluated_patches.end() || patch->second.visible);
  }

  void refresh_node(const resource_key& key, const selection_context& view) {
    reclaim_cursor_valid = false;
    const auto previous = evaluated_patches.find(key);
    if (previous != evaluated_patches.end()) {
      erase_candidates(previous->second);
    }
    if (key.first >= levels.size()) {
      evaluated_patches.erase(key);
      return;
    }
    const auto found = levels[key.first].find(key.second);
    if (found == levels[key.first].end()) {
      evaluated_patches.erase(key);
      return;
    }
    const lod_patch patch = priority(key.first, found->second, view);
    account_node(key.first, found->second, patch.visible);
    evaluated_patches[key] = patch;
    if (request_priority(key) == 0.0F) release_refinement_request(key);
    classify(patch, found->second);
  }

  void dirty_node_and_parents(std::size_t level, const core::grid_point& id) {
    dirty_nodes.emplace(level, id);
    if (level == 0U || level >= levels.size()) {
      return;
    }
    const auto found = levels[level].find(id);
    if (found == levels[level].end()) {
      return;
    }
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (valid_fragment(found->second.diamond, fragment)) {
        dirty_nodes.emplace(level - 1U,
                            found->second.diamond.parent_id(fragment));
      }
    }
  }

  bool same_view(float threshold, const camera_snapshot& camera) const {
    return view_initialized && threshold == evaluated_threshold &&
        camera.position == evaluated_camera.position &&
        camera.clip_planes == evaluated_camera.clip_planes;
  }

  void start_priority_scan(float threshold, const camera_snapshot& camera) {
    evaluated_threshold = threshold;
    evaluated_camera = camera;
    view_initialized = true;
    scanning_priorities = true;
    scan_level = 0U;
    scan_remaining = node_count;
    scan_position = levels[0U].begin();
    desired_refinements.clear();
    ready_refinements.clear();
    ready_coarsenings.clear();
    reclaimable_coarsenings.clear();
    // A full scan includes any mutations left by the previous step.
    dirty_nodes.clear();
    refinement_protected.clear();
    coarsening_requests.clear();
    reclaim_cursor_valid = false;
  }

  void synchronize_resources(const lod_resource_state& resources) {
    if (resources_initialized && resources.revision != 0U &&
        resources.revision == resource_revision && resources.height_revision == height_revision) {
      return;
    }
    reclaim_cursor_valid = false;
    resource_index next(resources);
    std::set<resource_key> changed;
    const auto collect_changed = [&changed](
        const std::set<resource_key>& previous,
        const std::set<resource_key>& current) {
      std::set_symmetric_difference(previous.begin(), previous.end(),
                                    current.begin(), current.end(),
                                    std::inserter(changed, changed.end()));
    };
    collect_changed(indexed_resources.available_roots, next.available_roots);
    collect_changed(indexed_resources.available_details, next.available_details);
    collect_changed(indexed_resources.unavailable_details,
                    next.unavailable_details);
    std::set<resource_key> height_changed;
    for (const auto& range : next.height_ranges) {
      const resource_key key(range.key.level, range.key.id);
      const auto* previous = indexed_resources.height_range(key);
      if (!previous || previous->minimum != range.minimum || previous->maximum != range.maximum) height_changed.insert(key);
    }
    indexed_resources = std::move(next);
    resources_initialized = true;
    resource_revision = resources.revision;
    height_revision = resources.height_revision;
    const auto transform = core::coordinate_transform::cylindrical(radius);
    // As in the desktop model, a diamond's error bounds describe its own
    // reconstructed samples. Descendant relief must not permanently enlarge
    // a coarse replacement's error and prevent it from being selected again.
    // Undecoded children still inherit the parent's local elevation interval.
    for (const auto& key : height_changed) {
      if (key.first >= levels.size()) continue;
      const auto found = levels[key.first].find(key.second);
      if (found == levels[key.first].end()) continue;
      node& value = found->second;
      const auto* measured = indexed_resources.height_range(key);
      if (measured != nullptr) {
        value.minimum_height = measured->minimum;
        value.maximum_height = measured->maximum;
      }
      value.bounds = make_box(value.diamond, transform, value.minimum_height, value.maximum_height);
      dirty_nodes.insert(key);
    }
    // Data arrival changes readiness, not projected error. Do not rescan the
    // model or invalidate mesh resources just because a record arrived.
    for (const resource_key& key : changed) {
      if (indexed_resources.detail_unavailable(key.first, key.second)) release_refinement_request(key);
      const auto cached = evaluated_patches.find(key);
      if (cached == evaluated_patches.end() || key.first >= levels.size()) {
        continue;
      }
      const auto state = levels[key.first].find(key.second);
      if (state != levels[key.first].end()) {
        erase_candidates(cached->second);
        classify(cached->second, state->second);
      }
    }
  }

  bool can_coarsen(std::size_t level, const node& parent) const {
    if (parent.leaf || level + 1U >= levels.size()) {
      return false;
    }
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!parent.has_fragment[fragment]) {
        continue;
      }
      for (std::size_t child_index = 0U; child_index < 2U;
           ++child_index) {
        const core::grid_diamond child =
            parent.diamond.cylindrical_child_diamond(fragment, child_index);
        const level_map::const_iterator found =
            levels[level + 1U].find(child.id());
        if (found == levels[level + 1U].end() ||
            !found->second.leaf) {
          return false;
        }
      }
    }
    return true;
  }

  float request_priority(const resource_key& request) const {
    if (request.first >= levels.size()) return 0.0F;
    const auto state = levels[request.first].find(request.second);
    const auto patch = evaluated_patches.find(request);
    return state != levels[request.first].end() && state->second.leaf &&
        patch != evaluated_patches.end() && patch->second.visible &&
        patch->second.priority > evaluated_threshold &&
        !indexed_resources.detail_unavailable(request.first, request.second)
        ? patch->second.priority : 0.0F;
  }

  float protected_priority(const resource_key& key) const {
    const auto guard = refinement_protected.find(key);
    return guard == refinement_protected.end() ? 0.0F : request_priority(guard->second);
  }

  bool refinement_deferred(const resource_key& key, const resource_key& request) const {
    const auto found = coarsening_requests.find(key);
    return found != coarsening_requests.end() && found->second != request &&
        request_priority(found->second) > 0.0F &&
        request_priority(found->second) >= request_priority(request);
  }

  void release_refinement_request(const resource_key& request) {
    for (auto it = refinement_protected.begin(); it != refinement_protected.end();) {
      if (it->second == request) {
        dirty_nodes.insert(it->first);
        it = refinement_protected.erase(it);
      } else ++it;
    }
    for (auto it = coarsening_requests.begin(); it != coarsening_requests.end();) {
      if (it->second == request) {
        dirty_nodes.insert(it->first);
        it = coarsening_requests.erase(it);
      } else ++it;
    }
  }

  bool coarsen(std::size_t level, const core::grid_point& id, bool capacity = false) {
    if (level >= levels.size() ||
        (!capacity && protected_priority({level, id}) > 0.0F)) {
      return false;
    }
    level_map::iterator parent = levels[level].find(id);
    if (parent == levels[level].end() ||
        !can_coarsen(level, parent->second)) {
      return false;
    }
    const core::grid_diamond parent_diamond = parent->second.diamond;
    const std::array<bool, 2> parent_fragments =
        parent->second.has_fragment;
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!parent_fragments[fragment]) {
        continue;
      }
      for (std::size_t child_index = 0U; child_index < 2U;
           ++child_index) {
        const core::grid_diamond child =
            parent_diamond.cylindrical_child_diamond(
                fragment, child_index);
        level_map::iterator found =
            levels[level + 1U].find(child.id());
        if (found == levels[level + 1U].end()) {
          return false;
        }
        const std::size_t child_fragment =
            fragment_from_parent(child, parent_diamond.id());
        dirty_node_and_parents(level + 1U, child.id());
        found->second.has_fragment[child_fragment] = false;
        account_mutation(level + 1U, found->second);
        if (!found->second.has_fragment[0U] &&
            !found->second.has_fragment[1U]) {
          const auto cached = evaluated_patches.find(
              resource_key(level + 1U, child.id()));
          if (cached != evaluated_patches.end()) {
            erase_candidates(cached->second);
            evaluated_patches.erase(cached);
          }
          levels[level + 1U].erase(found);
          refinement_protected.erase({level + 1U, child.id()});
          coarsening_requests.erase({level + 1U, child.id()});
          release_refinement_request({level + 1U, child.id()});
          --node_count;
        }
      }
    }
    parent = levels[level].find(id);
    parent->second.leaf = true;
    unpublished_topology = true;
    refinement_protected.erase({level, id});
    reclaim_cursor_valid = false;
    account_mutation(level, parent->second);
    dirty_node_and_parents(level, id);
    return true;
  }

  using refinement_path = std::array<core::grid_point, 41>;

  bool visible_mesh_over_capacity() const {
    return visible_mesh_capacity && visible_mesh_cost.bytes(patch_dimension) > visible_mesh_capacity;
  }

  mesh_cut_cost cost_after_split(std::size_t level, const node& parent) const {
    auto cost = visible_mesh_cost;
    for (std::uint8_t fragment = 0U; fragment < 2U; ++fragment) {
      if (parent.accounted_fragment_mask & (1U << fragment)) cost.remove(parent.texture_patterns[fragment]);
      if (!parent.has_fragment[fragment]) continue;
      for (std::size_t index = 0U; index < 2U; ++index) {
        node child;
        child.diamond = parent.diamond.cylindrical_child_diamond(fragment, index);
        const auto child_fragment = fragment_from_parent(child.diamond, parent.diamond.id());
        const node* existing = nullptr;
        if (level + 1U < levels.size()) {
          const auto found = levels[level + 1U].find(child.diamond.id());
          if (found != levels[level + 1U].end()) existing = &found->second;
        }
        const auto patch = evaluated_patches.find({level + 1U, child.diamond.id()});
        // Match account_mutation: an unmeasured child is reserved as visible.
        // An existing child can already be owned by the neighbouring parent.
        if (patch != evaluated_patches.end() && !patch->second.visible) continue;
        if (existing) {
          if (existing->leaf && !existing->has_fragment[child_fragment]) cost.add(existing->texture_patterns[child_fragment]);
        } else {
          describe_texture_patterns(level + 1U, child);
          cost.add(child.texture_patterns[child_fragment]);
        }
      }
    }
    return cost;
  }

  bool reclaim_for_refinement(const resource_key& request, std::size_t active_level,
                              const refinement_path& path, std::size_t& changes,
                              const step_clock& clock) {
    const auto goal = evaluated_patches.find(request);
    if (goal == evaluated_patches.end()) return false;
    const float maximum_loss = goal->second.priority * 0.75F;
    const auto affordable_error = [&](float error) {
      // Returning to a parent that meets the target cannot introduce a
      // competing refinement. Keep the separate exchange hysteresis for
      // capacity-driven swaps that lose precision.
      return error <= evaluated_threshold || error < maximum_loss;
    };
    auto it = reclaim_cursor_valid && reclaim_goal == request
        ? reclaimable_coarsenings.upper_bound(reclaim_after) : reclaimable_coarsenings.begin();
    while (it != reclaimable_coarsenings.end()) {
      if (clock.expired()) return false;
      const candidate victim = *it++;
      reclaim_goal = request; reclaim_after = victim; reclaim_cursor_valid = true;
      const auto found = evaluated_patches.find({victim.level, victim.id});
      if (found == evaluated_patches.end()) continue;
      // Heap order is increasing own error; unfinished requests can only raise
      // that loss. Required refinement dependencies remain protected.
      if (!affordable_error(found->second.priority)) break;
      if (!affordable_error(protected_priority({victim.level, victim.id}))) continue;
      if (victim.level + 1U >= active_level && victim.level + 1U <= request.first) {
        const auto child = levels[victim.level + 1U].find(path[victim.level + 1U]);
        if (child != levels[victim.level + 1U].end()) {
          bool dependency = false;
          for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
            dependency = dependency || (valid_fragment(child->second.diamond, fragment) &&
                child->second.diamond.parent_id(fragment) == victim.id);
          }
          if (dependency) continue;
        }
      }
      if (!coarsen(victim.level, victim.id, true)) continue;
      coarsening_requests[{victim.level, victim.id}] = request;
      ++changes;
      return true;
    }
    reclaim_cursor_valid = false;
    return false;
  }

  bool refine(std::size_t level, const core::grid_point& id,
              const resource_index& resources,
              std::size_t& change_count,
              std::size_t maximum_change_count,
              const step_clock& clock, const resource_key& request,
              refinement_path& path, bool& reclaimed) {
    if (level >= maximum_level || level >= levels.size() ||
        change_count >= maximum_change_count ||
        clock.expired() ||
        resources.detail_unavailable(level, id) || refinement_deferred({level, id}, request)) {
      return false;
    }
    level_map::iterator current = levels[level].find(id);
    if (current == levels[level].end() || !current->second.leaf) {
      return false;
    }
    path[level] = id;
    if (level == 0U && !resources.root_available(id)) {
      return false;
    }

    if (level > 0U) {
      for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
        current = levels[level].find(id);
        if (!current->second.has_fragment[fragment] &&
            valid_fragment(current->second.diamond, fragment)) {
          const core::grid_point parent_id =
              current->second.diamond.parent_id(fragment);
          const bool ready = refine(level - 1U, parent_id, resources,
              change_count, maximum_change_count, clock, request, path, reclaimed);
          // Preserve one unresolved dependency path. Completing a different
          // branch must not reclaim the first branch while its data is pending.
          if (!ready) return false;
        }
      }
    }

    current = levels[level].find(id);
    if (current == levels[level].end() || !current->second.leaf) {
      return false;
    }
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!current->second.has_fragment[fragment] &&
          valid_fragment(current->second.diamond, fragment)) {
        return false;
      }
    }
    if (!resources.detail_available(level, id) || change_count >= maximum_change_count || clock.expired()) return false;
    // Quote this local closure with the same layout certificate as production.
    // This is a target-cut cost, not a refund of the displayed parent's buffers.
    if (node_count + 4U > admission_node_count ||
        (split_capacity && admitted_splits + 1U > split_capacity) ||
        (visible_mesh_capacity && cost_after_split(level, current->second).bytes(patch_dimension) > visible_mesh_capacity)) {
      admission_limited = true;
      reclaimed = reclaim_for_refinement(request, level, path, change_count, clock);
      return false;
    }
    const core::grid_diamond parent_diamond =
        current->second.diamond;
    const std::array<bool, 2> parent_fragments =
        current->second.has_fragment;
    current->second.leaf = false;
    account_mutation(level, current->second);
    if (levels.size() == level + 1U) {
      levels.push_back(level_map());
    }
    const core::coordinate_transform transform =
        core::coordinate_transform::cylindrical(radius);
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (!parent_fragments[fragment]) {
        continue;
      }
      for (std::size_t child_index = 0U; child_index < 2U;
           ++child_index) {
        const core::grid_diamond child =
            parent_diamond.cylindrical_child_diamond(
                fragment, child_index);
        const std::size_t child_fragment =
            fragment_from_parent(child, parent_diamond.id());
        std::pair<level_map::iterator, bool> inserted =
            levels[level + 1U].emplace(child.id(), node());
        if (inserted.second) {
          ++node_count;
          inserted.first->second.diamond = child;
          describe_texture_patterns(level + 1U, inserted.first->second);
          inserted.first->second.minimum_height = current->second.minimum_height;
          inserted.first->second.maximum_height = current->second.maximum_height;
          const auto* measured = indexed_resources.height_range(resource_key(level + 1U, child.id()));
          if (measured != nullptr) {
            inserted.first->second.minimum_height = measured->minimum;
            inserted.first->second.maximum_height = measured->maximum;
          }
          inserted.first->second.bounds = make_box(child, transform,
              inserted.first->second.minimum_height, inserted.first->second.maximum_height);
        }
        inserted.first->second.has_fragment[child_fragment] = true;
        account_mutation(level + 1U, inserted.first->second);
        dirty_node_and_parents(level + 1U, child.id());
      }
    }
    ++change_count;
    unpublished_topology = true;
    // Bounded work may stop between a dependency and its requesting split.
    // The request owns those pins until it completes or ceases to be demand.
    refinement_protected[{level, id}] = request;
    coarsening_requests.erase({level, id});
    release_refinement_request({level, id});
    reclaim_cursor_valid = false;
    dirty_node_and_parents(level, id);
    return true;
  }

  lod_patch cached_patch(std::size_t level, const node& state,
                         const selection_context& view) const {
    const auto found = evaluated_patches.find(
        resource_key(level, state.diamond.id()));
    return found == evaluated_patches.end()
        ? priority(level, state, view) : found->second;
  }

  static void append_record_request(
      std::vector<lod_record_request>& requests,
      record_request_index& request_index,
      lod_record_kind kind, const lod_patch& patch,
      float inherited_priority = 0.0F) {
    const record_request_key key(
        kind, std::make_pair(patch.level, patch.id));
    const record_request_index::const_iterator existing =
        request_index.find(key);
    if (existing != request_index.end()) {
      lod_record_request& request = requests[existing->second];
      request.patch.priority = std::max(
          request.patch.priority, inherited_priority);
      return;
    }
    lod_record_request request;
    request.kind = kind;
    request.patch = patch;
    request.patch.priority = std::max(request.patch.priority,
                                      inherited_priority);
    request_index.emplace(key, requests.size());
    requests.push_back(request);
  }

  refinement_readiness collect_refinement_dependencies(
      std::size_t level, const core::grid_point& id,
      const selection_context& view,
      const resource_index& resources,
      float inherited_priority,
      std::vector<lod_record_request>& requests,
      record_request_index& request_index) const {
    if (level >= levels.size()) {
      return refinement_readiness::inconsistent;
    }
    const level_map::const_iterator found = levels[level].find(id);
    if (found == levels[level].end() || !found->second.leaf) {
      return refinement_readiness::inconsistent;
    }

    if (resources.detail_unavailable(level, id)) {
      const lod_patch patch = cached_patch(level, found->second, view);
      append_record_request(requests, request_index,
                            lod_record_kind::detail, patch,
                            inherited_priority);
      return refinement_readiness::unavailable;
    }
    if (level == 0U) {
      const bool detail_ready =
          resources.detail_available(level, id);
      if (!detail_ready) {
        const lod_patch patch = cached_patch(level, found->second, view);
        append_record_request(requests, request_index,
                              lod_record_kind::detail, patch,
                              inherited_priority);
      }
      return resources.root_available(id) && detail_ready
                 ? refinement_readiness::ready
                 : refinement_readiness::waiting;
    }
    refinement_readiness result = refinement_readiness::ready;
    for (std::size_t fragment = 0U; fragment < 2U; ++fragment) {
      if (found->second.has_fragment[fragment] ||
          !valid_fragment(found->second.diamond, fragment)) {
        continue;
      }
      const refinement_readiness dependency =
          collect_refinement_dependencies(
              level - 1U, found->second.diamond.parent_id(fragment), view,
              resources, inherited_priority, requests,
              request_index);
      if (dependency == refinement_readiness::inconsistent) {
        return dependency;
      }
      if (dependency == refinement_readiness::unavailable) {
        return dependency;
      }
      if (dependency == refinement_readiness::waiting) {
        result = dependency;
      }
    }
    if (resources.detail_available(level, id)) {
      const lod_patch patch = cached_patch(level, found->second, view);
      append_record_request(requests, request_index,
                            lod_record_kind::detail, patch,
                            inherited_priority);
      return result;
    }
    if (result == refinement_readiness::waiting) {
      return result;
    }
    const lod_patch patch = cached_patch(level, found->second, view);
    append_record_request(requests, request_index,
                          lod_record_kind::detail, patch,
                          inherited_priority);
    return refinement_readiness::waiting;
  }

  lod_cut make_cut(const camera_snapshot& camera,
                   const lod_resource_state& resources,
                   const resource_index& indexed_resources,
                   bool converged,
                   std::size_t change_count,
                   std::size_t maximum_request_frontier_count) const {
    lod_cut result;
    if (!configured()) {
      return result;
    }
    selection_context view(radius, patch_dimension, camera, maximum_level,
                           maximum_node_count,
                           resources.unavailable_details);
    std::size_t graph_level_count = levels.size();
    while (graph_level_count > 1U &&
           levels[graph_level_count - 1U].empty()) {
      --graph_level_count;
    }
    result.complete = true;
    result.converged = converged;
    result.change_count = change_count;
    result.graph_level_count = graph_level_count;
    result.leaf_count_by_level.assign(graph_level_count, 0U);

    std::vector<std::vector<lod_patch>> patches_by_level(
        graph_level_count);
    for (std::size_t level = 0U; level < graph_level_count; ++level) {
      for (const level_map::value_type& entry : levels[level]) {
        const lod_patch patch = cached_patch(level, entry.second, view);
        patches_by_level[level].push_back(patch);
        if (entry.second.leaf) {
          ++result.leaf_count_by_level[level];
          result.patches.push_back(patch);
        }
      }
    }

    record_request_index request_index;
    for (const lod_patch& patch : patches_by_level[0U]) {
      append_record_request(result.record_requests,
                            request_index,
                            lod_record_kind::root, patch);
    }
    for (std::size_t level = 0U; level < graph_level_count; ++level) {
      for (std::size_t index = 0U;
           index < patches_by_level[level].size(); ++index) {
        const lod_patch& patch = patches_by_level[level][index];
        const level_map::const_iterator state =
            levels[level].find(patch.id);
        if (state != levels[level].end() && !state->second.leaf) {
          append_record_request(result.record_requests,
                                request_index,
                                lod_record_kind::detail, patch);
        }
      }
    }
    std::size_t active_frontier_count = 0U;
    for (const candidate& pending : desired_refinements) {
      const auto found = evaluated_patches.find(
          resource_key(pending.level, pending.id));
      if (found == evaluated_patches.end()) {
        result.complete = false;
        result.converged = false;
        continue;
      }
      const lod_patch& patch = found->second;
      if (active_frontier_count >= maximum_request_frontier_count) {
        result.converged = false;
        break;
      }
      const refinement_readiness readiness =
          collect_refinement_dependencies(
              patch.level, patch.id, view, indexed_resources,
              patch.priority, result.record_requests, request_index);
      if (readiness == refinement_readiness::inconsistent) {
        result.complete = false;
        result.converged = false;
      } else if (readiness != refinement_readiness::unavailable) {
        result.converged = false;
        ++active_frontier_count;
      }
    }
    return result;
  }

  bool flush_priorities(const selection_context& view,
                        const lod_update_budget& budget,
                        const step_clock& clock,
                        std::size_t& priority_update_count) {
    while (scanning_priorities) {
      if (scan_position == levels[scan_level].end()) {
        ++scan_level;
        if (scan_level == levels.size()) {
          scanning_priorities = false;
          break;
        }
        scan_position = levels[scan_level].begin();
        continue;
      }
      if (priority_update_count >= budget.maximum_priority_update_count ||
          clock.expired()) {
        return false;
      }
      const resource_key key(scan_level, scan_position->first);
      ++scan_position;
      refresh_node(key, view);
      ++priority_update_count;
      --scan_remaining;
    }
    while (!dirty_nodes.empty()) {
      if (priority_update_count >= budget.maximum_priority_update_count ||
          clock.expired()) {
        return false;
      }
      const resource_key key = *dirty_nodes.begin();
      dirty_nodes.erase(dirty_nodes.begin());
      refresh_node(key, view);
      ++priority_update_count;
    }
    return true;
  }

  lod_cut retained_cut(std::size_t changes, std::size_t priority_updates) const {
    lod_cut result = published_cut;
    result.converged = false;
    result.budget_exhausted = true;
    result.change_count = changes;
    result.priority_update_count = priority_updates;
    result.pending_priority_update_count = scan_remaining + dirty_nodes.size();
    return result;
  }

  lod_cut update_step(float threshold, const camera_snapshot& camera,
                      const lod_resource_state& resources,
                      const lod_update_budget& budget) {
    if (!configured() || !std::isfinite(threshold) || threshold < 0.0F ||
        !std::isfinite(budget.maximum_elapsed_milliseconds) ||
        budget.maximum_elapsed_milliseconds < 0.0) {
      return lod_cut();
    }
    const step_clock clock(budget.maximum_elapsed_milliseconds);
    const auto previous_capacity = admission_node_count;
    const auto previous_mesh_bytes = visible_mesh_capacity;
    const auto previous_splits = split_capacity;
    admission_node_count = budget.maximum_node_count == 0U ? maximum_node_count
        : std::min(maximum_node_count, budget.maximum_node_count);
    if (admission_node_count < 8U) return lod_cut();
    const float requested_threshold = threshold;
    const bool resources_changed = !resources_initialized || resources.revision == 0U ||
        resources.revision != resource_revision || resources.height_revision != height_revision;
    synchronize_resources(resources);
    std::size_t priority_updates = 0U;
    visible_mesh_capacity = budget.maximum_visible_mesh_bytes;
    split_capacity = budget.maximum_split_count;
    admission_limited = false;
    const bool capacity_changed = coarsening_only != budget.coarsening_only || previous_capacity != admission_node_count ||
        previous_mesh_bytes != visible_mesh_capacity || previous_splits != split_capacity;
    coarsening_only = budget.coarsening_only;
    if (capacity_changed) {
      for (const auto& guard : refinement_protected) dirty_nodes.insert(guard.first);
      refinement_protected.clear();
      for (const auto& waiting : coarsening_requests) dirty_nodes.insert(waiting.first);
      coarsening_requests.clear();
      reclaim_cursor_valid = false;
    }
    if (!same_view(threshold, camera)) {
      start_priority_scan(threshold, camera);
    }
    selection_context view(radius, patch_dimension, evaluated_camera,
                           maximum_level, maximum_node_count,
                           resources.unavailable_details);
    std::size_t changes = 0U;
    const auto with_capacity = [&](lod_cut cut) {
      cut.requested_threshold = requested_threshold;
      cut.feasible_threshold = threshold;
      cut.limited_by_capacity = admission_limited;
      cut.node_count = node_count;
      return cut;
    };
    if (!resources_changed && !capacity_changed &&
        published_request_frontier_count == budget.maximum_request_frontier_count &&
        published_cut.change_count == 0U &&
        !published_cut.budget_exhausted &&
        !scanning_priorities && dirty_nodes.empty()) {
      // A settled or I/O-blocked cut is stable until camera, data or admission
      // changes. Preparing it with zero topology credit must not turn waiting
      // dependency candidates back into runnable work. Keep unmet demand and
      // its non-converged state without reclassifying it as budget exhaustion.
      // A cut that just changed topology still needs its final convergence pass.
      auto cached = published_cut;
      cached.change_count = 0U;
      cached.priority_update_count = priority_updates;
      cached.budget_exhausted = false;
      return cached;
    }
    if (!flush_priorities(view, budget, clock, priority_updates)) {
      return with_capacity(retained_cut(changes, priority_updates));
    }

    // A previous slice already changed the graph. Once its dirty priorities
    // are coherent, publish that checkpoint before starting another mutation.
    // Otherwise a small priority/time budget can perpetually replace the last
    // dirty closure with a new one while rendering only the old complete cut.
    const bool publish_checkpoint = unpublished_topology;

    // Coarsening reclaims topology before admitting refinement. Every local
    // mutation updates only its nodes and neighbours in the persistent sets.
    while (!publish_checkpoint && !ready_coarsenings.empty() &&
           changes < budget.maximum_change_count && !clock.expired()) {
      const candidate next = *ready_coarsenings.begin();
      ready_coarsenings.erase(ready_coarsenings.begin());
      if (coarsen(next.level, next.id)) {
        ++changes;
      }
      if (!flush_priorities(view, budget, clock, priority_updates)) {
        return with_capacity(retained_cut(changes, priority_updates));
      }
    }

    // A reduced budget reclaims the least urgent complete sibling closure.
    // It does not change the requested threshold or discard pending demand.
    while (!publish_checkpoint && (node_count > admission_node_count ||
            visible_mesh_over_capacity() ||
            (split_capacity && admitted_splits > split_capacity)) &&
           changes < budget.maximum_change_count && !clock.expired()) {
      if (reclaimable_coarsenings.empty()) break;
      const auto victim = *reclaimable_coarsenings.begin();
      reclaimable_coarsenings.erase(reclaimable_coarsenings.begin());
      if (!coarsen(victim.level, victim.id, true)) continue;
      ++changes;
      admission_limited = true;
      if (!flush_priorities(view, budget, clock, priority_updates))
        return with_capacity(retained_cut(changes, priority_updates));
    }
    std::vector<candidate> blocked;
    bool reclaimed_for_refinement = false;
    bool refinement_interrupted = false;
    while (!publish_checkpoint && !coarsening_only && !ready_refinements.empty() &&
           changes < budget.maximum_change_count && !clock.expired()) {
      const candidate next = *ready_refinements.begin();
      ready_refinements.erase(ready_refinements.begin());
      refinement_path path{};
      if (!refine(next.level, next.id, indexed_resources, changes,
                  budget.maximum_change_count, clock, {next.level, next.id},
                  path, reclaimed_for_refinement)) {
        blocked.push_back(next);
        // A recursive dependency can yield after removing its requesting
        // candidate. Preserve that continuation separately from data waits.
        refinement_interrupted = changes >= budget.maximum_change_count || clock.expired();
      }
      if (!flush_priorities(view, budget, clock, priority_updates)) {
        // Readiness entries remain reusable while the last complete cut is
        // displayed. Incomplete priority scans are never published.
        for (const candidate& waiting : blocked) {
          ready_refinements.insert(waiting);
        }
        return with_capacity(retained_cut(changes, priority_updates));
      }
      if (reclaimed_for_refinement) break;
    }
    // Only unfinished runnable work requests another slice. In particular,
    // generating the complete cut below can itself overrun the clock while
    // every refinement is waiting for records. Retrying that identical cut
    // cannot make progress; record arrival will dirty its priorities instead.
    // Inspect the queues before restoring attempted, blocked refinements.
    const bool topology_pending = !ready_coarsenings.empty() ||
        (!coarsening_only && !ready_refinements.empty()) ||
        (!reclaimable_coarsenings.empty() &&
         (node_count > admission_node_count ||
          visible_mesh_over_capacity() ||
          (split_capacity && admitted_splits > split_capacity)));
    const bool work_interrupted = topology_pending || refinement_interrupted || reclaimed_for_refinement;
    for (const candidate& waiting : blocked) {
      const resource_key key(waiting.level, waiting.id);
      const auto state = levels[waiting.level].find(waiting.id);
      const auto patch = evaluated_patches.find(key);
      if (state != levels[waiting.level].end() &&
          patch != evaluated_patches.end()) {
        classify(patch->second, state->second);
      }
    }
    published_cut = make_cut(camera, resources, indexed_resources,
                             changes == 0U, changes,
                             budget.maximum_request_frontier_count);
    published_request_frontier_count = budget.maximum_request_frontier_count;
    unpublished_topology = false;
    published_cut.priority_update_count = priority_updates;
    published_cut.requested_threshold = requested_threshold;
    published_cut.feasible_threshold = threshold;
    published_cut.limited_by_capacity = admission_limited;
    published_cut.node_count = node_count;
    if (admission_limited && changes == 0U && !work_interrupted) published_cut.converged = true;
    published_cut.budget_exhausted = work_interrupted;
    if (published_cut.budget_exhausted) {
      published_cut.converged = false;
    }
    // A completed recovery is not a precision-converged model. Normal updates
    // must resume its retained refinement demand after publication succeeds.
    if (coarsening_only && !ready_refinements.empty()) published_cut.converged = false;
    return published_cut;
  }
};

cylindrical_lod_controller::cylindrical_lod_controller()
    : implementation_(new implementation()) {}

cylindrical_lod_controller::~cylindrical_lod_controller() = default;

void cylindrical_lod_controller::clear() {
  implementation_->reset();
}

void cylindrical_lod_controller::configure(
    double radius, std::uint32_t patch_dimension,
    std::size_t maximum_level, std::size_t maximum_node_count) {
  implementation_->initialize(radius, patch_dimension, maximum_level,
                              maximum_node_count);
}

lod_cut cylindrical_lod_controller::update(
    float threshold, const camera_snapshot& camera,
    const lod_resource_state& resources,
    std::size_t maximum_change_count) {
  lod_update_budget budget;
  budget.maximum_change_count =
      std::max<std::size_t>(1U, maximum_change_count);
  budget.maximum_priority_update_count =
      std::numeric_limits<std::size_t>::max();
  budget.maximum_elapsed_milliseconds = 0.0;
  return implementation_->update_step(threshold, camera, resources, budget);
}

lod_cut cylindrical_lod_controller::update_step(
    float threshold, const camera_snapshot& camera,
    const lod_resource_state& resources, const lod_update_budget& budget) {
  return implementation_->update_step(threshold, camera, resources, budget);
}

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level,
    std::size_t maximum_node_count) {
  static const std::vector<lod_detail_key> no_unavailable_details;
  return select_procedural_cylindrical_lod(
      radius, patch_dimension, threshold, camera, maximum_level,
      maximum_node_count, no_unavailable_details);
}

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level,
    std::size_t maximum_node_count,
    const std::vector<lod_detail_key>& unavailable_details) {
  lod_cut result;
  bool camera_is_finite = true;
  for (double coordinate : camera.position) {
    camera_is_finite = camera_is_finite && std::isfinite(coordinate);
  }
  for (const plane4d& plane : camera.clip_planes) {
    for (double coefficient : plane) {
      camera_is_finite = camera_is_finite && std::isfinite(coefficient);
    }
  }
  if (!std::isfinite(radius) || radius <= 0.0 || patch_dimension == 0U ||
      !std::isfinite(threshold) || threshold < 0.0F ||
      maximum_level == 0U || maximum_node_count < 8U ||
      !camera_is_finite) {
    return result;
  }

  const std::size_t compatible_maximum_level =
      std::min<std::size_t>(maximum_level, 40U);
  selection_context context(radius, patch_dimension, camera,
                            compatible_maximum_level, maximum_node_count,
                            unavailable_details);
  const std::array<core::grid_diamond, 8> roots = core::cylindrical_roots();
  for (const core::grid_diamond& root : roots) {
    node root_node;
    root_node.diamond = root;
    root_node.has_fragment = {{true, true}};
    root_node.bounds = make_box(root, context.transform);
    context.levels[0U].emplace(root.id(), root_node);
    ++context.node_count;
  }

  while (true) {
    bool found = false;
    lod_patch candidate;
    morton_less is_less;
    for (std::size_t level = 0U; level < context.levels.size(); ++level) {
      for (const level_map::value_type& entry : context.levels[level]) {
        if (!entry.second.leaf || entry.second.blocked) {
          continue;
        }
        if (detail_is_unavailable(context, level, entry.first)) {
          continue;
        }
        const lod_patch current = priority(level, entry.second, context);
        if (current.priority <= threshold) {
          continue;
        }
        if (!found || current.priority > candidate.priority ||
            (current.priority == candidate.priority &&
             is_less(candidate.id, current.id))) {
          candidate = current;
          found = true;
        }
      }
    }
    if (!found) {
      result.complete = true;
      result.converged = true;
      break;
    }
    if (!refine(context, candidate.level, candidate.id)) {
      if (context.node_count + 4U > context.maximum_node_count) {
        break;
      }
      level_map::iterator blocked =
          context.levels[candidate.level].find(candidate.id);
      if (blocked == context.levels[candidate.level].end()) {
        break;
      }
      blocked->second.blocked = true;
    }
  }

  while (context.levels.size() > 1U && context.levels.back().empty()) {
    context.levels.pop_back();
  }
  result.graph_level_count = context.levels.size();
  result.leaf_count_by_level.assign(result.graph_level_count, 0U);
  for (std::size_t level = 0U; level < context.levels.size(); ++level) {
    for (const level_map::value_type& entry : context.levels[level]) {
      if (!entry.second.leaf) {
        continue;
      }
      ++result.leaf_count_by_level[level];
      result.patches.push_back(priority(level, entry.second, context));
    }
    for (const level_map::value_type& entry : context.levels[level]) {
      const lod_patch patch = priority(level, entry.second, context);
      if (level == 0U) {
        lod_record_request root_request;
        root_request.kind = lod_record_kind::root;
        root_request.patch = patch;
        result.record_requests.push_back(root_request);
      }
      if (!entry.second.leaf) {
        lod_record_request detail_request;
        detail_request.kind = lod_record_kind::detail;
        detail_request.patch = patch;
        result.record_requests.push_back(detail_request);
      }
    }
  }
  return result;
}

lod_cut select_fixed_planar_lod(
    std::uint32_t patch_dimension, std::size_t target_level,
    std::size_t maximum_level, std::size_t maximum_node_count) {
  lod_cut result;
  if (patch_dimension == 0U || maximum_level == 0U ||
      target_level >= maximum_level || maximum_level > 40U ||
      maximum_node_count == 0U) {
    return result;
  }

  std::vector<level_map> levels(1U);
  std::size_t node_count = 1U;
  node root_node;
  root_node.diamond = core::planar_root();
  root_node.has_fragment = {{true, true}};
  levels[0U].emplace(root_node.diamond.id(), root_node);

  for (std::size_t level = 0U; level < target_level; ++level) {
    std::vector<core::grid_point> leaves;
    for (const level_map::value_type& entry : levels[level]) {
      if (entry.second.leaf) {
        leaves.push_back(entry.first);
      }
    }
    for (const core::grid_point& id : leaves) {
      if (!refine_planar(levels, node_count, maximum_node_count,
                         level, id)) {
        return result;
      }
    }
  }

  result.complete = true;
  result.converged = true;
  result.graph_level_count = levels.size();
  result.leaf_count_by_level.assign(levels.size(), 0U);
  for (std::size_t level = 0U; level < levels.size(); ++level) {
    for (const level_map::value_type& entry : levels[level]) {
      if (!entry.second.leaf) {
        continue;
      }
      ++result.leaf_count_by_level[level];
      result.patches.push_back(fixed_patch(level, entry.second));
    }
    for (const level_map::value_type& entry : levels[level]) {
      const lod_patch patch = fixed_patch(level, entry.second);
      if (level == 0U) {
        lod_record_request root_request;
        root_request.kind = lod_record_kind::root;
        root_request.patch = patch;
        result.record_requests.push_back(root_request);
      }
      if (!entry.second.leaf) {
        lod_record_request detail_request;
        detail_request.kind = lod_record_kind::detail;
        detail_request.patch = patch;
        result.record_requests.push_back(detail_request);
      }
    }
  }
  return result;
}

}  // namespace frame
}  // namespace terra
