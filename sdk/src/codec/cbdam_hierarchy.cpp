#include <terra/codec/cbdam_hierarchy.hpp>

#include <limits>
#include <new>

namespace terra {
namespace codec {
namespace {

std::size_t triangle_vertex_count(std::uint32_t dimension) {
  return (static_cast<std::size_t>(dimension) + 1U) *
         (static_cast<std::size_t>(dimension) + 2U) / 2U;
}

bool valid_fragment(const height_fragment& fragment,
                    std::uint32_t dimension) {
  return fragment.dimension == dimension &&
         fragment.values.size() == triangle_vertex_count(dimension);
}

bool checked_value(std::int64_t value, std::int32_t& output) {
  if (value < std::numeric_limits<std::int32_t>::min() ||
      value > std::numeric_limits<std::int32_t>::max()) {
    return false;
  }
  output = static_cast<std::int32_t>(value);
  return true;
}

bool rounded_divide(std::int64_t value, std::int64_t half,
                    std::int64_t divisor, std::int32_t& output) {
  const std::int64_t adjusted = value > 0 ? value + half : value - half;
  return checked_value(adjusted / divisor, output);
}

bool average4(std::int32_t v00, std::int32_t v01,
              std::int32_t v10, std::int32_t v11,
              std::int32_t& output) {
  const std::int64_t sum = static_cast<std::int64_t>(v00) + v01 + v10 + v11;
  return rounded_divide(sum, 2, 4, output);
}

bool half_average4(std::int32_t v00, std::int32_t v01,
                   std::int32_t v10, std::int32_t v11,
                   std::int32_t& output) {
  const std::int64_t sum = static_cast<std::int64_t>(v00) + v01 + v10 + v11;
  return rounded_divide(sum, 4, 8, output);
}

bool predict(const std::vector<std::int32_t>& values,
             std::size_t width, std::size_t row, std::size_t column,
             std::int32_t& output) {
  const auto at = [&values, width](std::size_t y, std::size_t x) {
    return values[y * width + x];
  };
  if (row > 0U && row + 2U < width &&
      column > 0U && column + 2U < width) {
    const std::int64_t center =
        static_cast<std::int64_t>(at(row, column)) +
        at(row, column + 1U) + at(row + 1U, column) +
        at(row + 1U, column + 1U);
    const std::int64_t edge =
        static_cast<std::int64_t>(at(row - 1U, column)) +
        at(row - 1U, column + 1U) + at(row, column - 1U) +
        at(row + 1U, column - 1U) + at(row, column + 2U) +
        at(row + 1U, column + 2U) + at(row + 2U, column) +
        at(row + 2U, column + 1U);
    return rounded_divide(10 * center - edge, 16, 32, output);
  }
  return average4(at(row, column), at(row, column + 1U),
                  at(row + 1U, column), at(row + 1U, column + 1U),
                  output);
}

std::size_t matrix_index(std::uint32_t dimension, std::size_t width,
                         std::uint32_t y, std::uint32_t x,
                         std::size_t parent_fragment,
                         std::size_t child_index) {
  const std::int64_t d = dimension;
  const std::int64_t ix = x;
  const std::int64_t iy = y;
  std::int64_t row = 0;
  std::int64_t column = 0;
  if (parent_fragment == 0U && child_index == 0U) {
    row = ix - iy + d;
    column = -ix - iy + d;
  } else if (parent_fragment == 0U) {
    row = -ix - iy + d;
    column = -ix + iy + d;
  } else if (child_index == 0U) {
    row = -ix + iy + d;
    column = ix + iy + d;
  } else {
    row = ix + iy + d;
    column = ix - iy + d;
  }
  return static_cast<std::size_t>(row) * width +
         static_cast<std::size_t>(column);
}

}  // namespace

bool height_fragment::empty() const {
  return dimension == 0U || values.empty();
}

std::size_t height_fragment::vertex_count() const {
  return triangle_vertex_count(dimension);
}

bool height_diamond::has_fragment(std::size_t fragment) const {
  return fragment < fragments.size() &&
         (fragment_mask & (std::uint8_t(1U) << fragment)) != 0U;
}

bool height_refinement::has_child(std::size_t parent_fragment,
                                  std::size_t child_index) const {
  if (parent_fragment > 1U || child_index > 1U) {
    return false;
  }
  const std::size_t slot = 2U * parent_fragment + child_index;
  return (child_mask & (std::uint8_t(1U) << slot)) != 0U;
}

hierarchy_status make_cbdam_root_height(const height_patch& root,
                                        height_diamond& output) {
  output = height_diamond();
  if (root.rows < 2U || root.rows != root.columns ||
      root.values.size() !=
          static_cast<std::size_t>(root.rows) * root.columns) {
    return hierarchy_status::invalid_shape;
  }
  const std::uint32_t dimension = root.rows - 1U;
  if (dimension > maximum_cbdam_patch_dimension) {
    return hierarchy_status::resource_limit;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    output.dimension = dimension;
    output.fragment_mask = 0x03U;
    const std::size_t vertex_count = triangle_vertex_count(dimension);
    for (height_fragment& fragment : output.fragments) {
      fragment.dimension = dimension;
      fragment.values.resize(vertex_count);
    }

    std::size_t count = 0U;
    for (std::uint32_t y = 0U; y <= dimension; ++y) {
      for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
        output.fragments[0].values[count++] =
            root.values[static_cast<std::size_t>(y) * root.columns + x];
      }
    }

    count = 0U;
    for (std::int32_t y = static_cast<std::int32_t>(dimension);
         y >= 0; --y) {
      for (std::int32_t x = static_cast<std::int32_t>(dimension);
           x >= static_cast<std::int32_t>(dimension) - y; --x) {
        output.fragments[1].values[count++] =
            root.values[static_cast<std::size_t>(y) * root.columns +
                        static_cast<std::size_t>(x)];
      }
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output = height_diamond();
    return hierarchy_status::resource_limit;
  }
#endif
  return hierarchy_status::ok;
}

hierarchy_status refine_cbdam_height(const height_diamond& parent,
                                     const height_patch& detail,
                                     height_refinement& output) {
  output = height_refinement();
  const std::uint32_t dimension = parent.dimension;
  if (dimension == 0U || dimension > maximum_cbdam_patch_dimension) {
    return hierarchy_status::resource_limit;
  }
  if ((parent.fragment_mask & 0x03U) == 0U ||
      (parent.fragment_mask & 0xfcU) != 0U) {
    return hierarchy_status::missing_fragment;
  }
  for (std::size_t fragment = 0U; fragment < parent.fragments.size();
       ++fragment) {
    if (parent.has_fragment(fragment) &&
        !valid_fragment(parent.fragments[fragment], dimension)) {
      return hierarchy_status::invalid_shape;
    }
  }
  if (detail.rows != dimension || detail.columns != dimension ||
      detail.values.size() !=
          static_cast<std::size_t>(dimension) * dimension) {
    return hierarchy_status::invalid_shape;
  }

#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  try {
#endif
    const std::size_t low_width = static_cast<std::size_t>(dimension) + 1U;
    const std::size_t matrix_width =
        2U * static_cast<std::size_t>(dimension) + 1U;
    std::vector<std::int32_t> low(low_width * low_width, 0);
    std::vector<std::int32_t> predicted(low_width * low_width, 0);
    std::vector<std::int32_t> high(
        static_cast<std::size_t>(dimension) * dimension, 0);
    std::vector<std::int32_t> matrix(
        matrix_width * matrix_width, 0);

    if (parent.has_fragment(0U)) {
      std::size_t count = 0U;
      for (std::uint32_t y = 0U; y <= dimension; ++y) {
        for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
          low[static_cast<std::size_t>(y) * low_width + x] =
              parent.fragments[0].values[count++];
        }
      }
    }
    if (parent.has_fragment(1U)) {
      std::size_t count = triangle_vertex_count(dimension) - 1U;
      for (std::uint32_t y = 0U; y <= dimension; ++y) {
        for (std::uint32_t x = dimension - y; x <= dimension; ++x) {
          low[static_cast<std::size_t>(y) * low_width + x] =
              parent.fragments[1].values[count--];
        }
      }
    }

    if (!parent.has_fragment(0U)) {
      for (std::uint32_t y = 0U; y <= dimension; ++y) {
        for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
          low[static_cast<std::size_t>(y) * low_width + x] =
              low[static_cast<std::size_t>(dimension - x) * low_width +
                  dimension - y];
        }
      }
    } else if (!parent.has_fragment(1U)) {
      for (std::uint32_t y = 0U; y <= dimension; ++y) {
        for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
          low[static_cast<std::size_t>(dimension - x) * low_width +
              dimension - y] =
              low[static_cast<std::size_t>(y) * low_width + x];
        }
      }
    }

    for (std::uint32_t y = 0U; y <= dimension; ++y) {
      for (std::uint32_t x = 0U; x <= dimension; ++x) {
        const std::size_t index =
            static_cast<std::size_t>(y) * low_width + x;
        if (y == 0U || x == 0U || y == dimension || x == dimension) {
          predicted[index] = low[index];
          continue;
        }
        std::int32_t update = 0;
        if (!half_average4(
                detail.values[static_cast<std::size_t>(y - 1U) *
                                  dimension + x - 1U],
                detail.values[static_cast<std::size_t>(y - 1U) *
                                  dimension + x],
                detail.values[static_cast<std::size_t>(y) * dimension +
                              x - 1U],
                detail.values[static_cast<std::size_t>(y) * dimension + x],
                update) ||
            !checked_value(static_cast<std::int64_t>(low[index]) - update,
                           predicted[index])) {
          output = height_refinement();
          return hierarchy_status::arithmetic_overflow;
        }
      }
    }

    for (std::uint32_t y = 0U; y < dimension; ++y) {
      for (std::uint32_t x = 0U; x < dimension; ++x) {
        std::int32_t prediction = 0;
        const std::size_t index =
            static_cast<std::size_t>(y) * dimension + x;
        if (!predict(predicted, low_width, y, x, prediction) ||
            !checked_value(static_cast<std::int64_t>(detail.values[index]) +
                               prediction,
                           high[index])) {
          output = height_refinement();
          return hierarchy_status::arithmetic_overflow;
        }
      }
    }

    for (std::uint32_t y = 1U; y < dimension; ++y) {
      for (std::uint32_t x = 1U; x < dimension; ++x) {
        matrix[2U * static_cast<std::size_t>(y) * matrix_width + 2U * x] =
            predicted[static_cast<std::size_t>(y) * low_width + x];
      }
    }
    for (std::uint32_t y = 1U; y <= dimension; ++y) {
      for (std::uint32_t x = 1U; x <= dimension; ++x) {
        matrix[(2U * static_cast<std::size_t>(y) - 1U) * matrix_width +
               2U * x - 1U] =
            high[static_cast<std::size_t>(y - 1U) * dimension + x - 1U];
      }
    }

    const std::size_t bottom =
        2U * static_cast<std::size_t>(dimension) * matrix_width +
        2U * dimension;
    if (parent.has_fragment(0U)) {
      const std::vector<std::int32_t>& values = parent.fragments[0].values;
      std::size_t count = 0U;
      for (std::uint32_t i = 0U; i <= dimension; ++i) {
        matrix[2U * static_cast<std::size_t>(i) * matrix_width] =
            values[count];
        matrix[2U * i] = values[i];
        if (!parent.has_fragment(1U)) {
          matrix[2U * static_cast<std::size_t>(dimension - i) *
                     matrix_width +
                 2U * dimension] = values[i];
          matrix[bottom - 2U * i] = values[count];
        }
        count += static_cast<std::size_t>(dimension) + 1U - i;
      }
    }
    if (parent.has_fragment(1U)) {
      const std::vector<std::int32_t>& values = parent.fragments[1].values;
      std::size_t count = 0U;
      for (std::uint32_t i = 0U; i <= dimension; ++i) {
        matrix[2U * static_cast<std::size_t>(dimension - i) *
                   matrix_width +
               2U * dimension] = values[count];
        matrix[bottom - 2U * i] = values[i];
        if (!parent.has_fragment(0U)) {
          matrix[2U * static_cast<std::size_t>(i) * matrix_width] =
              values[i];
          matrix[2U * i] = values[count];
        }
        count += static_cast<std::size_t>(dimension) + 1U - i;
      }
    }

    output.dimension = dimension;
    const std::size_t vertex_count = triangle_vertex_count(dimension);
    for (std::size_t parent_fragment = 0U; parent_fragment < 2U;
         ++parent_fragment) {
      if (!parent.has_fragment(parent_fragment)) {
        continue;
      }
      for (std::size_t child_index = 0U; child_index < 2U; ++child_index) {
        const std::size_t slot = 2U * parent_fragment + child_index;
        output.child_mask |= std::uint8_t(1U) << slot;
        height_fragment& child = output.children[slot];
        child.dimension = dimension;
        child.values.reserve(vertex_count);
        for (std::uint32_t y = 0U; y <= dimension; ++y) {
          for (std::uint32_t x = 0U; x <= dimension - y; ++x) {
            child.values.push_back(matrix[matrix_index(
                dimension, matrix_width, y, x, parent_fragment,
                child_index)]);
          }
        }
      }
    }
#if !defined(TERRA_SDK_NO_EXCEPTIONS)
  } catch (const std::bad_alloc&) {
    output = height_refinement();
    return hierarchy_status::resource_limit;
  }
#endif
  return hierarchy_status::ok;
}

const char* hierarchy_status_message(hierarchy_status status) {
  switch (status) {
    case hierarchy_status::ok:
      return "ok";
    case hierarchy_status::invalid_shape:
      return "invalid hierarchy patch shape";
    case hierarchy_status::missing_fragment:
      return "height diamond has no usable fragment";
    case hierarchy_status::resource_limit:
      return "height hierarchy exceeds resource limit";
    case hierarchy_status::arithmetic_overflow:
      return "height hierarchy arithmetic overflow";
  }
  return "unknown hierarchy status";
}

}  // namespace codec
}  // namespace terra
