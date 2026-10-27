#include <terra/c_api/terra.h>
#include <terra/frame/imagery.hpp>
#include "../../sdk/src/c_api/mesh_source.hpp"

#include "mesh_output.hpp"
#include "observed_allocations.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <set>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void require_status(terra_status actual, terra_status expected,
                    const char* operation) {
  if (actual != expected) {
    throw std::runtime_error(std::string(operation) + " returned status " +
                             std::to_string(actual) + ", expected " +
                             std::to_string(expected));
  }
}

void verify_rejected_record(terra_context* context, const terra_request_v1& request,
                            const std::vector<std::uint8_t>& bytes,
                            terra_status expected = TERRA_STATUS_DECODE_ERROR) {
  terra_stats_v1 before{};
  before.struct_size = sizeof(before);
  require_status(terra_get_stats(context, &before), TERRA_STATUS_OK, "read record rejection baseline");
  using namespace test_allocations;
  // Observe the C boundary itself, including codec temporaries. A malformed
  // record must not allocate either its advertised array or a valid first
  // patch before discovering an unwanted second patch.
  largest_allocation = 0U;
  measuring = true;
  const auto status = terra_submit_record(context, request.kind, &request.key,
                                          bytes.data(), bytes.size());
  measuring = false;
  const auto largest = largest_allocation;
  require_status(status, expected, "reject malformed terrain input");
  require(largest < 1024U, "rejected terrain shape allocated decoded payload before validation");
  terra_stats_v1 after{};
  after.struct_size = sizeof(after);
  require_status(terra_get_stats(context, &after), TERRA_STATUS_OK, "read rejected record state");
  require(after.loaded_patch_count == before.loaded_patch_count &&
          after.decoded_value_count == before.decoded_value_count,
          "shape rejection changed decoded terrain ownership");
}

void verify_duplicate_record(terra_context* context, const terra_request_v1& request,
                             const std::vector<std::uint8_t>& bytes) {
  terra_stats_v1 before{}; before.struct_size = sizeof(before);
  require_status(terra_get_stats(context, &before), TERRA_STATUS_OK, "duplicate baseline");
  test_allocations::allocations = 0U;
  test_allocations::measuring = true;
  const auto status = terra_submit_record(context, request.kind, &request.key, bytes.data(), bytes.size());
  test_allocations::measuring = false;
  require_status(status, TERRA_STATUS_OK, "valid duplicate");
  require(test_allocations::allocations == 0U, "duplicate terrain submission produced an unbudgeted decoded array");
  terra_stats_v1 after{}; after.struct_size = sizeof(after);
  require_status(terra_get_stats(context, &after), TERRA_STATUS_OK, "duplicate result");
  require(after.loaded_patch_count == before.loaded_patch_count && after.decoded_value_count == before.decoded_value_count,
          "duplicate submission changed retained record ownership");
  // Valid 65x65 envelope, but a truncated arithmetic stream. A cache hit
  // must still validate the body without allocating that advertised array.
  verify_rejected_record(context, request, {5, 0, 0, 0, 0x80, 65, 0, 0, 0});
}

std::vector<std::uint8_t> read_binary(const char* path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("unable to open patch fixture");
  }
  input.seekg(0, std::ios::end);
  const std::streamoff length = input.tellg();
  require(length > 0, "patch fixture is empty");
  input.seekg(0, std::ios::beg);
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  input.read(reinterpret_cast<char*>(result.data()), length);
  require(input.good(), "unable to read patch fixture");
  return result;
}

terra_terrain_manifest_v3 globe_manifest() {
  terra_terrain_manifest_v3 manifest{};
  manifest.struct_size = sizeof(manifest);
  manifest.api_version = TERRA_C_API_VERSION;
  manifest.format_version = 1U;
  manifest.patch_dimension = 64U;
  manifest.transform = TERRA_TRANSFORM_CYLINDRICAL;
  manifest.height_scale_factor = 0.001953125;
  manifest.minimum_u = -180.0;
  manifest.minimum_v = -90.0;
  manifest.maximum_u = 180.0;
  manifest.maximum_v = 90.0;
  manifest.radius = 6378000.0;
  return manifest;
}

terra_viewport_v1 default_viewport() {
  terra_viewport_v1 viewport{};
  viewport.struct_size = sizeof(viewport);
  viewport.width = 1280U;
  viewport.height = 720U;
  viewport.vertical_fov_radians = 30.0 * (3.14 / 180.0);
  return viewport;
}

void verify_paused_height_frontier(const std::vector<std::uint8_t>& root_record,
                                   const std::vector<std::uint8_t>& detail_record) {
  std::unique_ptr<terra_context, decltype(&terra_destroy)> owner(terra_create(), terra_destroy);
  auto* context = owner.get();
  require(context != nullptr, "height frontier context creation failed");
  auto manifest = globe_manifest();
  auto viewport = default_viewport();
  require_status(terra_load_terrain_manifest(context, &manifest), TERRA_STATUS_OK, "height frontier manifest");
  require_status(terra_set_viewport(context, &viewport), TERRA_STATUS_OK, "height frontier viewport");
  terra_update_budget_v2 budget{};
  budget.struct_size = sizeof(budget);
  budget.api_version = TERRA_UPDATE_API_VERSION;
  budget.maximum_priority_update_count = 65536U;
  terra_update_state_v2 progress{};
  progress.struct_size = sizeof(progress);
  const auto advance = [&]() {
    require_status(terra_advance_terrain(context, 0.0025F, &budget, &progress), TERRA_STATUS_OK,
                   "advance height frontier");
  };
  advance();
  std::size_t count = 0U;
  require_status(terra_get_requests(context, nullptr, 0U, &count), TERRA_STATUS_BUFFER_TOO_SMALL,
                 "height frontier requests");
  std::vector<terra_request_v1> requests(count);
  require_status(terra_get_requests(context, requests.data(), requests.size(), &count), TERRA_STATUS_OK,
                 "read height frontier requests");
  std::size_t roots = 0U, details = 0U;
  for (const auto& request : requests) {
    if (request.kind == TERRA_REQUEST_DETAIL && details != 0U) continue;
    const auto& bytes = request.kind == TERRA_REQUEST_ROOT ? root_record : detail_record;
    require_status(terra_submit_record(context, request.kind, &request.key, bytes.data(), bytes.size()),
                   TERRA_STATUS_OK, "height frontier data arrival");
    if (request.kind == TERRA_REQUEST_ROOT) ++roots; else ++details;
  }
  require(roots == 8U && details == 1U, "height frontier fixture lacks roots or refinement input");
  advance();
  const auto root_bytes = roots * 65U * 66U * sizeof(std::int32_t);
  require(progress.topology_change_count == 0U && progress.topology_node_count == roots,
          "paused height frontier changed topology");
  require(terra_height_payload_bytes(context) == root_bytes,
          "zero topology credit produced speculative child heights");
  require_status(terra_set_height_work_limit(context, 0U, 1U), TERRA_STATUS_OK, "pause height credit");
  advance();
  require(progress.height_build_count == 0U && terra_height_payload_bytes(context) == root_bytes,
          "paused height frontier kept producing payload");

  // Refinement first reconstructs its dependencies; the next model slice can
  // consume them. Pausing between those slices must make unused children
  // reclaimable without cancelling the underlying decoded request.
  budget.maximum_change_count = 32U;
  require_status(terra_set_height_work_limit(context, 32U * 1024U * 1024U, UINT32_MAX),
                 TERRA_STATUS_OK, "restore height credit");
  advance();
  require(progress.topology_change_count == 0U && terra_height_payload_bytes(context) > root_bytes,
          "resuming refinement did not build its height dependencies");
  budget.maximum_change_count = 0U;
  advance();
  require_status(terra_trim_height_cache(context, 0U), TERRA_STATUS_OK, "trim paused lookahead heights");
  require(terra_height_payload_bytes(context) == root_bytes,
          "paused refinement pinned speculative child heights");
  advance();
  require(progress.height_build_count == 0U && terra_height_payload_bytes(context) == root_bytes,
          "paused refinement regenerated reclaimed speculative heights");
  budget.maximum_change_count = 32U;
  advance();
  require(terra_height_payload_bytes(context) > root_bytes, "resume did not reuse retained detail input");
  advance();
  require(progress.topology_change_count > 0U && progress.topology_node_count > roots,
          "height lookahead pause prevented later topology refinement");
  const auto selected_nodes = progress.topology_node_count;
  budget.maximum_change_count = 0U;
  advance();
  require_status(terra_trim_height_cache(context, 0U), TERRA_STATUS_OK, "trim with selected descendants");
  const auto selected_bytes = terra_height_payload_bytes(context);
  require(selected_bytes > root_bytes, "paused cache trim removed selected-surface heights");
  advance();
  require(progress.topology_node_count == selected_nodes && progress.height_build_count == 0U &&
              terra_height_payload_bytes(context) == selected_bytes,
          "paused selected surface lost its required height dependencies");
}

template <typename value_t, typename reader_t>
void verify_readback(const terra_context* context, reader_t read,
                     terra_status null_context_status = TERRA_STATUS_INVALID_ARGUMENT) {
  std::size_t count = 0U;
  require_status(read(context, nullptr, 0U, &count), TERRA_STATUS_BUFFER_TOO_SMALL,
                 "size nonempty readback fixture");
  require(count > 1U, "readback allocation fixture is empty");
  const auto expected_count = count;
  std::vector<value_t> values(count + 1U);
  require_status(read(context, values.data(), count, &count), TERRA_STATUS_OK,
                 "prime readback fixture");
  std::vector<unsigned char> expected(values.size() * sizeof(value_t));
  std::memcpy(expected.data(), values.data(), expected.size());
  // Destination storage and the existing last-error string are caller/context
  // owned. Neither sizing, rejection nor repeated reads may clone the payload.
  using namespace test_allocations;
  live_bytes = peak_bytes = allocations = largest_allocation = 0U;
  measuring = true;
  const auto sizing = read(context, nullptr, 0U, &count);
  const auto short_buffer = read(context, values.data(), count - 1U, &count);
  const auto missing_buffer = read(context, nullptr, count, &count);
  const auto missing_count = read(context, values.data(), count, nullptr);
  const auto missing_context = read(nullptr, values.data(), count, &count);
  const bool rejected_unchanged = std::memcmp(values.data(), expected.data(), expected.size()) == 0;
  const auto first = read(context, values.data(), count, &count);
  const auto repeated = read(context, values.data(), count, &count);
  measuring = false;
  std::fprintf(stderr, "readback payload=%zu allocations=%zu peak=%zu\n",
               expected_count * sizeof(value_t), allocations, peak_bytes);
  require(allocations == 0U && peak_bytes == 0U && live_bytes == 0U,
          "C ABI readback allocated a payload copy");
  require(sizing == TERRA_STATUS_BUFFER_TOO_SMALL && short_buffer == sizing && missing_buffer == sizing &&
              missing_count == TERRA_STATUS_INVALID_ARGUMENT && missing_context == null_context_status &&
              first == TERRA_STATUS_OK && repeated == first && count == expected_count && rejected_unchanged &&
              std::memcmp(values.data(), expected.data(), expected.size()) == 0,
          "C ABI readback changed sizing, output, sentinel or rejection semantics");
}

void verify_height_ownership_readback(terra_context* context) {
  terra_update_state_v2 before{};
  before.struct_size = sizeof(before);
  require_status(terra_get_update_state(context, &before), TERRA_STATUS_OK, "height ownership baseline");
  require(before.height_bytes > 0U, "height ownership fixture has no samples");
  auto first = before, second = before;
  using namespace test_allocations;
  allocations = 0U;
  measuring = true;
  const auto a = terra_get_update_state(context, &first);
  const auto b = terra_get_update_state(context, &second);
  measuring = false;
  require(a == TERRA_STATUS_OK && b == TERRA_STATUS_OK && first.height_bytes == before.height_bytes &&
          second.height_bytes == before.height_bytes, "ownership readback changed live height bytes");
  require(allocations == 0U, "height ownership readback allocated a cache-deduplication container");
}

void verify_imagery_readback(terra_context* context) {
  require(terra_imagery_payload_bytes(context) == 0U, "unopened imagery owns payload");
  std::uint32_t session = 0U, candidate = 0U, refused = 99U;
  require_status(terra_open_imagery(context, &session), TERRA_STATUS_OK, "open displayed imagery session");
  require_status(terra_open_imagery(context, &candidate), TERRA_STATUS_OK, "open candidate imagery session");
  require(session && candidate && session != candidate, "imagery sessions alias");
  const auto empty_session_bytes = terra_imagery_payload_bytes(context);
  require(empty_session_bytes > 0U, "empty session state was not accounted");
  require_status(terra_open_imagery(context, &refused), TERRA_STATUS_RESOURCE_LIMIT, "bound concurrent planners");
  require(refused == 99U, "refused session wrote output");
  terra_imagery_options_v4 options{};
  options.struct_size = sizeof(options); options.api_version = TERRA_C_API_VERSION;
  options.tile_size = 256U; options.maximum_level = options.source_maximum_level = 6U;
  options.source_root_columns = 4U; options.source_root_rows = 2U;
  options.requested_pixel_error = 1.0;
  options.maximum_texture_count = options.maximum_draw_count = 4096U;
  terra_imagery_surface_v3 surface{};
  surface.struct_size = sizeof(surface); surface.region_count = 1U;
  terra_imagery_region_v4 region{};
  region.maximum_u = region.maximum_v = 1.0; region.pixels_per_uv = 16384.0;
  require_status(terra_plan_imagery(context, session, &options, &surface, 1U, &region, 1U, nullptr, 0U, terra_imagery_input_work_bytes(1U, 1U, 1U, 0U)),
                 TERRA_STATUS_OK, "plan large imagery readback fixture");
  require(terra_imagery_payload_bytes(context) > empty_session_bytes, "imagery tree/output capacity is unowned");
  test_allocations::allocations = 0U;
  test_allocations::measuring = true;
  const auto bytes = terra_imagery_payload_bytes(context);
  const auto repeated_bytes = terra_imagery_payload_bytes(context);
  test_allocations::measuring = false;
  require(bytes == repeated_bytes && !test_allocations::allocations,
          "imagery ownership readback rescanned or allocated containers");
  std::size_t output_count = 0U;
  require_status(terra_get_imagery_draws(context, session, 0U, nullptr, 0U, &output_count),
      TERRA_STATUS_OK, "size immutable imagery snapshot");
  require(output_count > 256U, "imagery range fixture is too small");
  std::vector<terra_imagery_draw_v3> expected(output_count), actual(output_count);
  for (unsigned pass = 0U; pass < 2U; ++pass) {
    auto& values = pass ? actual : expected;
    test_allocations::allocations = 0U;
    test_allocations::measuring = true;
    for (std::size_t first = 0U; first < output_count; first += 256U) {
      std::size_t count = 0U;
      require_status(terra_get_imagery_draws(context, session, first, values.data() + first,
          std::min<std::size_t>(256U, output_count - first), &count), TERRA_STATUS_OK, "read imagery range");
      require(count == std::min<std::size_t>(256U, output_count - first), "imagery range length changed");
    }
    test_allocations::measuring = false;
    require(test_allocations::allocations == 0U, "imagery range conversion allocated a duplicate array");
  }
  require(std::memcmp(expected.data(), actual.data(), output_count * sizeof(expected[0])) == 0,
      "immutable imagery range readback changed");
  require_status(terra_get_imagery_draws(context, session, 0U, actual.data(), 257U, &output_count),
      TERRA_STATUS_INVALID_ARGUMENT, "bound imagery readback work");
  region.pixels_per_uv = 64.0;
  std::vector<terra_imagery_region_v4> many(16384U, region);
  surface.region_count = many.size();
  const auto prior_input = terra_imagery_input_payload_bytes(context);
  const auto input_quote = terra_imagery_input_work_bytes(1U, 1U, many.size(), 0U);
  terra_imagery_quality_v4 retained{}; retained.struct_size = sizeof(retained);
  require_status(terra_get_imagery_quality(context, session, &retained), TERRA_STATUS_OK, "retain input refusal output");
  test_allocations::largest_allocation = 0U;
  test_allocations::measuring = true;
  const auto refused_input = terra_begin_imagery(context, session, &options, &surface, 1U,
      many.data(), many.size(), nullptr, 0U, input_quote - 1U);
  test_allocations::measuring = false;
  require_status(refused_input, TERRA_STATUS_RESOURCE_LIMIT, "refuse underfunded imagery input");
  require(test_allocations::largest_allocation < 1024U && terra_imagery_input_payload_bytes(context) == prior_input,
          "input refusal allocated conversion arrays or changed ownership");
  terra_imagery_quality_v4 after_refusal{}; after_refusal.struct_size = sizeof(after_refusal);
  require_status(terra_get_imagery_quality(context, session, &after_refusal), TERRA_STATUS_OK, "read retained refusal output");
  require(retained.draw_revision == after_refusal.draw_revision, "input refusal changed published cut");
  const terra_imagery_surface_v3 repeated[] = {surface, surface};
  require_status(terra_begin_imagery(context, session, &options, repeated, 2U,
      many.data(), many.size(), nullptr, 0U, terra_imagery_input_work_bytes(2U, 2U, many.size(), 0U)),
      TERRA_STATUS_RESOURCE_LIMIT, "price repeated input ranges independently");
  require(terra_imagery_input_work_bytes(UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX) == UINT32_MAX,
          "input quote wrapped integer capacity");
  require_status(terra_stage_imagery_input(context, session, &options, 1U, 1U, many.size(), 0U, input_quote - 1U, 1U),
      TERRA_STATUS_RESOURCE_LIMIT, "reject underfunded input stage before history reset");
  require(terra_imagery_input_payload_bytes(context) == prior_input, "stage refusal changed residency");
  for (bool cancel : {true, false}) {
    require_status(terra_stage_imagery_input(context, session, &options, 1U, 1U, many.size(), 0U, input_quote, 0U),
        TERRA_STATUS_OK, "stage bounded imagery conversion");
    require_status(terra_append_imagery_surface(context, session, &surface), TERRA_STATUS_OK, "append declared surface");
    // Staging now builds the final canonical owner. State and its shared control
    // allocation are real payload too; the quote also funds the commit registry.
    const auto staged_arrays = sizeof(terra::frame::imagery_surface) +
        many.size() * sizeof(terra::frame::measurement_region);
    require(terra_imagery_input_payload_bytes(context) > prior_input + staged_arrays &&
        terra_imagery_input_payload_bytes(context) <= prior_input + input_quote,
        "staged arrays did not retain old/new ownership");
    require_status(terra_commit_imagery_input(context, session, 1U), TERRA_STATUS_INVALID_STATE, "reject incomplete stage");
    require_status(terra_append_imagery_regions(context, session, many.data(), 257U),
        TERRA_STATUS_INVALID_ARGUMENT, "reject unbounded conversion batch");
    const std::size_t copied = cancel ? 256U : many.size();
    for (std::size_t first = 0U; first < copied; first += 256U)
      require_status(terra_append_imagery_regions(context, session, many.data() + first, 256U),
          TERRA_STATUS_OK, "convert bounded region batch");
    require_status(terra_get_imagery_quality(context, session, &after_refusal), TERRA_STATUS_OK, "read old cut during staging");
    require(after_refusal.draw_revision == retained.draw_revision, "partial input replaced the old cut");
    if (cancel) {
      require_status(terra_cancel_imagery_input(context, session), TERRA_STATUS_OK, "cancel converted input");
      require(terra_imagery_input_payload_bytes(context) == prior_input, "cancelled stage retained input arrays");
      require_status(terra_append_imagery_regions(context, session, many.data(), 1U),
          TERRA_STATUS_INVALID_STATE, "reject cancelled input continuation");
    } else require_status(terra_commit_imagery_input(context, session, 1U), TERRA_STATUS_OK, "commit converted input once");
  }
  many.front().pixels_per_uv = 4096.0;
  many.clear();
  std::uint32_t complete = 1U;
  require_status(terra_step_imagery(context, session, 1U, 1U, 0.0, UINT32_MAX, UINT32_MAX, &complete), TERRA_STATUS_OK,
                 "continue imagery normalization");
  terra_imagery_quality_v4 quality{};
  quality.struct_size = sizeof(quality);
  require_status(terra_get_imagery_quality(context, session, &quality), TERRA_STATUS_OK, "read pending imagery quality");
  std::size_t count = 1U;
  require_status(terra_get_imagery_draws(context, session, 0U, nullptr, 0U, &count), TERRA_STATUS_OK, "read pending imagery draws");
  require(!complete && (quality.limit_flags & 96U) == 96U && count == 0U,
          "C ABI exposed an incomplete input as usable image demand");
  // A candidate may initialize, accept, reset and close while the displayed
  // session is halfway through normalization. Its partial result must not move.
  const auto held = quality;
  require(terra_sizeof_imagery_quality_v4() == 56U && held.draw_revision > 0U,
          "immutable imagery output has no ABI identity");
  auto next_surface = surface; next_surface.region_count = 1U;
  auto next_region = region; next_region.pixels_per_uv = 512.0;
  require_status(terra_plan_imagery(context, candidate, &options, &next_surface, 1U, &next_region, 1U, nullptr, 0U, terra_imagery_input_work_bytes(1U, 1U, 1U, 0U)),
      TERRA_STATUS_OK, "plan isolated candidate");
  require_status(terra_accept_imagery(context, candidate, nullptr, 0U, 42U), TERRA_STATUS_OK, "accept isolated candidate");
  require_status(terra_reset_imagery(context, candidate), TERRA_STATUS_OK, "reset isolated candidate");
  require_status(terra_close_imagery(context, candidate), TERRA_STATUS_OK, "close isolated candidate");
  const auto stale = candidate;
  require_status(terra_open_imagery(context, &candidate), TERRA_STATUS_OK, "reuse free session slot");
  require(candidate != stale, "session ID was reused");
  require_status(terra_reset_imagery(context, stale), TERRA_STATUS_INVALID_STATE, "reject stale session reset");
  require_status(terra_close_imagery(context, stale), TERRA_STATUS_INVALID_STATE, "reject stale session close");
  std::uint32_t unchanged = 99U;
  require_status(terra_step_imagery(context, stale, 1U, 1U, 0.0, UINT32_MAX, UINT32_MAX, &unchanged),
      TERRA_STATUS_INVALID_STATE, "reject stale session continuation");
  require(unchanged == 99U, "stale session wrote completion");
  require_status(terra_get_imagery_quality(context, session, &quality), TERRA_STATUS_OK, "read preserved session");
  require(std::memcmp(&held, &quality, sizeof(held)) == 0, "candidate work changed displayed session output");
  for (unsigned round = 0U; !complete && round < 1024U; ++round) {
    require_status(terra_step_imagery(context, session, 1U, 1U, 0.0, UINT32_MAX, UINT32_MAX, &complete), TERRA_STATUS_OK,
                   "finish imagery normalization");
    require_status(terra_get_imagery_quality(context, session, &quality), TERRA_STATUS_OK, "read continued identity");
    if (!quality.draw_count) require(quality.draw_revision == held.draw_revision,
        "normalization republished unchanged output");
  }
  require_status(terra_get_imagery_quality(context, session, &quality), TERRA_STATUS_OK, "read initialized imagery quality");
  require(complete && !(quality.limit_flags & 96U) && quality.maximum_pixel_error == 0.25,
          "deferred initialization borrowed changed caller input or failed to finish");
  require(quality.draw_revision > held.draw_revision, "new cut retained the empty output revision");
  const auto retained_bytes = terra_imagery_input_payload_bytes(context);
  const auto member_quote = terra_imagery_input_work_bytes(1U, 0U, 0U, 0U);
  require(member_quote < 1024U && terra_imagery_input_work_bytes(1U, 2U, 0U, 0U) == UINT32_MAX,
      "retained member quote copied payload or accepted impossible input counts");
  for (bool cancel : {true, false}) {
    require_status(terra_stage_imagery_input(context, session, &options, 1U, 0U, 0U, 0U, member_quote - 1U, 0U),
        TERRA_STATUS_RESOURCE_LIMIT, "reject underfunded retained membership");
    require_status(terra_stage_imagery_input(context, session, &options, 1U, 0U, 0U, 0U, member_quote, 0U),
        TERRA_STATUS_OK, "stage retained membership");
    require_status(terra_append_retained_imagery_surface(context, session, UINT32_MAX, 91U),
        TERRA_STATUS_NOT_FOUND, "reject missing retained input");
    require_status(terra_append_imagery_surface(context, session, &surface),
        TERRA_STATUS_INVALID_ARGUMENT, "retention credit cannot produce new payload");
    require_status(terra_append_retained_imagery_surface(context, session, surface.draw_index, 91U),
        TERRA_STATUS_OK, "rebind immutable measurement to a new draw position");
    require(terra_imagery_input_payload_bytes(context) > retained_bytes + sizeof(terra::frame::imagery_surface) &&
        terra_imagery_input_payload_bytes(context) <= retained_bytes + member_quote,
        "retention copied or double-counted numeric input");
    if (cancel) {
      require_status(terra_cancel_imagery_input(context, session), TERRA_STATUS_OK, "cancel input retention");
      require(terra_imagery_input_payload_bytes(context) == retained_bytes, "retention cancellation released the active input");
    } else {
      require_status(terra_commit_imagery_input(context, session, 1U), TERRA_STATUS_OK, "commit retained member");
      complete = 0U;
      for (unsigned i = 0U; !complete && i < 4U; ++i)
        require_status(terra_step_imagery(context, session, 1U, 1U, 0.0, UINT32_MAX, UINT32_MAX, &complete),
            TERRA_STATUS_OK, "advance retained normalization");
      require(complete && terra_imagery_input_payload_bytes(context) == retained_bytes,
          "retained member repeated normalization or allocated another payload");
      terra_imagery_draw_v3 rebound{}; std::size_t rebound_count = 0U;
      require_status(terra_get_imagery_draws(context, session, 0U, &rebound, 1U, &rebound_count),
          TERRA_STATUS_OK, "read rebound imagery draw");
      require(rebound_count == 1U && rebound.draw_index == 91U, "retained input reused the old draw index");
    }
  }
  const auto repeated_members = terra_imagery_input_work_bytes(65U, 0U, 0U, 0U);
  require_status(terra_stage_imagery_input(context, session, &options, 65U, 0U, 0U, 0U, repeated_members, 0U),
      TERRA_STATUS_OK, "stage repeated retained members");
  for (std::uint32_t i = 0U; i < 64U; ++i)
    require_status(terra_append_retained_imagery_surface(context, session, 91U, i),
        TERRA_STATUS_OK, "retain within total region shape");
  require_status(terra_append_retained_imagery_surface(context, session, 91U, 64U),
      TERRA_STATUS_INVALID_ARGUMENT, "retained members cannot exceed total region shape");
  require_status(terra_cancel_imagery_input(context, session), TERRA_STATUS_OK, "cancel repeated members");
  require(terra_imagery_input_payload_bytes(context) == retained_bytes, "rejected shape retained staged membership");
  const auto completed_revision = quality.draw_revision;
  require_status(terra_reset_imagery(context, session), TERRA_STATUS_OK, "reset output identity");
  require_status(terra_plan_imagery(context, session, &options, &next_surface, 1U, &region, 1U, nullptr, 0U, terra_imagery_input_work_bytes(1U, 1U, 1U, 0U)),
      TERRA_STATUS_OK, "replace reset output");
  require_status(terra_get_imagery_quality(context, session, &quality), TERRA_STATUS_OK, "read reset identity");
  require(quality.draw_revision > completed_revision, "reset reused a published output revision");
  require_status(terra_close_imagery(context, candidate), TERRA_STATUS_OK, "close candidate session");
  require_status(terra_close_imagery(context, session), TERRA_STATUS_OK, "close displayed session");
  require(terra_imagery_payload_bytes(context) == 0U, "closed imagery sessions retained allocation ownership");
  require(terra_imagery_input_payload_bytes(context) == 0U, "closed imagery retained input credit");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr << "usage: terra_c_api_contract ROOT0 DETAIL0 ROOT3 DETAIL3 CHILD_DETAIL\n";
    return 2;
  }
  try {
    {
      std::unique_ptr<terra_context, decltype(&terra_destroy)> capacity(terra_create(), terra_destroy);
      require(bool(capacity), "capacity context allocation failed");
      const std::uint32_t default_mesh = 32U * 1024U * 1024U;
      require(terra_set_record_work_limit(capacity.get(), default_mesh) == TERRA_STATUS_OK &&
          terra_set_height_work_limit(capacity.get(), 2U * default_mesh, 1U) == TERRA_STATUS_OK &&
          terra_set_record_work_limit(capacity.get(), default_mesh + 1U) == TERRA_STATUS_INVALID_ARGUMENT,
          "native default terrain capacity differs from the public profile");
      const std::uint32_t mesh = 2U * default_mesh;
      require(terra_configure_terrain_capacity(capacity.get(), 0U) == TERRA_STATUS_INVALID_ARGUMENT &&
          terra_configure_terrain_capacity(capacity.get(), UINT32_MAX) == TERRA_STATUS_INVALID_ARGUMENT,
          "invalid capacity was accepted");
      require(terra_configure_terrain_capacity(capacity.get(), mesh) == TERRA_STATUS_OK &&
          terra_set_record_work_limit(capacity.get(), mesh) == TERRA_STATUS_OK &&
          terra_set_height_work_limit(capacity.get(), 2U * mesh, 1U) == TERRA_STATUS_OK,
          "instance capacity did not reach record/height production");
      require(terra_set_record_work_limit(capacity.get(), mesh + 1U) == TERRA_STATUS_INVALID_ARGUMENT &&
          terra_set_height_work_limit(capacity.get(), 2U * mesh + 1U, 1U) == TERRA_STATUS_INVALID_ARGUMENT,
          "production accepted credit beyond the configured ceiling");
      auto manifest = globe_manifest();
      require(terra_load_terrain_manifest(capacity.get(), &manifest) == TERRA_STATUS_OK &&
          terra_set_terrain_mesh_budget(capacity.get(), mesh) == TERRA_STATUS_OK,
          "configured terrain mesh ceiling was ignored");
      require(terra_configure_terrain_capacity(capacity.get(), mesh) == TERRA_STATUS_OK &&
          terra_configure_terrain_capacity(capacity.get(), mesh / 2U) == TERRA_STATUS_INVALID_STATE &&
          terra_set_terrain_mesh_budget(capacity.get(), mesh + 1U) == TERRA_STATUS_INVALID_ARGUMENT,
          "live terrain capacity was changed");
      require(terra_load_terrain_manifest(capacity.get(), &manifest) == TERRA_STATUS_OK &&
          terra_set_terrain_mesh_budget(capacity.get(), mesh) == TERRA_STATUS_OK &&
          terra_set_record_work_limit(capacity.get(), mesh) == TERRA_STATUS_OK &&
          terra_set_height_work_limit(capacity.get(), 2U * mesh, 1U) == TERRA_STATUS_OK,
          "manifest reset discarded the configured capacity");
    }
    require(terra_abi_version() == TERRA_C_API_VERSION,
            "ABI version changed");
    require(terra_sizeof_terrain_manifest_v3() == sizeof(terra_terrain_manifest_v3) &&
                terra_sizeof_viewport_v1() == sizeof(terra_viewport_v1) &&
                terra_sizeof_camera_v3() == sizeof(terra_camera_v3) &&
                terra_sizeof_camera_snapshot_v1() ==
                    sizeof(terra_camera_snapshot_v1) &&
                terra_sizeof_patch_key_v1() == sizeof(terra_patch_key_v1) &&
                terra_sizeof_texture_node_v3() ==
                    sizeof(terra_texture_node_v3) &&
                terra_sizeof_request_v1() == sizeof(terra_request_v1) &&
                terra_sizeof_patch_decision_v1() ==
                    sizeof(terra_patch_decision_v1) &&
                terra_sizeof_draw_range_v1() ==
                    sizeof(terra_draw_range_v1) &&
                terra_sizeof_frame_v1() == sizeof(terra_frame_v1) &&
                terra_sizeof_stats_v1() == sizeof(terra_stats_v1),
            "ABI size query changed");

    terra_context* context = terra_create();
    require(context != nullptr, "terra_create failed");

    require_status(terra_set_globe_target(context, 0.0, 0.0),
                   TERRA_STATUS_INVALID_STATE,
                   "globe target before manifest");

    require_status(terra_update(context, 0.0025F),
                   TERRA_STATUS_INVALID_STATE,
                   "update before configuration");
    std::size_t error_size = 0U;
    require_status(terra_get_last_error(context, nullptr, 0U, &error_size),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "last error sizing");
    std::vector<char> error(error_size);
    require_status(terra_get_last_error(context, error.data(), error.size(),
                                        &error_size),
                   TERRA_STATUS_OK, "last error read");
    require(std::string(error.data()).find("manifest and viewport") !=
                std::string::npos,
            "last error detail changed");

    terra_terrain_manifest_v3 obsolete = globe_manifest();
    obsolete.api_version = 3;
    require_status(terra_load_terrain_manifest(context, &obsolete), TERRA_STATUS_UNSUPPORTED,
                   "ABI 12 rejects obsolete manifest versions");
    obsolete.api_version = TERRA_C_API_VERSION;
    obsolete.struct_size -= 8;
    require_status(terra_load_terrain_manifest(context, &obsolete), TERRA_STATUS_INVALID_ARGUMENT,
                   "ABI 12 requires its complete terrain descriptor");

    terra_terrain_manifest_v3 manifest = globe_manifest();
    require_status(terra_set_record_work_limit(context, 64U * 64U * 4U - 1U), TERRA_STATUS_OK, "short zero credit");
    require_status(terra_load_terrain_manifest(context, &manifest), TERRA_STATUS_RESOURCE_LIMIT, "reject uncredited zero input");
    require(terra_record_payload_bytes(context) == 0U, "zero credit refusal produced payload");
    require_status(terra_set_record_work_limit(context, 64U * 64U * 4U), TERRA_STATUS_OK, "exact zero credit");
    require_status(terra_load_terrain_manifest(context, &manifest), TERRA_STATUS_OK,
                   "load manifest");
    require(terra_record_payload_bytes(context) == 64U * 64U * 4U, "procedural input ownership receipt mismatch");
    terra_viewport_v1 viewport = default_viewport();
    require_status(terra_set_viewport(context, &viewport), TERRA_STATUS_OK,
                   "set viewport");
    terra_camera_snapshot_v1 snapshot{};
    snapshot.struct_size = sizeof(snapshot);
    require_status(terra_get_camera_snapshot(context, &snapshot),
                   TERRA_STATUS_OK, "get camera snapshot before update");
    require(snapshot.api_version == TERRA_C_API_VERSION &&
                std::isfinite(snapshot.camera_position[0]) &&
                std::isfinite(snapshot.camera_position[1]) &&
                std::isfinite(snapshot.camera_position[2]),
            "camera snapshot is invalid");
    require_status(terra_update(context, 0.005F), TERRA_STATUS_OK,
                   "initial update");
    verify_readback<std::uint16_t>(context, terra_get_index_buffer);
    verify_readback<terra_patch_decision_v1>(context, terra_get_frame_patches);
    verify_readback<terra_request_v1>(context, terra_get_requests);
    verify_imagery_readback(context);

    terra_frame_v1 frame{};
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get frame");
    require(frame.sequence == 1U && frame.decisions_complete == 0U &&
                frame.patch_count == 8U && frame.request_count >= 8U &&
                frame.request_count <= 16U &&
                frame.loaded_patch_count == 0U && frame.draw_count == 0U &&
                frame.expected_draw_count > 0U &&
                frame.omitted_draw_count == frame.expected_draw_count &&
                frame.coverage_draw_count == 0U &&
                frame.coverage_complete == 0U,
            "initial frame counts changed");
    require(std::isfinite(frame.camera_position[0]) &&
                std::isfinite(frame.camera_position[1]) &&
                std::isfinite(frame.camera_position[2]),
            "camera position is invalid");

    for (std::size_t index = 0U; index < 3U; ++index) {
      require(snapshot.camera_position[index] ==
                  frame.camera_position[index],
              "camera snapshot position differs from frame");
    }
    for (std::size_t index = 0U; index < 16U; ++index) {
      require(snapshot.projection_view[index] ==
                  frame.projection_view[index],
              "camera snapshot matrix differs from frame");
    }

    std::size_t index_count = 0U;
    require_status(terra_get_index_buffer(context, nullptr, 0U,
                                          &index_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "index sizing");
    require(index_count == 4413U, "index sizing count changed");
    std::vector<std::uint16_t> indices(index_count);
    require_status(terra_get_index_buffer(context, indices.data(),
                                          indices.size(), &index_count),
                   TERRA_STATUS_OK, "get index buffer");
    require(*std::max_element(indices.begin(), indices.end()) == 2144U,
            "index vertex range changed");
    std::size_t nondegenerate = 0U;
    for (std::size_t index = 2U; index < indices.size(); ++index) {
      const std::uint16_t a = indices[index - 2U];
      const std::uint16_t b = indices[index - 1U];
      const std::uint16_t c = indices[index];
      if (a != b && b != c && a != c) {
        ++nondegenerate;
      }
    }
    require(nondegenerate == 4096U,
            "index triangle topology changed");

    std::size_t patch_count = 0U;
    require_status(terra_get_frame_patches(context, nullptr, 0U,
                                           &patch_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "patch sizing");
    require(patch_count == 8U, "patch sizing count changed");
    std::vector<terra_patch_decision_v1> patches(patch_count);
    require_status(terra_get_frame_patches(context, patches.data(),
                                           patches.size(), &patch_count),
                   TERRA_STATUS_OK, "get patches");
    require(patches.front().key.level == 0U &&
                patches.front().key.i == 0 &&
                patches.front().key.j == 134217728 &&
                patches.front().key.k == 134217728 &&
                patches.front().visible == 1U &&
                patches.back().key.level == 0U &&
                patches.back().key.i == 0 &&
                patches.back().key.j == -134217728 &&
                patches.back().key.k == -134217728 &&
                patches.back().visible == 1U,
            "frame patch IDs changed");

    require_status(terra_update(context, 0.0025F), TERRA_STATUS_OK,
                   "select hierarchy verification cut");

    std::size_t request_count = 0U;
    require_status(terra_get_requests(context, nullptr, 0U, &request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "request sizing");
    require(request_count >= 8U && request_count <= 16U,
            "initial request frontier is not parent bounded");
    std::vector<terra_request_v1> requests(request_count);
    require_status(terra_get_requests(context, requests.data(),
                                      requests.size(), &request_count),
                   TERRA_STATUS_OK, "get requests");
    std::size_t root_requests = 0U;
    std::size_t detail_requests = 0U;
    const terra_request_v1* root0 = nullptr;
    const terra_request_v1* root0_detail = nullptr;
    const terra_request_v1* root3 = nullptr;
    const terra_request_v1* root3_detail = nullptr;
    const terra_request_v1* child_detail = nullptr;
    for (const terra_request_v1& request : requests) {
      root_requests += request.kind == TERRA_REQUEST_ROOT ? 1U : 0U;
      detail_requests += request.kind == TERRA_REQUEST_DETAIL ? 1U : 0U;
      if (request.key.level == 0U && request.key.i == 0 &&
          request.key.j == 134217728 && request.key.k == 134217728) {
        if (request.kind == TERRA_REQUEST_ROOT) {
          root0 = &request;
        } else if (request.kind == TERRA_REQUEST_DETAIL) {
          root0_detail = &request;
        }
      } else if (request.key.level == 0U &&
                 request.key.i == -134217728 &&
                 request.key.j == 134217728 && request.key.k == 0) {
        if (request.kind == TERRA_REQUEST_ROOT) {
          root3 = &request;
        } else if (request.kind == TERRA_REQUEST_DETAIL) {
          root3_detail = &request;
        }
      } else if (request.kind == TERRA_REQUEST_DETAIL &&
                 request.key.level == 1U &&
                 request.key.i == -134217728 &&
                 request.key.j == 134217728 &&
                 request.key.k == 134217728) {
        child_detail = &request;
      }
    }
    require(root_requests == 8U && detail_requests > 0U &&
                root0 != nullptr && root0_detail != nullptr &&
                root3 != nullptr && root3_detail != nullptr &&
                child_detail == nullptr,
            "initial request frontier bypassed the parent chain");

    const std::vector<std::uint8_t> root_record = read_binary(argv[1]);
    const std::vector<std::uint8_t> detail0_record = read_binary(argv[2]);
    verify_paused_height_frontier(root_record, detail0_record);
    verify_rejected_record(context, *root0, detail0_record);
    verify_rejected_record(context, *root0_detail, root_record);
    // A tiny valid header advertises a 1024x1024 array, while this dataset
    // requires only 65x65 roots. The old general decoder allocated 4 MiB.
    verify_rejected_record(context, *root0, {6, 0, 0, 0, 0xc0, 4, 0, 0, 0, 0});
    auto dual_record = root_record;
    dual_record.insert(dual_record.end(), root_record.begin() + 4U, root_record.end());
    verify_rejected_record(context, *root0, dual_record);
    verify_rejected_record(context, *root0,
        std::vector<std::uint8_t>(65U * 65U * 16U + 4097U), TERRA_STATUS_RESOURCE_LIMIT);
    verify_rejected_record(context, *root0_detail,
        std::vector<std::uint8_t>(64U * 64U * 16U + 4097U), TERRA_STATUS_RESOURCE_LIMIT);
    require_status(terra_set_record_work_limit(context, 65U * 65U * 4U - 1U), TERRA_STATUS_OK, "short root credit");
    verify_rejected_record(context, *root0, root_record, TERRA_STATUS_RESOURCE_LIMIT);
    require_status(terra_set_record_work_limit(context, 65U * 65U * 4U), TERRA_STATUS_OK, "exact root credit");
    require_status(terra_submit_record(
                       context, TERRA_REQUEST_ROOT, &root0->key,
                       root_record.data(), root_record.size()),
                   TERRA_STATUS_OK, "submit root with explicit record kind");
    require_status(terra_set_record_work_limit(context, 0U), TERRA_STATUS_OK, "close decoded production");
    verify_duplicate_record(context, *root0, root_record);
    require_status(terra_trim_record_cache(context, 0U), TERRA_STATUS_OK, "protect active records");
    require(terra_record_payload_bytes(context) == (64U * 64U + 65U * 65U) * 4U,
            "cache trim released active record or procedural input");
    require_status(terra_set_record_work_limit(context, 16U * 1024U * 1024U), TERRA_STATUS_OK, "restore native host policy");

    const std::vector<std::uint8_t> root3_record = read_binary(argv[3]);
    const std::vector<std::uint8_t> detail3_record = read_binary(argv[4]);
    const std::vector<std::uint8_t> child_record = read_binary(argv[5]);
    require_status(terra_submit_record(
                       context, TERRA_REQUEST_DETAIL, &root0_detail->key,
                       detail0_record.data(), detail0_record.size()),
                   TERRA_STATUS_OK,
                   "submit detail with explicit record kind");
    require_status(terra_submit_record(
                       context, root3->kind, &root3->key,
                       root3_record.data(), root3_record.size()),
                   TERRA_STATUS_OK, "submit root three record");
    require_status(terra_submit_record(
                       context, root3_detail->kind, &root3_detail->key,
                       detail3_record.data(), detail3_record.size()),
                   TERRA_STATUS_OK, "submit root three detail");
    require_status(terra_update(context, 0.0025F), TERRA_STATUS_OK,
                   "update after parent records");

    request_count = 0U;
    require_status(terra_get_requests(context, nullptr, 0U, &request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL,
                   "child request sizing");
    requests.assign(request_count, terra_request_v1{});
    require_status(terra_get_requests(context, requests.data(),
                                      requests.size(), &request_count),
                   TERRA_STATUS_OK, "get child request frontier");
    child_detail = nullptr;
    for (const terra_request_v1& request : requests) {
      if (request.kind == TERRA_REQUEST_DETAIL &&
          request.key.level == 1U &&
          request.key.i == -134217728 &&
          request.key.j == 134217728 &&
          request.key.k == 134217728) {
        child_detail = &request;
        break;
      }
    }
    require(child_detail != nullptr,
            "child detail was not requested after its parents were ready");
    const terra_patch_key_v1 child_key = child_detail->key;
    require_status(terra_submit_record(
                       context, TERRA_REQUEST_DETAIL, &child_key,
                       child_record.data(), child_record.size()),
                   TERRA_STATUS_OK, "submit shared child detail");
    require_status(terra_update(context, 0.0025F), TERRA_STATUS_OK,
                   "update after hierarchy chain");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get drawable frame");
    require(frame.sequence == 4U && frame.patch_count > 8U &&
                frame.loaded_patch_count == 5U && frame.draw_count > 0U,
            "drawable hierarchy state changed");

    const auto output = read_mesh_output(context);
    const auto& draws = output.draws;
    const auto& positions = output.positions;
    const auto& texture_uv = output.texture_uv;
    const auto draw_count = draws.size(), position_count = positions.size(), texture_count = texture_uv.size();
    const std::size_t coverage_draw_count =
        static_cast<std::size_t>(std::count_if(
            draws.begin(), draws.end(), [](const terra_draw_range_v1& draw) {
              return draw.flags == TERRA_DRAW_FLAG_COVERAGE;
            }));
    require(draw_count == frame.draw_count &&
                coverage_draw_count == frame.coverage_draw_count &&
                frame.draw_count >= frame.coverage_draw_count &&
                frame.expected_draw_count ==
                    frame.draw_count - frame.coverage_draw_count +
                        frame.omitted_draw_count &&
                position_count == frame.position_float_count &&
                texture_count == frame.texture_float_count &&
                position_count == frame.vertex_count * 3U &&
                texture_count == frame.vertex_count * 2U,
            "frame draw buffer counts disagree");
    for (const terra_draw_range_v1& draw : draws) {
      require(draw.struct_size == sizeof(draw) && draw.fragment < 2U &&
                  draw.vertex_count == 2145U &&
                  draw.first_vertex + draw.vertex_count <=
                      frame.vertex_count &&
                  draw.first_index == 0U &&
                  draw.index_count == index_count &&
                  draw.texture.level <= 8U &&
                  draw.texture.root >= 0 && draw.texture.root < 8 &&
                  draw.texture.row >= 0 && draw.texture.column >= 0 &&
                  (draw.flags == TERRA_DRAW_FLAG_NONE ||
                   draw.flags == TERRA_DRAW_FLAG_COVERAGE) &&
                  std::isfinite(draw.origin[0]) &&
                  std::isfinite(draw.origin[1]) &&
                  std::isfinite(draw.origin[2]),
              "draw range contract changed");
    }
    require(std::all_of(positions.begin(), positions.end(),
                        [](float value) { return std::isfinite(value); }),
            "position buffer contains a non-finite value");
    require(std::all_of(texture_uv.begin(), texture_uv.end(),
                        [](float value) {
                          return std::isfinite(value) &&
                                 value >= -0.0001F && value <= 1.0001F;
                        }),
            "texture buffer contains an invalid coordinate");

    request_count = 0U;
    require_status(terra_get_requests(context, nullptr, 0U, &request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL,
                   "failure request sizing");
    requests.assign(request_count, terra_request_v1{});
    require_status(terra_get_requests(context, requests.data(),
                                      requests.size(), &request_count),
                   TERRA_STATUS_OK, "get failure request frontier");
    require(!requests.empty(), "missing request for failure contract");
    const terra_request_v1 failed_request = requests.back();
    require_status(terra_fail_record(
                       context, failed_request.kind,
                       &failed_request.key),
                   TERRA_STATUS_OK, "fail terrain record");
    const std::uint8_t malformed[] = {0U};
    require_status(terra_submit_record(
                       context, failed_request.kind,
                       &failed_request.key, malformed, sizeof(malformed)),
                   TERRA_STATUS_DECODE_ERROR, "malformed terrain record");

    terra_stats_v1 stats{};
    stats.struct_size = sizeof(stats);
    require_status(terra_get_stats(context, &stats), TERRA_STATUS_OK,
                   "get stats");
    require(stats.update_count == 4U && stats.loaded_patch_count == 5U &&
                stats.failed_patch_count == 1U &&
                stats.decoded_value_count == 20738U &&
                stats.current_patch_count == frame.patch_count &&
                stats.current_request_count == frame.request_count &&
                stats.last_sequence == 4U,
            "ABI statistics changed");

    terra_camera_v3 camera{};
    camera.struct_size = sizeof(camera);
    camera.distance = 20000000.0 - manifest.radius;
    camera.tilt_radians = 0.7853981633974483;
    camera.yaw_radians = 0.5235987755982988;
    require_status(terra_set_globe_target(context, 181.0, 0.0),
                   TERRA_STATUS_INVALID_ARGUMENT, "invalid globe target");
    require_status(terra_set_globe_target(context, 116.4074, 39.9042),
                   TERRA_STATUS_OK, "set globe target");
    require_status(terra_set_camera(context, &camera), TERRA_STATUS_OK,
                   "set camera");
    require_status(terra_update(context, 1.0F), TERRA_STATUS_OK,
                   "camera coarsen update");
    frame.struct_size = sizeof(frame);
    require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                   "get camera frame");
    require(frame.sequence == 5U && frame.decisions_complete == 0U,
            "coarsening frame did not expose its pending convergence");
    std::size_t convergence_updates = 0U;
    while (frame.decisions_complete == 0U && convergence_updates < 8U) {
      require_status(terra_update(context, 1.0F), TERRA_STATUS_OK,
                     "camera convergence update");
      frame.struct_size = sizeof(frame);
      require_status(terra_get_frame(context, &frame), TERRA_STATUS_OK,
                     "get converging camera frame");
      ++convergence_updates;
    }
    require(frame.decisions_complete == 1U && convergence_updates > 0U,
            "camera frame did not converge within the bounded update loop");

    stats.struct_size = sizeof(stats);
    require_status(terra_get_stats(context, &stats), TERRA_STATUS_OK,
                   "get stats after terrain coarsening");
    require(stats.loaded_patch_count == 2U &&
                stats.decoded_value_count == 8450U,
            "coarsened terrain records remain in the SDK working set");

    terra_context* coverage_context = terra_create();
    require(coverage_context != nullptr, "coverage terra_create failed");
    require_status(terra_load_terrain_manifest(coverage_context, &manifest),
                   TERRA_STATUS_OK, "load coverage manifest");
    require_status(terra_set_viewport(coverage_context, &viewport),
                   TERRA_STATUS_OK, "set coverage viewport");
    require_status(terra_update(coverage_context, 0.005F),
                   TERRA_STATUS_OK, "select coverage roots");
    std::size_t coverage_request_count = 0U;
    require_status(terra_get_requests(coverage_context, nullptr, 0U,
                                      &coverage_request_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL,
                   "coverage request sizing");
    std::vector<terra_request_v1> coverage_requests(
        coverage_request_count);
    require_status(terra_get_requests(
                       coverage_context, coverage_requests.data(),
                       coverage_requests.size(), &coverage_request_count),
                   TERRA_STATUS_OK, "get coverage requests");
    terra_update_budget_v2 plan_budget{};
    plan_budget.struct_size = sizeof(plan_budget);
    plan_budget.api_version = TERRA_UPDATE_API_VERSION;
    plan_budget.maximum_change_count = 2048U;
    plan_budget.maximum_priority_update_count = 65536U;
    terra_mesh_plan_v1 stale_plan{};
    stale_plan.struct_size = sizeof(stale_plan);
    std::size_t submitted_roots = 0U;
    for (const terra_request_v1& request : coverage_requests) {
      if (request.kind != TERRA_REQUEST_ROOT) {
        continue;
      }
      require_status(terra_submit_record(
                         coverage_context, request.kind, &request.key,
                         root_record.data(), root_record.size()),
                     TERRA_STATUS_OK, "submit coverage root");
      ++submitted_roots;
      if (submitted_roots == 1U) {
        require_status(terra_prepare_mesh_frame(coverage_context, 0.005F, &plan_budget, &stale_plan),
                       TERRA_STATUS_OK, "prepare first root before further height arrival");
      } else if (submitted_roots == 2U) {
        terra_update_state_v2 changed_model{};
        changed_model.struct_size = sizeof(changed_model);
        require_status(terra_advance_terrain(coverage_context, 0.005F, &plan_budget, &changed_model),
                       TERRA_STATUS_OK, "prepare newly arrived root heights");
        require(changed_model.height_build_count > 0U, "snapshot fixture did not advance height inputs");
        require_status(terra_get_prepared_mesh_uv(coverage_context, stale_plan.plan_id, 0U, 0U, 0U, nullptr),
                       TERRA_STATUS_INVALID_ARGUMENT, "snapshot remains valid but resource zero is invalid");
        require_status(terra_discard_mesh_plan(coverage_context, stale_plan.plan_id), TERRA_STATUS_OK,
                       "release prepared snapshot");
      }
    }
    require(submitted_roots == 8U, "coverage root count changed");
    terra_mesh_plan_v1 plan{};
    plan.struct_size = sizeof(plan);
    require(terra_sizeof_mesh_plan_v1() == sizeof(plan), "native plan layout differs");
    require_status(terra_set_height_work_limit(coverage_context, 0U, 1U), TERRA_STATUS_OK,
                   "close height production");
    const auto before_heights = terra_height_payload_bytes(coverage_context);
    const auto before_plan = plan;
    require_status(terra_prepare_mesh_frame(coverage_context, 0.005F, &plan_budget, &plan),
                   TERRA_STATUS_WORK_PENDING, "quote remaining root height work");
    const auto root_height_bytes = 65U * 66U * 4U;
    require(terra_height_work_bytes(coverage_context) == root_height_bytes &&
            terra_height_payload_bytes(coverage_context) == before_heights &&
            std::memcmp(&plan, &before_plan, sizeof(plan)) == 0,
            "height quote allocated payload or changed output");
    require_status(terra_set_height_work_limit(coverage_context, root_height_bytes - 1U, 1U),
                   TERRA_STATUS_OK, "short height credit");
    require_status(terra_prepare_mesh_frame(coverage_context, 0.005F, &plan_budget, &plan),
                   TERRA_STATUS_WORK_PENDING, "refuse short height credit");
    require(terra_height_payload_bytes(coverage_context) == before_heights, "short credit allocated heights");
    terra_update_state_v2 wrong_operation{};
    wrong_operation.struct_size = sizeof(wrong_operation);
    require_status(terra_advance_terrain(coverage_context, 0.005F, &plan_budget, &wrong_operation),
                   TERRA_STATUS_INVALID_STATE, "reject a different pending operation");
    std::size_t height_slices = 0U;
    for (;;) {
      const auto quote = terra_height_work_bytes(coverage_context);
      require_status(terra_set_height_work_limit(coverage_context, quote, 1U), TERRA_STATUS_OK, "grant next height work");
      const auto occupied = terra_height_payload_bytes(coverage_context);
      const auto result = terra_prepare_mesh_frame(coverage_context, 0.005F, &plan_budget, &plan);
      require(terra_height_payload_bytes(coverage_context) <= occupied + quote, "height slice exceeded credit");
      require(++height_slices <= 32U, "height continuations did not finish");
      if (result == TERRA_STATUS_OK) break;
      require_status(result, TERRA_STATUS_WORK_PENDING, "resume height preparation");
    }
    require(height_slices > 1U, "height fixture did not yield between roots");
    require_status(terra_set_height_work_limit(coverage_context, 32U * 1024U * 1024U, UINT32_MAX),
                   TERRA_STATUS_OK, "restore native batch policy");
    require(plan.api_version == TERRA_C_API_VERSION && plan.plan_id > 0U &&
                plan.resident_mesh_bytes == 0U && plan.additional_mesh_bytes > 0U,
            "metadata preparation allocated native arrays");
    verify_height_ownership_readback(coverage_context);
    const auto cancelled_plan = plan.plan_id;
    const auto prepared_sequence = plan.frame.sequence;
    require_status(terra_discard_mesh_plan(coverage_context, plan.plan_id), TERRA_STATUS_OK,
                   "cancel unmaterialized plan");
    require_status(terra_prepare_mesh_frame(coverage_context, 0.005F, &plan_budget, &plan),
                   TERRA_STATUS_OK, "prepare successor plan");
    require(plan.plan_id != cancelled_plan && plan.frame.sequence == prepared_sequence,
            "plan identity must be independent of publication sequence");
    require_status(terra_discard_mesh_plan(coverage_context, cancelled_plan), TERRA_STATUS_INVALID_STATE,
                   "late cancellation cannot discard successor");
    std::uint32_t production_complete = 99U;
    require_status(terra_step_mesh_frame(coverage_context, cancelled_plan, UINT32_MAX, &production_complete),
                   TERRA_STATUS_INVALID_STATE, "reject stale production credit");
    std::size_t planned_count = 0U;
    require_status(terra_get_prepared_mesh_resources(coverage_context, plan.plan_id, nullptr, 0U, &planned_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "size prepared descriptors");
    std::vector<terra_mesh_resource_v3> planned(planned_count);
    require_status(terra_get_prepared_mesh_resources(coverage_context, plan.plan_id, planned.data(), planned.size(), &planned_count),
                   TERRA_STATUS_OK, "read prepared descriptors");
    verify_readback<terra_mesh_resource_v3>(coverage_context,
        [&](const terra_context* owner, terra_mesh_resource_v3* output, std::size_t capacity, std::size_t* count) {
          return terra_get_prepared_mesh_resources(owner, plan.plan_id, output, capacity, count);
        }, TERRA_STATUS_INVALID_STATE);
    std::set<std::uint32_t> unique_planned;
    std::vector<std::vector<float>> planned_uv, planned_positions;
    for (const auto& item : planned) {
      unique_planned.insert(item.resource_id);
      planned_uv.emplace_back(item.draw.vertex_count * 2U);
      planned_positions.emplace_back(item.draw.vertex_count * 3U);
      auto& uv = planned_uv.back();
      for (std::uint32_t first = 0U; first < item.draw.vertex_count; first += TERRA_MESH_SAMPLE_LIMIT) {
        require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, item.resource_id,
            first, std::min(TERRA_MESH_SAMPLE_LIMIT, item.draw.vertex_count - first), uv.data() + first * 2U),
            TERRA_STATUS_OK, "read bounded prepared UV");
        require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, item.resource_id,
            first, std::min(TERRA_MESH_SAMPLE_LIMIT, item.draw.vertex_count - first),
            planned_positions.back().data() + first * 3U), TERRA_STATUS_OK, "read bounded prepared positions");
      }
      float repeated[2] = {-999.0F, -999.0F};
      require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, item.resource_id,
          item.draw.vertex_count - 1U, 1U, repeated), TERRA_STATUS_OK, "repeat prepared UV read");
      require(repeated[0] == uv[uv.size()-2U] && repeated[1] == uv.back(), "prepared UV read is not repeatable");
      require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, item.resource_id,
          item.draw.vertex_count, 0U, nullptr), TERRA_STATUS_OK, "empty prepared UV read");
      require(!terra_get_mesh_position_view(coverage_context, item.resource_id) &&
                  !terra_get_mesh_texture_view(coverage_context, item.resource_id),
              "prepared resource exposed an uncredited array");
      require_status(terra_acquire_mesh_resource(coverage_context, item.resource_id),
                     TERRA_STATUS_INVALID_STATE, "cannot borrow unmaterialized payload");
    }
    float sentinel[3] = {-999.0F, -999.0F, -999.0F};
    require_status(terra_get_prepared_mesh_uv(coverage_context, cancelled_plan, planned.front().resource_id,
        0U, 1U, sentinel), TERRA_STATUS_INVALID_STATE, "reject cancelled UV read");
    require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, 0U, 0U, 1U, sentinel),
        TERRA_STATUS_INVALID_ARGUMENT, "reject unknown prepared UV resource");
    require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, planned.front().resource_id,
        UINT32_MAX, 1U, sentinel), TERRA_STATUS_INVALID_ARGUMENT, "reject overflowing UV range");
    require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, planned.front().resource_id,
        0U, TERRA_MESH_SAMPLE_LIMIT + 1U, sentinel), TERRA_STATUS_INVALID_ARGUMENT, "reject excessive UV slice");
    require(sentinel[0] == -999.0F && sentinel[1] == -999.0F, "rejected prepared UV read wrote output");
    const auto sample_id = planned.front().resource_id;
    require_status(terra_get_prepared_mesh_positions(coverage_context, cancelled_plan, sample_id, 0U, 1U, sentinel),
        TERRA_STATUS_INVALID_STATE, "reject cancelled position read");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, 0U, 0U, 1U, sentinel),
        TERRA_STATUS_INVALID_ARGUMENT, "reject unknown position resource");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id, UINT32_MAX, 1U, sentinel),
        TERRA_STATUS_INVALID_ARGUMENT, "reject overflowing position range");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id,
        0U, TERRA_MESH_SAMPLE_LIMIT + 1U, sentinel), TERRA_STATUS_INVALID_ARGUMENT, "reject excessive position slice");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id, 0U, 1U, nullptr),
        TERRA_STATUS_INVALID_ARGUMENT, "reject null position output");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id,
        planned.front().draw.vertex_count, 0U, nullptr), TERRA_STATUS_OK, "empty prepared position read");
    require(sentinel[0] == -999.0F && sentinel[1] == -999.0F && sentinel[2] == -999.0F,
        "rejected position read wrote output");
    require(terra_mesh_payload_bytes(coverage_context) == 0U, "surface sampling allocated native mesh payload");
    const std::set<std::vector<float>> unique_uv(planned_uv.begin(), planned_uv.end());
    const auto vertex_count = planned.front().draw.vertex_count;
    const auto expected_native_bytes = (unique_planned.size() * 12U + unique_uv.size() * 8U) * vertex_count;
    require(unique_uv.size() < unique_planned.size(), "UV sharing fixture has no identical layouts");
    require(plan.additional_mesh_bytes == expected_native_bytes,
            "plan cost must count exact native UV layouts once");
    require_status(terra_step_mesh_frame(coverage_context, plan.plan_id,
                       static_cast<std::uint32_t>(plan.additional_mesh_bytes - 1U), &production_complete),
                   TERRA_STATUS_CAPACITY_PENDING, "refuse insufficient native production credit");
    terra_update_state_v2 refused{};
    refused.struct_size = sizeof(refused);
    require_status(terra_get_update_state(coverage_context, &refused), TERRA_STATUS_OK,
                   "inspect refused production");
    require(refused.mesh_bytes == 0U && refused.sequence + 1U == prepared_sequence,
            "refused production allocated or published a mesh");
    require(production_complete == 99U, "failed production changed the completion output");
    require_status(terra_commit_mesh_frame(coverage_context, plan.plan_id),
        TERRA_STATUS_INVALID_STATE, "unproduced candidate cannot publish");
    std::size_t ready = 0U, turns = 0U;
    do {
      require_status(terra_step_mesh_frame(coverage_context, plan.plan_id,
          static_cast<std::uint32_t>(plan.additional_mesh_bytes), &production_complete),
          TERRA_STATUS_OK, "continue admitted coverage");
      std::size_t next_ready = 0U;
      for (const auto id : unique_planned) next_ready += terra_get_mesh_position_view(coverage_context, id) ? 1U : 0U;
      require(next_ready >= ready && next_ready <= ready + 1U,
              "one production step generated more than one fragment");
      ready = next_ready;
      require(++turns <= planned.size() && terra_mesh_payload_bytes(coverage_context) <= expected_native_bytes,
              "bounded mesh generation failed to advance or exceeded its credit");
      if (!production_complete) {
        require_status(terra_begin_mesh_replacement(coverage_context, plan.plan_id, nullptr, 0U, UINT32_MAX),
            TERRA_STATUS_INVALID_ARGUMENT, "partial production cannot begin boundary work");
        require_status(terra_commit_mesh_frame(coverage_context, plan.plan_id),
            TERRA_STATUS_INVALID_STATE, "partial production cannot publish");
        terra_frame_v1 held{}; held.struct_size = sizeof(held);
        require_status(terra_get_frame(coverage_context, &held), TERRA_STATUS_OK, "read held candidate");
        require(held.sequence + 1U == prepared_sequence, "partial generation published the new candidate");
        std::uint32_t sentinel_complete = 99U;
        require_status(terra_step_mesh_frame(coverage_context, plan.plan_id, UINT32_MAX, &sentinel_complete),
            TERRA_STATUS_INVALID_ARGUMENT, "production credit cannot change between steps");
        require(sentinel_complete == 99U, "changed-credit rejection wrote completion");
      }
    } while (!production_complete);
    require(turns >= unique_planned.size() && ready == unique_planned.size(),
            "coverage generation skipped incomplete resources");
    std::set<const float*> native_uv;
    for (std::size_t i = 0U; i < planned.size(); ++i) {
      const auto* materialized = terra_get_mesh_texture_view(coverage_context, planned[i].resource_id);
      require(materialized && std::memcmp(planned_uv[i].data(), materialized, planned_uv[i].size() * sizeof(float)) == 0,
          "prepared UV differs from materialized payload");
      native_uv.insert(materialized);
      const auto* xyz = terra_get_mesh_position_view(coverage_context, planned[i].resource_id);
      require(xyz && std::memcmp(planned_positions[i].data(), xyz, planned_positions[i].size() * sizeof(float)) == 0,
          "prepared positions differ from materialized payload");
    }
    require(native_uv.size() == unique_uv.size() && terra_mesh_payload_bytes(coverage_context) == expected_native_bytes,
            "materialization did not share and charge each native UV allocation exactly once");
    terra_frame_v1 staged_frame{}; staged_frame.struct_size = sizeof(staged_frame);
    require_status(terra_get_frame(coverage_context, &staged_frame), TERRA_STATUS_OK, "read unpublished candidate");
    require(staged_frame.sequence + 1U == prepared_sequence, "completed production published without acceptance");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id,
        0U, 1U, sentinel), TERRA_STATUS_OK, "completed candidate remains inspectable");
    const auto late_boundary_bytes = terra_mesh_replacement_work_bytes(coverage_context, plan.plan_id, nullptr, 0U);
    require(late_boundary_bytes > 0U, "completed candidate has no boundary quote");
    require_status(terra_begin_mesh_replacement(coverage_context, plan.plan_id, nullptr, 0U, late_boundary_bytes - 1U),
        TERRA_STATUS_CAPACITY_PENDING, "late boundary work requires scratch credit");
    require_status(terra_begin_mesh_replacement(coverage_context, plan.plan_id, nullptr, 0U, late_boundary_bytes),
        TERRA_STATUS_OK, "begin boundary work on generated unpublished terrain");
    require_status(terra_commit_mesh_frame(coverage_context, plan.plan_id),
        TERRA_STATUS_INVALID_STATE, "active late boundary work cannot publish");
    std::uint32_t boundary_complete = 0U;
    std::size_t boundary_turns = 0U;
    do {
      require_status(terra_step_mesh_replacement(coverage_context, plan.plan_id, 512U, &boundary_complete),
          TERRA_STATUS_OK, "continue late boundary proof");
      require(++boundary_turns < 10000U, "late boundary work did not finish");
    } while (!boundary_complete);
    require_status(terra_end_mesh_replacement(coverage_context, plan.plan_id),
        TERRA_STATUS_OK, "finish late boundary proof");
    require(terra_mesh_payload_bytes(coverage_context) == expected_native_bytes,
        "late boundary planning regenerated completed mesh payload");
    require_status(terra_commit_mesh_frame(coverage_context, plan.plan_id), TERRA_STATUS_OK, "accept prepared candidate");
    require_status(terra_commit_mesh_frame(coverage_context, plan.plan_id), TERRA_STATUS_INVALID_STATE, "reject duplicate acceptance");
    require_status(terra_get_prepared_mesh_uv(coverage_context, plan.plan_id, planned.front().resource_id,
        0U, 1U, sentinel), TERRA_STATUS_INVALID_STATE, "reject consumed UV plan");
    require_status(terra_get_prepared_mesh_positions(coverage_context, plan.plan_id, sample_id,
        0U, 1U, sentinel), TERRA_STATUS_INVALID_STATE, "reject consumed position plan");
    require_status(terra_step_mesh_frame(coverage_context, plan.plan_id, UINT32_MAX, &production_complete),
                   TERRA_STATUS_INVALID_STATE, "consumed credit cannot be replayed");
    terra_frame_v1 coverage_frame{};
    coverage_frame.struct_size = sizeof(coverage_frame);
    require_status(terra_get_frame(coverage_context, &coverage_frame),
                   TERRA_STATUS_OK, "get global coverage frame");
    const auto coverage_ranges = read_mesh_output(coverage_context).draws;
    require(coverage_frame.coverage_complete == 1U &&
                coverage_frame.coverage_draw_count == 16U &&
                std::count_if(
                    coverage_ranges.begin(), coverage_ranges.end(),
                    [](const terra_draw_range_v1& draw) {
                      return draw.flags == TERRA_DRAW_FLAG_COVERAGE &&
                             draw.key.level == 0U;
                    }) == 16,
            "global root coverage is incomplete");

    require(terra_sizeof_update_budget_v2() == sizeof(terra_update_budget_v2) &&
                terra_sizeof_update_state_v2() == sizeof(terra_update_state_v2) &&
                terra_sizeof_mesh_resource_v3() == sizeof(terra_mesh_resource_v3) &&
                terra_sizeof_frame_receipt_v2() == sizeof(terra_frame_receipt_v2),
            "incremental ABI size queries disagree with the native layouts");
    terra_update_state_v2 update_state{};
    update_state.struct_size = sizeof(update_state);
    require_status(terra_get_update_state(coverage_context, &update_state),
                   TERRA_STATUS_OK, "get incremental update state");
    require(update_state.api_version == TERRA_UPDATE_API_VERSION &&
                update_state.model_revision > 0U && update_state.mesh_bytes > 0U &&
                update_state.decoded_record_bytes > 0U &&
                update_state.height_bytes > 0U &&
                update_state.mesh_bytes <= update_state.maximum_mesh_bytes,
            "native mesh payload exceeded its publication budget");
    std::size_t resource_count = 0U;
    require_status(terra_get_mesh_resources(coverage_context, nullptr, 0U,
                                            &resource_count),
                   TERRA_STATUS_BUFFER_TOO_SMALL, "mesh resource sizing");
    std::vector<terra_mesh_resource_v3> resources(resource_count);
    require_status(terra_get_mesh_resources(coverage_context, resources.data(),
                                            resources.size(), &resource_count),
                   TERRA_STATUS_OK, "get stable mesh resources");
    verify_readback<terra_mesh_resource_v3>(coverage_context, terra_get_mesh_resources);
    require(resource_count == coverage_frame.draw_count,
            "mesh resources do not describe the display draw set");
    for (const auto& resource : resources) {
      require(resource.resource_id != 0U &&
                  terra_get_mesh_position_view(coverage_context, resource.resource_id) != nullptr &&
                  terra_get_mesh_texture_view(coverage_context, resource.resource_id) != nullptr &&
                  resource.position_float_count == resource.draw.vertex_count * 3U &&
                  resource.texture_float_count == resource.draw.vertex_count * 2U,
              "immutable mesh view is incomplete");
    }
    terra_frame_receipt_v2 receipt{};
    receipt.struct_size = sizeof(receipt);
    receipt.api_version = TERRA_UPDATE_API_VERSION;
    receipt.sequence = coverage_frame.sequence + 1U;
    require_status(terra_present_frame(coverage_context, &receipt),
                   TERRA_STATUS_INVALID_STATE, "reject a stale frame receipt");
    receipt.sequence = coverage_frame.sequence;
    require_status(terra_present_frame(coverage_context, &receipt),
                   TERRA_STATUS_OK, "retain the presented mesh set");
    terra_camera_v3 moved_camera{};
    moved_camera.struct_size = sizeof(moved_camera);
    moved_camera.distance = 15000000.0 - manifest.radius;
    moved_camera.tilt_radians = 0.3;
    moved_camera.yaw_radians = 0.2;
    require_status(terra_set_camera(coverage_context, &moved_camera),
                   TERRA_STATUS_OK, "move camera for incremental update");
    terra_update_budget_v2 update_budget{};
    update_budget.struct_size = sizeof(update_budget);
    update_budget.api_version = TERRA_UPDATE_API_VERSION;
    update_budget.maximum_change_count = 1U;
    update_budget.maximum_priority_update_count = 1U;
    update_budget.coarsening_only = 2U;
    require_status(terra_update_step(coverage_context, 0.005F, &update_budget),
                   TERRA_STATUS_INVALID_ARGUMENT, "reject invalid coarsening mode");
    update_budget.coarsening_only = 0U;
    require_status(terra_update_step(coverage_context, 0.005F, &update_budget),
                   TERRA_STATUS_OK, "resume a bounded camera update");
    terra_update_state_v2 moving_state{};
    moving_state.struct_size = sizeof(moving_state);
    require_status(terra_get_update_state(coverage_context, &moving_state),
                   TERRA_STATUS_OK, "get bounded camera update state");
    require(moving_state.budget_exhausted == 1U &&
                moving_state.priority_update_count == 1U &&
                moving_state.topology_change_count == 0U &&
                moving_state.pending_priority_update_count > 0U &&
                moving_state.model_revision == update_state.model_revision &&
                terra_get_mesh_position_view(coverage_context,
                    resources.front().resource_id) != nullptr,
            "a partial camera update rebuilt or released presented geometry");
    require_status(terra_present_frame(coverage_context, &receipt),
                   TERRA_STATUS_INVALID_STATE, "reject a superseded candidate");
    terra_frame_v1 pending_frame{};
    pending_frame.struct_size = sizeof(pending_frame);
    require_status(terra_get_frame(coverage_context, &pending_frame), TERRA_STATUS_OK,
                   "capture pending candidate before background model work");
    const auto pending_resources = resources;
    terra_update_state_v2 progress{};
    progress.struct_size = sizeof(progress);
    const auto* pending_position = terra_get_mesh_position_view(coverage_context,
        pending_resources.front().resource_id);
    const std::vector<float> pending_content(pending_position,
        pending_position + pending_resources.front().position_float_count);
    std::uint32_t background_priority_count = 0U;
    for (unsigned int turn = 0U; turn < 8U; ++turn) {
      require_status(terra_advance_terrain(coverage_context, 0.005F, &update_budget, &progress),
                     TERRA_STATUS_OK, "advance model while GPU candidate is held");
      require(progress.sequence == pending_frame.sequence && progress.priority_update_count <= 1U &&
                  progress.topology_change_count <= update_budget.maximum_change_count,
              "background model work changed publication identity or exceeded its work limit");
      background_priority_count += progress.priority_update_count;
    }
    require(background_priority_count > 0U, "held candidate prevented model priority progress");
    terra_update_state_v2 published_state{};
    published_state.struct_size = sizeof(published_state);
    require_status(terra_get_update_state(coverage_context, &published_state), TERRA_STATUS_OK,
                   "read publication state after model advancement");
    require(published_state.pending_priority_update_count == moving_state.pending_priority_update_count,
            "model progress overwrote published priority state");
    terra_frame_v1 unchanged_frame{};
    unchanged_frame.struct_size = sizeof(unchanged_frame);
    require_status(terra_get_frame(coverage_context, &unchanged_frame), TERRA_STATUS_OK,
                   "read candidate after background model work");
    require(unchanged_frame.sequence == pending_frame.sequence &&
                unchanged_frame.draw_count == pending_frame.draw_count &&
                std::equal(pending_content.begin(), pending_content.end(),
                    terra_get_mesh_position_view(coverage_context, pending_resources.front().resource_id)),
            "background model work mutated the pending candidate geometry");
    receipt.sequence = pending_frame.sequence;
    require_status(terra_present_frame(coverage_context, &receipt), TERRA_STATUS_OK,
                   "GPU receipt remains valid after independent model advancement");
    const auto borrowed_id = pending_resources.front().resource_id;
    const auto held_bytes = terra_mesh_payload_bytes(coverage_context);
    require_status(terra_acquire_mesh_resource(coverage_context, borrowed_id), TERRA_STATUS_OK, "first mesh loan");
    require_status(terra_acquire_mesh_resource(coverage_context, borrowed_id), TERRA_STATUS_OK, "shared mesh loan");
    require(terra_mesh_payload_bytes(coverage_context) == held_bytes, "a second reader duplicated the mesh charge");
    require_status(terra_load_terrain_manifest(coverage_context, &manifest), TERRA_STATUS_INVALID_STATE,
        "active mesh loan blocks dataset reset");
    require_status(terra_release_mesh_resource(coverage_context, borrowed_id), TERRA_STATUS_OK, "release one mesh loan");
    require_status(terra_load_terrain_manifest(coverage_context, &manifest), TERRA_STATUS_INVALID_STATE,
        "remaining mesh loan still blocks reset");
    require_status(terra_release_mesh_resource(coverage_context, borrowed_id), TERRA_STATUS_OK, "release final mesh loan");
    // Keep only the core reader's UV allocation. XYZ and all context registry
    // entries retire on reset; a live alias must still count until it releases.
    std::shared_ptr<const void> uv_loan;
    const void* uv_address = nullptr;
    float first_u = 0.0F, first_v = 0.0F;
    {
      terra::frame::surface_source source;
      require(terra::c_api_detail::borrow_surface_source(coverage_context, 0U, borrowed_id, source),
          "borrow a resident core surface reader");
      uv_loan = source.uv_identity().owner.lock(); uv_address = source.uv_identity().address;
      require(uv_loan && uv_address, "resident source omitted shared UV identity");
      const auto& uv = *static_cast<const std::vector<float>*>(uv_loan.get());
      first_u = uv.at(0U); first_v = uv.at(1U);
    }
    const auto other_context_bytes = terra_mesh_payload_bytes(context);
    require_status(terra_load_terrain_manifest(coverage_context, &manifest),
                   TERRA_STATUS_OK, "reset incremental resource ownership");
    require(terra_get_mesh_position_view(coverage_context,
                resources.front().resource_id) == nullptr,
            "a manifest reset retained obsolete mesh resource views");
    require(terra_mesh_payload_bytes(coverage_context) == pending_resources.front().texture_float_count * sizeof(float),
        "reset refunded UV still held outside the weak registry");
    require(uv_loan.get() == uv_address, "reset changed the immutable UV owner");
    const auto& surviving_uv = *static_cast<const std::vector<float>*>(uv_loan.get());
    require(surviving_uv.size() == pending_resources.front().texture_float_count &&
        surviving_uv[0U] == first_u && surviving_uv[1U] == first_v, "reset invalidated borrowed UV numbers");
    uv_loan.reset();
    require(terra_mesh_payload_bytes(coverage_context) == 0U && terra_mesh_payload_bytes(context) == other_context_bytes,
        "last UV release leaked bytes or changed a peer context");
    terra_destroy(coverage_context);

    terra_destroy(context);
    void* memory = terra_alloc(64U);
    require(memory != nullptr, "terra_alloc failed");
    terra_free(memory);
    std::cout << "Terra C ABI contract passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
