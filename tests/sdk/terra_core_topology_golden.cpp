#include <terra/core/grid.hpp>

#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

namespace {

using golden_map = std::map<std::string, std::string>;

golden_map read_golden(const std::string& path) {
  std::ifstream input(path.c_str());
  if (!input) {
    throw std::runtime_error("unable to open golden file: " + path);
  }
  golden_map values;
  std::string line;
  while (std::getline(input, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::string::size_type separator = line.find('=');
    if (separator == std::string::npos) {
      throw std::runtime_error("invalid golden line: " + line);
    }
    values[line.substr(0, separator)] = line.substr(separator + 1);
  }
  return values;
}

std::string format_point(const terra::core::grid_point& point) {
  return std::to_string(point[0]) + "," + std::to_string(point[1]) + "," +
         std::to_string(point[2]);
}

void expect(const golden_map& golden, const std::string& key,
            const std::string& actual) {
  const golden_map::const_iterator found = golden.find(key);
  if (found == golden.end()) {
    throw std::runtime_error("missing golden key: " + key);
  }
  if (found->second != actual) {
    throw std::runtime_error(key + ": expected " + found->second +
                             ", got " + actual);
  }
}

void check_diamond(const golden_map& golden, const std::string& prefix,
                   const terra::core::grid_diamond& diamond) {
  expect(golden, prefix + ".valid", diamond.is_valid() ? "true" : "false");
  expect(golden, prefix + ".id", format_point(diamond.id()));
  for (std::size_t i = 0; i < 2; ++i) {
    expect(golden, prefix + ".parent." + std::to_string(i),
           format_point(diamond.parent_id(i)));
  }
  for (std::size_t i = 0; i < 4; ++i) {
    expect(golden, prefix + ".corner." + std::to_string(i),
           format_point(diamond.corner(i)));
  }
  for (std::size_t parent = 0; parent < 2; ++parent) {
    for (std::size_t child = 0; child < 2; ++child) {
      expect(golden,
             prefix + ".child." + std::to_string(parent) + "." +
                 std::to_string(child),
             format_point(diamond.child_id(parent, child)));
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 2) {
      std::cerr << "usage: " << argv[0] << " <native_behavior_v1.txt>\n";
      return 2;
    }
    const golden_map golden = read_golden(argv[1]);
    const std::array<terra::core::grid_diamond, 8> roots =
        terra::core::cylindrical_roots();
    expect(golden, "topology.root_count", std::to_string(roots.size()));
    for (std::size_t i = 0; i < roots.size(); ++i) {
      check_diamond(golden, "topology.root." + std::to_string(i), roots[i]);
    }
    check_diamond(golden, "planar.topology.root", terra::core::planar_root());

    bool invalid_child_rejected = false;
    try {
      static_cast<void>(roots[0].child_id(0U, 2U));
    } catch (const std::out_of_range&) {
      invalid_child_rejected = true;
    }
    if (!invalid_child_rejected) {
      throw std::runtime_error("invalid grid child index was accepted");
    }

    std::cout << "Terra::core root topology matches the M2 golden.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
