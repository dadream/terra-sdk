#include <vic/geo/base/tilemap_config.hpp>
#include <vic/xml/document.hpp>

#include <cmath>
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
  std::cout << "SDK smoke passed: vic_core_geo_base tilemap_config"
            << std::endl;
  return 0;
}
