#ifndef TERRA_BENCHMARK_TERRAIN_REPLAY_HPP
#define TERRA_BENCHMARK_TERRAIN_REPLAY_HPP

#include <terra/codec/cbdam_height.hpp>
#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/frame/camera.hpp>
#include <terra/frame/lod.hpp>
#include <terra/frame/mesh.hpp>
#include <terra/frame/surface_mesh.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>


// Shared fixture transport and SDK height reconstruction. Desktop drivers decode
// the same encoded records with the original desktop codec instead. No LOD
// selection algorithm lives in this helper.
namespace terra_benchmark {
using key = std::pair<std::size_t, terra::core::grid_point>;
using clock_type = std::chrono::steady_clock;
using terra::frame::lod_patch;

inline double elapsed(clock_type::time_point start) {
  return std::chrono::duration<double, std::milli>(clock_type::now() - start).count();
}
inline void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
inline key identity(const lod_patch& patch) { return {patch.level, patch.id}; }
inline terra::core::grid_diamond diamond(const lod_patch& patch) {
  return {patch.corners[0], patch.corners[1], patch.corners[2], patch.corners[3]};
}
inline bool valid_fragment(const terra::core::grid_diamond& value, std::size_t fragment) {
  const auto& point = value.corner(2U * fragment + 1U);
  return std::all_of(point.begin(), point.end(), [](std::int32_t v) {
    return v >= terra::core::grid_coordinate_min && v <= terra::core::grid_coordinate_max;
  });
}
inline void write_key(const key& value) {
  std::cout << '[' << value.first;
  for (const auto coordinate : value.second) std::cout << ',' << coordinate;
  std::cout << ']';
}

struct height_data {
  terra::codec::height_diamond samples;
  terra::core::grid_diamond geometry;
  std::uint8_t refined_mask = 0U;
};

struct data_source {
  std::uint32_t dimension;
  double scale;
  std::map<key, height_data> heights;
  std::map<std::pair<unsigned, key>, terra::codec::height_patch> records;
  std::set<key> absent;
  std::set<key> inherited_absent;
  terra::frame::lod_resource_state state;
  std::size_t decoded_bytes = 0U, height_bytes = 0U, requested = 0U;
  double transport_ms = 0.0;
  static constexpr std::size_t safety_bytes = 512U * 1024U * 1024U;

  bool procedural(const key& k) const { return absent.count(k) || inherited_absent.count(k); }
  const terra::codec::height_patch* record(unsigned kind, const lod_patch& patch) {
    const auto k = identity(patch);
    if (kind == 2U && procedural(k)) return nullptr;
    const auto found = records.find({kind, k});
    if (found != records.end()) return &found->second;
    const auto transport_start = clock_type::now();
    std::cout << "{\"type\":\"request\",\"kind\":" << kind << ",\"key\":";
    write_key(k); std::cout << "}" << std::endl;
    ++requested;
    unsigned status = 0U;
    require(bool(std::cin >> status), "record input ended");
    if (status == 404U && kind == 2U) {
      transport_ms += elapsed(transport_start); absent.insert(k); return nullptr;
    }
    require(status == 200U, "missing, failed or uncaptured record; reference is incomplete");
    std::string path;
    std::size_t offset = 0U, count = 0U;
    require(bool(std::cin >> std::quoted(path) >> offset >> count), "invalid record input");
    transport_ms += elapsed(transport_start);
    const auto n = dimension + (kind == 1U ? 1U : 0U);
    require(count > 0U && count <= n * n * 16U + 4096U, "record exceeds encoded envelope");
    require(decoded_bytes + height_bytes + n * n * sizeof(std::int32_t) <= safety_bytes,
            "reference safety memory reached; not a precision result");
    std::vector<std::uint8_t> bytes(count);
    std::ifstream input(path, std::ios::binary);
    input.seekg(static_cast<std::streamoff>(offset));
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(count));
    require(bool(input), "cannot read complete record");
    terra::codec::height_patch decoded;
    require(terra::codec::decode_cbdam_height_record_patch(bytes.data(), bytes.size(), n, decoded) ==
        terra::codec::decode_status::ok, "invalid CBDAM record");
    decoded_bytes += decoded.values.size() * sizeof(std::int32_t);
    return &records.emplace(std::make_pair(kind, k), std::move(decoded)).first->second;
  }

  bool receive(const terra::frame::lod_cut& cut) {
    bool changed = false;
    for (const auto& request : cut.record_requests) {
      const auto k = identity(request.patch);
      const bool root = request.kind == terra::frame::lod_record_kind::root;
      const auto* input = record(root ? 1U : 2U, request.patch);
      auto found = heights.find(k);
      if (root) {
        if (found != heights.end()) continue;
        auto& value = heights[k]; value.geometry = diamond(request.patch);
        require(input && terra::codec::make_cbdam_root_height(*input, value.samples) ==
            terra::codec::hierarchy_status::ok, "cannot reconstruct root");
        changed = true;
        continue;
      }
      if (found == heights.end()) continue;
      auto& parent = found->second;
      if (parent.refined_mask == parent.samples.fragment_mask) continue;
      terra::codec::height_patch zero;
      if (!input) {
        zero.rows = zero.columns = dimension;
        zero.values.resize(dimension * dimension, 0);
        input = &zero;
      }
      terra::codec::height_refinement output;
      require(terra::codec::refine_cbdam_height(parent.samples, *input, output) ==
          terra::codec::hierarchy_status::ok, "cannot reconstruct detail");
      for (std::size_t f = 0U; f < 2U; ++f) for (std::size_t c = 0U; c < 2U; ++c) {
        if (!output.has_child(f, c)) continue;
        const auto child = parent.geometry.cylindrical_child_diamond(f, c);
        const key child_key{k.first + 1U, child.id()};
        const std::size_t fragment = child.corner(1U) == k.second ? 0U : 1U;
        auto& value = heights[child_key]; value.geometry = child;
        value.samples.dimension = dimension;
        value.samples.fragment_mask |= std::uint8_t(1U << fragment);
        value.samples.fragments[fragment] = std::move(output.children[2U * f + c]);
        bool inherited = true;
        for (std::size_t side = 0U; side < 2U; ++side) if (valid_fragment(child, side))
          inherited = inherited && procedural({k.first, child.parent_id(side)});
        if (inherited) inherited_absent.insert(child_key);
        else inherited_absent.erase(child_key);
      }
      parent.refined_mask = parent.samples.fragment_mask;
      changed = true;
    }
    if (!changed) return false;
    ++state.revision; ++state.height_revision;
    state.available_roots.clear(); state.available_details.clear(); state.height_ranges.clear();
    height_bytes = 0U;
    for (const auto& entry : heights) {
      const auto& value = entry.second;
      if (entry.first.first == 0U) state.available_roots.push_back({0U, entry.first.second});
      bool complete = value.refined_mask == value.samples.fragment_mask;
      double minimum = std::numeric_limits<double>::infinity(), maximum = -minimum;
      for (std::size_t f = 0U; f < 2U; ++f) {
        if (valid_fragment(value.geometry, f) && !value.samples.has_fragment(f)) complete = false;
        for (const auto sample : value.samples.fragments[f].values) {
          minimum = std::min(minimum, sample * scale); maximum = std::max(maximum, sample * scale);
        }
        height_bytes += value.samples.fragments[f].values.size() * sizeof(std::int32_t);
      }
      if (complete) state.available_details.push_back({entry.first.first, entry.first.second});
      if (minimum <= maximum) state.height_ranges.push_back({{entry.first.first, entry.first.second}, minimum, maximum});
    }
    require(decoded_bytes + height_bytes <= safety_bytes, "reference safety memory reached; not a precision result");
    return true;
  }
};

}  // namespace terra_benchmark
#endif
