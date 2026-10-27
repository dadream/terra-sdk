#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

using properties = std::map<std::string, std::string>;

std::string fixed(double value) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(6) << value;
  return output.str();
}

template <typename value_t>
std::string text(value_t value) {
  std::ostringstream output;
  output << value;
  return output.str();
}

bool read_expected(const std::string& path, properties& result) {
  std::ifstream input(path.c_str());
  std::string line;
  while (std::getline(input, line)) {
    if (line.compare(0U, 4U, "lod.") != 0) {
      continue;
    }
    const std::size_t separator = line.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    result[line.substr(0U, separator)] = line.substr(separator + 1U);
  }
  return input.eof() && !result.empty();
}

properties describe(const terra::frame::camera_snapshot& camera) {
  const float thresholds[] = {0.010000F, 0.005000F, 0.002500F};
  properties result;
  result["lod.mode"] = "procedural_zero_residual";
  result["lod.threshold_count"] = "3";
  for (std::size_t threshold_index = 0U; threshold_index < 3U;
       ++threshold_index) {
    const terra::frame::lod_cut cut =
        terra::frame::select_procedural_cylindrical_lod(
            6378000.0, 64U, thresholds[threshold_index], camera);
    if (!cut.complete) {
      throw std::runtime_error("LOD selection exhausted its safety budget");
    }
    const std::string prefix =
        "lod.threshold." + text(threshold_index);
    result[prefix + ".value"] = fixed(thresholds[threshold_index]);
    result[prefix + ".graph_level_count"] = text(cut.graph_level_count);
    for (std::size_t level = 0U; level < cut.graph_level_count; ++level) {
      result[prefix + ".level." + text(level) + ".leaf_count"] =
          text(cut.leaf_count_by_level.at(level));
    }
    result[prefix + ".cut_count"] = text(cut.patches.size());
    for (std::size_t patch_index = 0U; patch_index < cut.patches.size();
         ++patch_index) {
      const terra::frame::lod_patch& patch = cut.patches[patch_index];
      const std::string patch_prefix =
          prefix + ".patch." + text(patch_index);
      result[patch_prefix + ".level"] = text(patch.level);
      result[patch_prefix + ".id"] =
          text(patch.id[0]) + "," + text(patch.id[1]) + "," +
          text(patch.id[2]);
      result[patch_prefix + ".visible"] =
          patch.visible ? "true" : "false";
      result[patch_prefix + ".priority"] = fixed(patch.priority);
    }
  }
  return result;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: terra_frame_lod_golden GOLDEN\n";
    return 2;
  }
  properties expected;
  if (!read_expected(argv[1], expected)) {
    std::cerr << "unable to read LOD golden\n";
    return 1;
  }
  const float y_fov = static_cast<float>(30.0 * (3.14 / 180.0));
  const terra::frame::globe_camera camera(
      static_cast<float>(6378000.0), 1280, 720, y_fov);
  const terra::frame::camera_snapshot snapshot = camera.snapshot();
  const terra::frame::lod_cut bounded =
      terra::frame::select_procedural_cylindrical_lod(
          6378000.0, 64U, 0.0F, snapshot, 40U, 8U);
  const terra::frame::lod_cut invalid =
      terra::frame::select_procedural_cylindrical_lod(
          std::numeric_limits<double>::quiet_NaN(), 64U, 0.01F, snapshot);
  terra::frame::lod_detail_key unavailable;
  unavailable.level = 0U;
  unavailable.id = {{0, 134217728, -134217728}};
  const std::vector<terra::frame::lod_detail_key> unavailable_details{
      unavailable};
  const terra::frame::lod_cut sparse =
      terra::frame::select_procedural_cylindrical_lod(
          6378000.0, 64U, 0.0025F, snapshot, 40U, 65536U,
          unavailable_details);
  const bool retained_parent = std::any_of(
      sparse.patches.begin(), sparse.patches.end(),
      [&unavailable](const terra::frame::lod_patch& patch) {
        return patch.level == unavailable.level &&
               patch.id == unavailable.id;
      });
  const bool requested_unavailable = std::any_of(
      sparse.record_requests.begin(), sparse.record_requests.end(),
      [&unavailable](const terra::frame::lod_record_request& request) {
        return request.kind == terra::frame::lod_record_kind::detail &&
               request.patch.level == unavailable.level &&
               request.patch.id == unavailable.id;
      });
  if (bounded.complete || bounded.patches.size() != 8U ||
      invalid.complete || !invalid.patches.empty() || !sparse.complete ||
      !retained_parent || requested_unavailable) {
    std::cerr << "LOD safety contract failed\n";
    return 1;
  }
  const properties actual = describe(snapshot);
  if (actual != expected) {
    for (const properties::value_type& entry : expected) {
      const properties::const_iterator found = actual.find(entry.first);
      if (found == actual.end() || found->second != entry.second) {
        std::cerr << "LOD mismatch at " << entry.first << ": expected "
                  << entry.second << ", actual "
                  << (found == actual.end() ? "<missing>" : found->second)
                  << '\n';
        break;
      }
    }
    std::cerr << "Expected keys: " << expected.size()
              << ", actual keys: " << actual.size() << '\n';
    return 1;
  }
  std::cout << "SDK golden passed: deterministic cylindrical LOD cuts\n";
  return 0;
}
