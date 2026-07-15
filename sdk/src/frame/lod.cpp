#include <terra/frame/lod.hpp>

#include <terra/core/coordinate_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
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

  selection_context(double radius, std::uint32_t patch_dimension_value,
                    const camera_snapshot& camera_value,
                    std::size_t maximum_level_value,
                    std::size_t maximum_node_count_value)
      : transform(core::coordinate_transform::cylindrical(radius)),
        patch_dimension(patch_dimension_value),
        camera(camera_value),
        maximum_level(maximum_level_value),
        maximum_node_count(maximum_node_count_value),
        node_count(0U),
        levels(1U) {}
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

}  // namespace

lod_cut select_procedural_cylindrical_lod(
    double radius, std::uint32_t patch_dimension, float threshold,
    const camera_snapshot& camera, std::size_t maximum_level,
    std::size_t maximum_node_count) {
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
                            compatible_maximum_level, maximum_node_count);
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
        if (!entry.second.leaf) {
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
      break;
    }
    if (!refine(context, candidate.level, candidate.id)) {
      break;
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

}  // namespace frame
}  // namespace terra
