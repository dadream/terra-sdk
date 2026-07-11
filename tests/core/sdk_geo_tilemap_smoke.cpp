#include <vic/geo/base/tilemap_config.hpp>
#include <vic/geo/base/wmts_global_geodetic_source.hpp>
#include <vic/xml/document.hpp>

#include <cmath>
#include <limits>
#include <iostream>
#include <sstream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "Geo SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected) {
  return std::fabs(actual - expected) < 1e-9;
}

vic::xml::node_iterator parse_tilemap(vic::xml::document& doc,
                                      const std::string& xml) {
  std::istringstream input(xml);
  doc.parse(input);
  if (doc.error()) {
    return vic::xml::node_iterator();
  }
  return doc.first_root("tilemap");
}

int check_global_geodetic_defaults() {
  vic::xml::document doc;
  vic::xml::node_iterator node = parse_tilemap(
      doc,
      "<tilemap name=\"texture\" profile=\"global-geodetic\" "
      "mime-type=\"image/jpeg\" extension=\"jpg\" max-level=\"26\"/>");
  if (doc.error() || node.is_null()) {
    return fail("failed to parse global-geodetic tilemap XML");
  }

  vic::geo::base::tilemap_config cfg;
  if (!cfg.parse(node)) {
    return fail("tilemap_config rejected global-geodetic tilemap");
  }

  if (cfg.name() != "texture" || cfg.profile() != "global-geodetic") {
    return fail("global-geodetic name/profile parsing changed");
  }
  if (cfg.srs() != "EPSG:4326") {
    return fail("global-geodetic SRS default changed");
  }
  if (!near(cfg.bbox_lo(0), -180.0) || !near(cfg.bbox_lo(1), -90.0) ||
      !near(cfg.bbox_hi(0), 180.0) || !near(cfg.bbox_hi(1), 90.0)) {
    return fail("global-geodetic bbox defaults changed");
  }
  if (cfg.nu() != 2 || cfg.nv() != 1 ||
      cfg.img_width() != 256 || cfg.img_height() != 256) {
    return fail("global-geodetic tile dimensions changed");
  }
  if (!near(cfg.units_per_pixel(0), 360.0 / (2.0 * 256.0))) {
    return fail("global-geodetic units_per_pixel changed");
  }

  return 0;
}

int check_global_mercator_defaults() {
  vic::xml::document doc;
  vic::xml::node_iterator node = parse_tilemap(
      doc,
      "<tilemap name=\"mercator\" profile=\"global-mercator\" "
      "mime-type=\"image/png\" extension=\"png\" max-level=\"18\"/>");
  if (doc.error() || node.is_null()) {
    return fail("failed to parse global-mercator tilemap XML");
  }

  vic::geo::base::tilemap_config cfg;
  if (!cfg.parse(node)) {
    return fail("tilemap_config rejected global-mercator tilemap");
  }

  if (cfg.name() != "mercator" || cfg.profile() != "global-mercator" ||
      cfg.mime() != "image/png" || cfg.extension() != "png" ||
      cfg.max_level() != 18) {
    return fail("global-mercator string/level parsing changed");
  }
  if (cfg.srs() != "OSGEO:41001") {
    return fail("global-mercator SRS default changed");
  }
  if (!near(cfg.bbox_lo(0), -20037508.34) ||
      !near(cfg.bbox_lo(1), -20037508.34) ||
      !near(cfg.bbox_hi(0), 20037508.34) ||
      !near(cfg.bbox_hi(1), 20037508.34)) {
    return fail("global-mercator bbox defaults changed");
  }
  if (cfg.nu() != 2 || cfg.nv() != 2 ||
      cfg.img_width() != 256 || cfg.img_height() != 256) {
    return fail("global-mercator tile dimensions changed");
  }
  if (!near(cfg.units_per_pixel(0), 40075016.68 / (2.0 * 256.0)) ||
      !near(cfg.units_per_pixel(3), 40075016.68 / (2.0 * 256.0 * 8.0))) {
    return fail("global-mercator units_per_pixel changed");
  }

  return 0;
}

int check_custom_profile() {
  vic::xml::document doc;
  vic::xml::node_iterator node = parse_tilemap(
      doc,
      "<tilemap name=\"local\" profile=\"none\" mime-type=\"image/png\" "
      "extension=\"png\" max-level=\"8\" srs=\"EPSG:3857\" "
      "bbox_lo_0=\"10\" bbox_lo_1=\"20\" "
      "bbox_hi_0=\"110\" bbox_hi_1=\"220\" "
      "nu=\"4\" nv=\"5\" img_width=\"128\" img_height=\"256\"/>");
  if (doc.error() || node.is_null()) {
    return fail("failed to parse custom tilemap XML");
  }

  vic::geo::base::tilemap_config cfg;
  if (!cfg.parse(node)) {
    return fail("tilemap_config rejected custom tilemap");
  }

  if (cfg.name() != "local" || cfg.profile() != "none" ||
      cfg.mime() != "image/png" || cfg.extension() != "png") {
    return fail("custom tilemap string attributes changed");
  }
  if (cfg.max_level() != 8 || cfg.srs() != "EPSG:3857") {
    return fail("custom tilemap level/SRS parsing changed");
  }
  if (!near(cfg.bbox_lo(0), 10.0) || !near(cfg.bbox_lo(1), 20.0) ||
      !near(cfg.bbox_hi(0), 110.0) || !near(cfg.bbox_hi(1), 220.0)) {
    return fail("custom tilemap bbox parsing changed");
  }
  if (cfg.nu() != 4 || cfg.nv() != 5 ||
      cfg.img_width() != 128 || cfg.img_height() != 256) {
    return fail("custom tilemap tile dimensions changed");
  }

  const double expected_x = 100.0 / (4.0 * 128.0 * 4.0);
  const double expected_y = 200.0 / (5.0 * 256.0 * 4.0);
  if (!near(cfg.units_per_pixel(2), 0.5 * (expected_x + expected_y))) {
    return fail("custom tilemap units_per_pixel changed");
  }

  return 0;
}

int check_global_profile_description_contract() {
  vic::xml::document doc;
  vic::xml::node_iterator node = parse_tilemap(
      doc,
      "<tilemap name=\"global\" profile=\"global-geodetic\" "
      "mime-type=\"image/jpeg\" extension=\"jpg\" max-level=\"12\"/>");
  if (doc.error() || node.is_null()) {
    return fail("failed to parse global tilemap XML for description");
  }

  vic::geo::base::tilemap_config cfg;
  if (!cfg.parse(node)) {
    return fail("tilemap_config rejected global tilemap for description");
  }

  const std::string description = cfg.description();
  if (description.find("srs=") != std::string::npos ||
      description.find("bbox_lo_0") != std::string::npos ||
      description.find("nu=") != std::string::npos ||
      description.find("img_width=") != std::string::npos) {
    return fail("global tilemap description no longer omits derived fields");
  }

  vic::xml::document roundtrip_doc;
  vic::xml::node_iterator roundtrip_node =
      parse_tilemap(roundtrip_doc, description);
  if (roundtrip_doc.error() || roundtrip_node.is_null()) {
    return fail("failed to parse global tilemap description");
  }

  vic::geo::base::tilemap_config roundtrip;
  if (!roundtrip.parse(roundtrip_node)) {
    return fail("tilemap_config rejected global description roundtrip");
  }
  if (roundtrip.srs() != "EPSG:4326" ||
      !near(roundtrip.bbox_lo(0), -180.0) ||
      !near(roundtrip.bbox_hi(1), 90.0) ||
      roundtrip.nu() != 2 || roundtrip.nv() != 1) {
    return fail("global description roundtrip defaults changed");
  }

  return 0;
}

int check_required_attribute_validation() {
  vic::xml::document doc;
  vic::xml::node_iterator node = parse_tilemap(
      doc,
      "<tilemap name=\"broken\" profile=\"none\" "
      "mime-type=\"image/png\" extension=\"png\" "
      "srs=\"EPSG:4326\" bbox_lo_0=\"0\" bbox_lo_1=\"0\" "
      "bbox_hi_0=\"1\" bbox_hi_1=\"1\" "
      "nu=\"1\" nv=\"1\" img_width=\"256\" img_height=\"256\"/>");
  if (doc.error() || node.is_null()) {
    return fail("failed to parse broken tilemap XML");
  }

  vic::geo::base::tilemap_config cfg;
  if (cfg.parse(node)) {
    return fail("tilemap_config accepted tilemap without max-level");
  }

  return 0;
}

int check_global_geodetic_wmts_mapping() {
  typedef vic::geo::base::wmts_global_geodetic_source source_t;
  typedef vic::geo::base::wmts_tile_coordinate tile_t;

  const source_t source(
      "https://t{s}.tianditu.gov.cn/img_c/wmts",
      "img", "default", "tiles", "c", 1, 17, 8, "tk", "test-token");
  if (!source.is_valid()) {
    return fail("valid global-geodetic WMTS source was rejected");
  }

  const tile_t west =
      source.tile_for_bbox(-180.0, -90.0, 0.0, 90.0, 256);
  if (!west.is_valid() || west.level != 0 || west.matrix != 1 ||
      west.row != 0 || west.column != 0) {
    return fail("WMTS level-zero west tile mapping changed");
  }
  const std::string west_url = source.tile_url(west);
  if (west_url !=
      "https://t0.tianditu.gov.cn/img_c/wmts?"
      "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&"
      "TILEMATRIXSET=c&FORMAT=tiles&TILEMATRIX=1&TILEROW=0&TILECOL=0&"
      "tk=test-token") {
    return fail("WMTS level-zero URL contract changed");
  }

  const tile_t east =
      source.tile_for_bbox(0.0, -90.0, 180.0, 90.0, 256);
  if (!east.is_valid() || east.level != 0 || east.matrix != 1 ||
      east.row != 0 || east.column != 1 ||
      source.tile_url(east).find("https://t1.") != 0) {
    return fail("WMTS level-zero east tile mapping changed");
  }

  const tile_t north_east =
      source.tile_for_bbox(90.0, 0.0, 180.0, 90.0, 256);
  if (!north_east.is_valid() || north_east.level != 1 ||
      north_east.matrix != 2 || north_east.row != 0 ||
      north_east.column != 3) {
    return fail("WMTS north-east tile row conversion changed");
  }

  const tile_t south_east =
      source.tile_for_bbox(90.0, -90.0, 180.0, 0.0, 256);
  if (!south_east.is_valid() || south_east.level != 1 ||
      south_east.matrix != 2 || south_east.row != 1 ||
      south_east.column != 3) {
    return fail("WMTS south-east tile row conversion changed");
  }

  if (source.tile_url(tile_t(17, 18, 0, 0)).find("TILEMATRIX=18") ==
      std::string::npos) {
    return fail("WMTS advertised maximum matrix mapping changed");
  }

  if (source.tile_for_bbox(-181.0, -90.0, 0.0, 90.0, 256).is_valid() ||
      source.tile_for_bbox(-180.0, -90.0, 0.0, 90.0, 0).is_valid()) {
    return fail("WMTS invalid bbox/tile width was accepted");
  }

  if (!source.tile_url(tile_t(18, 19, 0, 0)).empty() ||
      !source.tile_url(tile_t(1, 2, 2, 0)).empty()) {
    return fail("WMTS invalid tile coordinate was accepted");
  }

  const double nan = std::numeric_limits<double>::quiet_NaN();
  if (source.tile_for_bbox(nan, -90.0, 0.0, 90.0, 256).is_valid()) {
    return fail("WMTS non-finite bbox was accepted");
  }
  const source_t overflowing_offset(
      "https://tiles.example.test/wmts", "imagery", "default", "tiles",
      "global", std::numeric_limits<int>::max(), 1, 1);
  if (overflowing_offset.is_valid()) {
    return fail("WMTS overflowing matrix offset was accepted");
  }

  const source_t no_token(
      "https://tiles.example.test/wmts", "imagery",
      "default", "image/jpeg", "global", 0, 4, 1, "key", "");
  const std::string no_token_url = no_token.tile_url_for_bbox(
      -180.0, -90.0, 0.0, 90.0, 256);
  if (no_token_url.find("TILEMATRIX=0") == std::string::npos ||
      no_token_url.find("&key=") != std::string::npos) {
    return fail("WMTS optional token/level offset contract changed");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_global_geodetic_defaults()) {
    return status;
  }
  if (int status = check_global_mercator_defaults()) {
    return status;
  }
  if (int status = check_custom_profile()) {
    return status;
  }
  if (int status = check_global_profile_description_contract()) {
    return status;
  }
  if (int status = check_required_attribute_validation()) {
    return status;
  }
  if (int status = check_global_geodetic_wmts_mapping()) {
    return status;
  }
  std::cout << "SDK smoke passed: vic_core_geo_base tilemap_config"
            << std::endl;
  return 0;
}
