#include <terra/frame/lod.hpp>

#include <terra/core/coordinate_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <set>
#include <utility>

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
                      const core::grid_point& point) {
  return transform.xyz_from_uvh(uvh_from_grid(point));
}

oriented_box make_box(const core::grid_diamond& diamond,
                      const core::coordinate_transform& transform) {
  const vector3 normal = transform.up_from_uvh(uvh_from_grid(diamond.id()));
  const vector3 center_point = xyz_from_grid(transform, diamond.id());
  const vector3 p0 = xyz_from_grid(transform, diamond.corner(0U));
  const vector3 p1 = xyz_from_grid(
      transform, valid_fragment(diamond, 0U) ? diamond.corner(1U)
                                             : diamond.corner(3U));
  const vector3 p2 = xyz_from_grid(transform, diamond.corner(2U));
  const vector3 p3 = xyz_from_grid(
      transform, valid_fragment(diamond, 1U) ? diamond.corner(3U)
                                             : diamond.corner(1U));

  const vector3 direction = normalized(subtract(p1, p0));
  const vector3 x = normalized(subtract(direction, scale(normal, dot(normal, direction))));
  const vector3 z = normal;
  const vector3 y = scale(cross(x, z), -1.0);
  const std::array<vector3, 3> axes{{x, y, z}};
  const vector3 points[] = {center_point, p0, p1, p2, p3};

  vector3 minimum{{dot(points[0], axes[0]), dot(points[0], axes[1]),
                   dot(points[0], axes[2])}};
  vector3 maximum = minimum;
  for (const vector3& point : points) {
    for (std::size_t axis = 0U; axis < 3U; ++axis) {
      const double local = dot(point, axes[axis]);
      minimum[axis] = std::min(minimum[axis], local);
      maximum[axis] = std::max(maximum[axis], local);
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
};

using level_map = std::map<core::grid_point, node, morton_less>;

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
            const core::grid_point& id) {
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
        refine(context, level - 1U, parent);
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
        inserted.first->second.bounds = make_box(child, context.transform);
      }
      inserted.first->second.has_fragment[child_fragment] = true;
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

  struct resource_index {
    std::set<resource_key> available_roots;
    std::set<resource_key> available_details;
    std::set<resource_key> unavailable_details;

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
  std::size_t node_count = 0U;
  std::vector<level_map> levels;

  bool configured() const {
    return std::isfinite(radius) && radius > 0.0 &&
           patch_dimension > 0U && maximum_level > 0U &&
           maximum_node_count >= 8U && !levels.empty();
  }

  void reset() {
    radius = 0.0;
    patch_dimension = 0U;
    maximum_level = 0U;
    maximum_node_count = 0U;
    node_count = 0U;
    levels.clear();
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
      root_node.bounds = make_box(root, transform);
      levels[0U].emplace(root.id(), root_node);
      ++node_count;
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

  bool coarsen(std::size_t level, const core::grid_point& id) {
    if (level >= levels.size()) {
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
        found->second.has_fragment[child_fragment] = false;
        if (!found->second.has_fragment[0U] &&
            !found->second.has_fragment[1U]) {
          levels[level + 1U].erase(found);
          --node_count;
        }
      }
    }
    parent = levels[level].find(id);
    parent->second.leaf = true;
    return true;
  }

  bool refine(std::size_t level, const core::grid_point& id,
              const resource_index& resources,
              std::size_t& change_count,
              std::size_t maximum_change_count) {
    if (level >= maximum_level || level >= levels.size() ||
        node_count + 4U > maximum_node_count ||
        change_count >= maximum_change_count ||
        resources.detail_unavailable(level, id) ||
        !resources.detail_available(level, id)) {
      return false;
    }
    level_map::iterator current = levels[level].find(id);
    if (current == levels[level].end() || !current->second.leaf) {
      return false;
    }
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
          static_cast<void>(refine(level - 1U, parent_id, resources,
                                   change_count, maximum_change_count));
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
    if (change_count >= maximum_change_count) {
      return false;
    }

    const core::grid_diamond parent_diamond =
        current->second.diamond;
    const std::array<bool, 2> parent_fragments =
        current->second.has_fragment;
    current->second.leaf = false;
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
          inserted.first->second.bounds = make_box(child, transform);
        }
        inserted.first->second.has_fragment[child_fragment] = true;
      }
    }
    ++change_count;
    return true;
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
      const lod_patch patch = priority(level, found->second, view);
      append_record_request(requests, request_index,
                            lod_record_kind::detail, patch,
                            inherited_priority);
      return refinement_readiness::unavailable;
    }
    if (level == 0U) {
      const bool detail_ready =
          resources.detail_available(level, id);
      if (!detail_ready) {
        const lod_patch patch = priority(level, found->second, view);
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
      const lod_patch patch = priority(level, found->second, view);
      append_record_request(requests, request_index,
                            lod_record_kind::detail, patch,
                            inherited_priority);
      return result;
    }
    if (result == refinement_readiness::waiting) {
      return result;
    }
    const lod_patch patch = priority(level, found->second, view);
    append_record_request(requests, request_index,
                          lod_record_kind::detail, patch,
                          inherited_priority);
    return refinement_readiness::waiting;
  }

  lod_cut make_cut(float threshold, const camera_snapshot& camera,
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
        const lod_patch patch = priority(level, entry.second, view);
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
    std::vector<lod_patch> pending_refinements;
    for (std::size_t level = 0U; level < graph_level_count; ++level) {
      for (std::size_t index = 0U;
           index < patches_by_level[level].size(); ++index) {
        const lod_patch& patch = patches_by_level[level][index];
        const level_map::const_iterator state =
            levels[level].find(patch.id);
        const bool pending_refine =
            state != levels[level].end() && state->second.leaf &&
            patch.visible && patch.priority > threshold &&
            level < maximum_level;
        if (state != levels[level].end() && !state->second.leaf) {
          append_record_request(result.record_requests,
                                request_index,
                                lod_record_kind::detail, patch);
        }
        if (pending_refine) {
          pending_refinements.push_back(patch);
        }
      }
    }
    std::sort(pending_refinements.begin(), pending_refinements.end(),
              [threshold](const lod_patch& left,
                          const lod_patch& right) {
                const std::uint64_t left_priority =
                    priority_order_key(left.priority, threshold);
                const std::uint64_t right_priority =
                    priority_order_key(right.priority, threshold);
                if (left_priority != right_priority) {
                  return left_priority > right_priority;
                }
                if (left.level != right.level) {
                  return left.level < right.level;
                }
                return morton_less()(left.id, right.id);
              });
    std::size_t active_frontier_count = 0U;
    for (const lod_patch& patch : pending_refinements) {
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

  lod_cut update(float threshold, const camera_snapshot& camera,
                 const lod_resource_state& resources,
                 std::size_t maximum_change_count) {
    if (!configured() || !std::isfinite(threshold) || threshold < 0.0F) {
      return lod_cut();
    }
    maximum_change_count = std::max<std::size_t>(1U,
                                                 maximum_change_count);
    const resource_index indexed_resources(resources);
    selection_context view(radius, patch_dimension, camera, maximum_level,
                           maximum_node_count,
                           resources.unavailable_details);
    const float coarsen_threshold = threshold * 0.75F;

    std::size_t change_count = 0U;
    struct coarsen_candidate {
      std::size_t level = 0U;
      core::grid_point id{{0, 0, 0}};
      float priority = 0.0F;
    };
    std::vector<coarsen_candidate> coarsen_candidates;
    for (std::size_t level = 0U; level < levels.size(); ++level) {
      for (const level_map::value_type& entry : levels[level]) {
        if (entry.second.leaf || !can_coarsen(level, entry.second)) {
          continue;
        }
        const float candidate_priority =
            priority(level, entry.second, view).priority;
        if (candidate_priority < coarsen_threshold) {
          coarsen_candidate candidate;
          candidate.level = level;
          candidate.id = entry.first;
          candidate.priority = candidate_priority;
          coarsen_candidates.push_back(candidate);
        }
      }
    }
    std::sort(coarsen_candidates.begin(), coarsen_candidates.end(),
              [coarsen_threshold](const coarsen_candidate& left,
                                  const coarsen_candidate& right) {
                if (left.level != right.level) {
                  return left.level > right.level;
                }
                const std::uint64_t left_priority =
                    priority_order_key(left.priority, coarsen_threshold);
                const std::uint64_t right_priority =
                    priority_order_key(right.priority, coarsen_threshold);
                if (left_priority != right_priority) {
                  return left_priority < right_priority;
                }
                return morton_less()(left.id, right.id);
              });
    for (const coarsen_candidate& candidate : coarsen_candidates) {
      if (change_count >= maximum_change_count) {
        break;
      }
      if (coarsen(candidate.level, candidate.id)) {
        ++change_count;
      }
    }

    if (change_count < maximum_change_count &&
        node_count + 4U <= maximum_node_count) {
      std::vector<lod_patch> refine_candidates;
      for (std::size_t level = 0U; level < levels.size(); ++level) {
        for (const level_map::value_type& entry : levels[level]) {
          if (!entry.second.leaf || level >= maximum_level ||
              indexed_resources.detail_unavailable(level, entry.first) ||
              !indexed_resources.detail_available(level, entry.first)) {
            continue;
          }
          const lod_patch patch = priority(level, entry.second, view);
          if (patch.visible && patch.priority > threshold) {
            refine_candidates.push_back(patch);
          }
        }
      }
      std::sort(refine_candidates.begin(), refine_candidates.end(),
                [threshold](const lod_patch& left,
                            const lod_patch& right) {
                  const std::uint64_t left_priority =
                      priority_order_key(left.priority, threshold);
                  const std::uint64_t right_priority =
                      priority_order_key(right.priority, threshold);
                  if (left_priority != right_priority) {
                    return left_priority > right_priority;
                  }
                  if (left.level != right.level) {
                    return left.level < right.level;
                  }
                  return morton_less()(left.id, right.id);
                });
      for (const lod_patch& candidate : refine_candidates) {
        if (change_count >= maximum_change_count) {
          break;
        }
        static_cast<void>(refine(candidate.level, candidate.id,
                                 indexed_resources, change_count,
                                 maximum_change_count));
      }
    }

    return make_cut(threshold, camera, resources, indexed_resources,
                    change_count == 0U, change_count,
                    maximum_change_count);
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
  return implementation_->update(threshold, camera, resources,
                                 maximum_change_count);
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
