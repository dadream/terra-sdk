#include <vic/geo/base/tilemap_config.hpp>
#include <vic/geo/base/tms_root_resource.hpp>
#include <vic/geo/base/tms_service_resource.hpp>
#include <vic/geo/base/tms_tilemap_resource.hpp>
#include <vic/geo/base/victms_conventions.hpp>
#include <vic/xml/document.hpp>

#include <cmath>
#include <iostream>
#include <sstream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "VICTMS SDK smoke failed: " << message << std::endl;
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

int check_tilemap_description_roundtrip() {
  const std::string xml =
      "<tilemap name=\"victms-local\" profile=\"none\" "
      "mime-type=\"image/png\" extension=\"png\" max-level=\"6\" "
      "srs=\"EPSG:3857\" bbox_lo_0=\"100\" bbox_lo_1=\"200\" "
      "bbox_hi_0=\"356\" bbox_hi_1=\"456\" "
      "nu=\"1\" nv=\"1\" img_width=\"256\" img_height=\"256\"/>";

  vic::xml::document input_doc;
  vic::xml::node_iterator input_node = parse_tilemap(input_doc, xml);
  if (input_doc.error() || input_node.is_null()) {
    return fail("failed to parse input tilemap XML");
  }

  vic::geo::base::tilemap_config written;
  if (!written.parse(input_node)) {
    return fail("tilemap_config rejected input tilemap XML");
  }

  vic::xml::document roundtrip_doc;
  vic::xml::node_iterator roundtrip_node =
      parse_tilemap(roundtrip_doc, written.description());
  if (roundtrip_doc.error() || roundtrip_node.is_null()) {
    return fail("failed to parse tilemap_config description");
  }

  vic::geo::base::tilemap_config read;
  if (!read.parse(roundtrip_node)) {
    return fail("tilemap_config rejected its generated description");
  }

  if (read.name() != "victms-local" || read.profile() != "none" ||
      read.mime() != "image/png" || read.extension() != "png") {
    return fail("tilemap string fields changed during roundtrip");
  }
  if (read.max_level() != 6 || read.srs() != "EPSG:3857") {
    return fail("tilemap level/SRS changed during roundtrip");
  }
  if (!near(read.bbox_lo(0), 100.0) || !near(read.bbox_lo(1), 200.0) ||
      !near(read.bbox_hi(0), 356.0) || !near(read.bbox_hi(1), 456.0)) {
    return fail("tilemap bbox changed during roundtrip");
  }
  if (read.nu() != 1 || read.nv() != 1 ||
      read.img_width() != 256 || read.img_height() != 256) {
    return fail("tilemap image layout changed during roundtrip");
  }
  if (!near(read.units_per_pixel(0), 1.0)) {
    return fail("tilemap resolution changed during roundtrip");
  }

  return 0;
}

int check_tms_tilemap_resource_parse() {
  const std::string xml =
      "<TileMap version=\"1.0.0\" tilemapservice=\"local\">"
      "<Title>VICTMS Local</Title>"
      "<Abstract>Local texture pyramid</Abstract>"
      "<SRS>EPSG:4326</SRS>"
      "<BoundingBox minx=\"-180\" miny=\"-90\" maxx=\"180\" maxy=\"90\"/>"
      "<Origin x=\"-180\" y=\"-90\"/>"
      "<TileFormat width=\"256\" height=\"256\" "
      "mime-type=\"image/jpeg\" extension=\"jpg\"/>"
      "<TileSets profile=\"global-geodetic\">"
      "<TileSet href=\"file:///data/texture/0/\" "
      "units-per-pixel=\"0.703125\" order=\"0\"/>"
      "<TileSet href=\"file:///data/texture/1/\" "
      "units-per-pixel=\"0.3515625\" order=\"1\"/>"
      "</TileSets>"
      "</TileMap>";

  vic::geo::base::tms_tilemap_resource resource(xml);
  if (!resource.last_operation_success()) {
    return fail("failed to parse TMS TileMap resource: " +
                resource.last_error_message());
  }

  if (resource.version() != "1.0.0" || resource.service_url() != "local") {
    return fail("TMS TileMap version/service parsing changed");
  }
  if (resource.title() != "VICTMS Local" ||
      resource.abstract() != "Local texture pyramid" ||
      resource.srs() != "EPSG:4326") {
    return fail("TMS TileMap text fields parsing changed");
  }
  if (!near(resource.bounding_box()[0][0], -180.0) ||
      !near(resource.bounding_box()[0][1], -90.0) ||
      !near(resource.bounding_box()[1][0], 180.0) ||
      !near(resource.bounding_box()[1][1], 90.0)) {
    return fail("TMS TileMap bounding box parsing changed");
  }
  if (!near(resource.origin()[0], -180.0) ||
      !near(resource.origin()[1], -90.0)) {
    return fail("TMS TileMap origin parsing changed");
  }
  if (resource.img_width() != 256 || resource.img_height() != 256 ||
      resource.img_mime() != "image/jpeg" ||
      resource.img_extension() != "jpg") {
    return fail("TMS TileMap image format parsing changed");
  }
  if (resource.tileset_count() != 2 ||
      resource.tileset_url(0) != "file:///data/texture/0/" ||
      resource.tileset_url(1) != "file:///data/texture/1/") {
    return fail("TMS TileMap tileset URL parsing changed");
  }
  if (!near(resource.tileset_units_per_pixel(0), 0.703125) ||
      !near(resource.tileset_units_per_pixel(1), 0.3515625)) {
    return fail("TMS TileMap units-per-pixel parsing changed");
  }

  return 0;
}

int check_tms_root_resource_parse_and_roundtrip() {
  const std::string xml =
      "<Services>"
      "<TileMapService title=\"Primary TMS\" version=\"1.0.0\" "
      "href=\"file:///srv/tms/1.0.0\"/>"
      "<TileMapService title=\"Backup TMS\" version=\"1.1.0\" "
      "href=\"https://example.invalid/tms\"/>"
      "</Services>";

  vic::geo::base::tms_root_resource root(xml);
  if (!root.last_operation_success()) {
    return fail("failed to parse TMS root resource: " +
                root.last_error_message());
  }
  if (root.service_count() != 2 ||
      root.service_title(0) != "Primary TMS" ||
      root.service_version(0) != "1.0.0" ||
      root.service_url(0) != "file:///srv/tms/1.0.0" ||
      root.service_title(1) != "Backup TMS" ||
      root.service_version(1) != "1.1.0" ||
      root.service_url(1) != "https://example.invalid/tms") {
    return fail("TMS root service list parsing changed");
  }

  vic::geo::base::tms_root_resource roundtrip(root.description());
  if (!roundtrip.last_operation_success()) {
    return fail("failed to parse TMS root generated description: " +
                roundtrip.last_error_message());
  }
  if (roundtrip.service_count() != 2 ||
      roundtrip.service_title(0) != root.service_title(0) ||
      roundtrip.service_version(1) != root.service_version(1) ||
      roundtrip.service_url(1) != root.service_url(1)) {
    return fail("TMS root description roundtrip changed");
  }

  root.clear();
  root.insert_service("Manual TMS", "2.0.0", "file:///manual");
  if (root.service_count() != 1 ||
      root.service_title(0) != "Manual TMS" ||
      root.service_version(0) != "2.0.0" ||
      root.service_url(0) != "file:///manual") {
    return fail("TMS root manual insert changed");
  }

  return 0;
}

int check_tms_root_resource_validation() {
  const std::string xml =
      "<Services>"
      "<TileMapService title=\"Broken TMS\" version=\"1.0.0\"/>"
      "</Services>";

  vic::geo::base::tms_root_resource root(xml);
  if (root.last_operation_success() || root.service_count() != 0 ||
      root.last_error_message().empty()) {
    return fail("TMS root accepted service without href");
  }

  return 0;
}

int check_tms_service_resource_parse() {
  const std::string xml =
      "<TileMapService version=\"1.0.0\" services=\"file:///srv/tms\">"
      "<Title>Local Tile Service</Title>"
      "<Abstract>Terrain and texture layers</Abstract>"
      "<TileMaps>"
      "<TileMap title=\"Texture\" srs=\"EPSG:4326\" "
      "profile=\"global-geodetic\" href=\"file:///srv/tms/texture\"/>"
      "<TileMap title=\"Elevation\" srs=\"EPSG:3857\" "
      "profile=\"global-mercator\" href=\"file:///srv/tms/elevation\"/>"
      "</TileMaps>"
      "</TileMapService>";

  vic::geo::base::tms_service_resource service(xml);
  if (!service.last_operation_success()) {
    return fail("failed to parse TMS service resource: " +
                service.last_error_message());
  }
  if (service.version() != "1.0.0" ||
      service.root_url() != "file:///srv/tms" ||
      service.title() != "Local Tile Service" ||
      service.abstract() != "Terrain and texture layers") {
    return fail("TMS service metadata parsing changed");
  }
  if (service.tilemap_count() != 2 ||
      service.tilemap_title(0) != "Texture" ||
      service.tilemap_srs(0) != "EPSG:4326" ||
      service.tilemap_profile(0) != "global-geodetic" ||
      service.tilemap_url(0) != "file:///srv/tms/texture" ||
      service.tilemap_title(1) != "Elevation" ||
      service.tilemap_srs(1) != "EPSG:3857" ||
      service.tilemap_profile(1) != "global-mercator" ||
      service.tilemap_url(1) != "file:///srv/tms/elevation") {
    return fail("TMS service tilemap list parsing changed");
  }

  service.clear();
  if (service.tilemap_count() != 0 ||
      service.title() != "Tile Map Service" ||
      service.abstract() != "Tile Map Service Default Abstract") {
    return fail("TMS service clear defaults changed");
  }
  service.insert_tilemap("Manual", "EPSG:4326", "none", "file:///manual");
  if (service.tilemap_count() != 1 ||
      service.tilemap_title(0) != "Manual" ||
      service.tilemap_srs(0) != "EPSG:4326" ||
      service.tilemap_profile(0) != "none" ||
      service.tilemap_url(0) != "file:///manual") {
    return fail("TMS service manual insert changed");
  }

  return 0;
}

int check_tms_service_resource_validation() {
  const std::string xml =
      "<TileMapService version=\"1.0.0\" services=\"file:///srv/tms\">"
      "<Title>Broken Service</Title>"
      "<TileMaps>"
      "<TileMap title=\"Broken\" srs=\"EPSG:4326\" "
      "profile=\"global-geodetic\"/>"
      "</TileMaps>"
      "</TileMapService>";

  vic::geo::base::tms_service_resource service(xml);
  if (service.last_operation_success() || service.tilemap_count() != 0 ||
      service.last_error_message().empty()) {
    return fail("TMS service accepted tilemap without href");
  }

  return 0;
}

int check_victms_quad_filename() {
  using vic::geo::base::victms_conventions;

  const std::string first =
      victms_conventions::quad_filename("/data/tiles", 0, 0, 0);
  if (first != "/data/tiles/00/0000/0000/0000/0000.jpg") {
    return fail("default root tile filename changed: " + first);
  }

  const std::string nested =
      victms_conventions::quad_filename("/data/tiles", 7, 8193, 4098, "png");
  if (nested != "/data/tiles/07/0001/0002/0002/0001.png") {
    return fail("nested tile filename changed: " + nested);
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_tilemap_description_roundtrip()) {
    return status;
  }
  if (int status = check_tms_tilemap_resource_parse()) {
    return status;
  }
  if (int status = check_tms_root_resource_parse_and_roundtrip()) {
    return status;
  }
  if (int status = check_tms_root_resource_validation()) {
    return status;
  }
  if (int status = check_tms_service_resource_parse()) {
    return status;
  }
  if (int status = check_tms_service_resource_validation()) {
    return status;
  }
  if (int status = check_victms_quad_filename()) {
    return status;
  }
  std::cout << "SDK smoke passed: vic_core_geo_base VICTMS and TMS resources"
            << std::endl;
  return 0;
}
