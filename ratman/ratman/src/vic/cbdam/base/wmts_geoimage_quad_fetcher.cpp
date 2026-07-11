#include <vic/cbdam/base/wmts_geoimage_quad_fetcher.hpp>

#include <iostream>
#include <utility>

namespace cbdam {

wmts_geoimage_quad_fetcher::wmts_geoimage_quad_fetcher(
    const source_t& source,
    const std::string& desired_srs,
    const aabox2d_t& desired_uv_box,
    const std::size_t& desired_quad_width,
    const std::string& default_about)
    : super_t(source.endpoint(), desired_srs, desired_uv_box,
              desired_quad_width, default_about),
      source_(source),
      tile_decoded_(false) {
}

wmts_geoimage_quad_fetcher::~wmts_geoimage_quad_fetcher() {
  clear();
}

const wmts_geoimage_quad_fetcher::source_t&
wmts_geoimage_quad_fetcher::source() const {
  return source_;
}

bool wmts_geoimage_quad_fetcher::is_out_of_bounds(
    const key_t& /* key */, const aabox2d_t& key_uv_box) const {
  return !source_.tile_for_bbox(
      key_uv_box[0][0], key_uv_box[0][1],
      key_uv_box[1][0], key_uv_box[1][1],
      quad_width()).is_valid();
}

void wmts_geoimage_quad_fetcher::handle_data_response(
    const key_t& key, const uint8_t* buffer,
    std::size_t buffer_size) {
  value_t* image = decoded(buffer, buffer_size);
  if (image == 0) {
    handle_error_response(key, "WMTS image decode failed");
    return;
  }

  push_result(key, std::make_pair(super_t::DONE, image));
  if (!tile_decoded_) {
    tile_decoded_ = true;
    std::cerr << "[terrain] wmts_tile_decoded layer="
              << source_.layer()
              << " bytes=" << buffer_size << std::endl;
  }
}

void wmts_geoimage_quad_fetcher::direct_connect() {
  is_connected_ = false;
}

void wmts_geoimage_quad_fetcher::direct_disconnect() {
  is_connected_ = false;
}

void wmts_geoimage_quad_fetcher::direct_send_requests() {
  is_connected_ = false;
}

void wmts_geoimage_quad_fetcher::direct_receive() {
  is_connected_ = false;
}

void wmts_geoimage_quad_fetcher::http_connect() {
  if (!source_.is_valid()) {
    std::cerr << "[terrain][error] wmts_source_invalid endpoint="
              << source_.endpoint() << std::endl;
    is_connected_ = false;
    return;
  }
  if (srs() != "EPSG:4326") {
    std::cerr << "[terrain][error] wmts_srs_unsupported srs="
              << srs() << std::endl;
    is_connected_ = false;
    return;
  }

  is_connected_ = true;
  std::cerr << "[terrain] wmts_source_connected endpoint="
            << source_.endpoint()
            << " layer=" << source_.layer()
            << " matrix_set=" << source_.matrix_set() << std::endl;
}

void wmts_geoimage_quad_fetcher::http_disconnect() {
  is_connected_ = false;
}

std::string wmts_geoimage_quad_fetcher::http_url_string(
    const key_t& /* key */, const aabox2d_t& uv_box) const {
  const std::string result = source_.tile_url_for_bbox(
      uv_box[0][0], uv_box[0][1],
      uv_box[1][0], uv_box[1][1],
      quad_width());
  return result.empty() ? "NULL://0/0/0" : result;
}

}  // namespace cbdam
