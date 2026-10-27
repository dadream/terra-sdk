#include <terra/core/grid.hpp>

#include <vic/cbdam/base/grid_diamond.hpp>

#include <array>
#include <cstddef>
#include <iostream>
#include <string>

namespace {

bool same_point(const terra::core::grid_point& terra_point,
                const cbdam::grid_point_t& cbdam_point) {
  return terra_point[0] == cbdam_point[0] &&
         terra_point[1] == cbdam_point[1] &&
         terra_point[2] == cbdam_point[2];
}

bool compare_diamond(const terra::core::grid_diamond& terra_diamond,
                     const cbdam::grid_diamond& cbdam_diamond,
                     const std::string& path) {
  if (terra_diamond.is_valid() != cbdam_diamond.is_valid() ||
      !same_point(terra_diamond.id(), cbdam_diamond.id())) {
    std::cerr << "diamond identity mismatch at " << path << '\n';
    return false;
  }
  for (std::size_t corner = 0; corner < 4U; ++corner) {
    if (!same_point(terra_diamond.corner(corner),
                    cbdam_diamond.corner(static_cast<int>(corner)))) {
      std::cerr << "diamond corner mismatch at " << path << "/corner/"
                << corner << '\n';
      return false;
    }
  }
  for (std::size_t fragment = 0; fragment < 2U; ++fragment) {
    if (!same_point(terra_diamond.parent_id(fragment),
                    cbdam_diamond.parent_id(static_cast<int>(fragment)))) {
      std::cerr << "diamond parent mismatch at " << path << "/parent/"
                << fragment << '\n';
      return false;
    }
    for (std::size_t child = 0; child < 2U; ++child) {
      if (!same_point(
              terra_diamond.child_id(fragment, child),
              cbdam_diamond.child_id(static_cast<int>(fragment),
                                     static_cast<int>(child)))) {
        std::cerr << "diamond child id mismatch at " << path << "/child/"
                  << fragment << '/' << child << '\n';
        return false;
      }
    }
  }
  return true;
}

bool compare_branch(const terra::core::grid_diamond& terra_diamond,
                    const cbdam::grid_diamond& cbdam_diamond,
                    std::size_t level, std::size_t maximum_level,
                    const std::string& path) {
  if (!compare_diamond(terra_diamond, cbdam_diamond, path)) {
    return false;
  }
  if (level == maximum_level) {
    return true;
  }
  for (std::size_t fragment = 0; fragment < 2U; ++fragment) {
    for (std::size_t child = 0; child < 2U; ++child) {
      const std::string child_path =
          path + '/' + std::to_string(fragment) + '/' +
          std::to_string(child);
      if (!compare_branch(
              terra_diamond.cylindrical_child_diamond(fragment, child),
              cbdam_diamond.canonical_cylindrical_child_diamond(
                  static_cast<int>(fragment), static_cast<int>(child)),
              level + 1U, maximum_level, child_path)) {
        return false;
      }
    }
  }
  return true;
}

}  // namespace

int main() {
  const std::array<terra::core::grid_diamond, 8> terra_roots =
      terra::core::cylindrical_roots();
  for (std::size_t root = 0; root < terra_roots.size(); ++root) {
    const cbdam::grid_diamond cbdam_root =
        cbdam::grid_diamond::cylindrical_canonical_root(
            static_cast<int>(root));
    if (!compare_branch(terra_roots[root], cbdam_root, 0U, 7U,
                        "root/" + std::to_string(root))) {
      return 1;
    }
  }
  std::cout << "SDK parity passed: CBDAM cylindrical diamond keys"
            << std::endl;
  return 0;
}
