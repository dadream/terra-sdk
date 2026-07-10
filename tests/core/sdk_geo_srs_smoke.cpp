#include <vic/geo/srs/spatial_reference.hpp>

#include <cmath>
#include <iostream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "Geo SRS SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected, double tolerance) {
  return std::fabs(actual - expected) <= tolerance;
}

int check_wgs84_reference() {
  vic::geo::srs::spatial_reference wgs84("EPSG:4326");
  if (!wgs84.is_valid()) {
    return fail("EPSG:4326 did not produce a valid spatial reference");
  }
  if (!wgs84.is_geographic() || wgs84.is_projected() || wgs84.is_local()) {
    return fail("EPSG:4326 classification changed");
  }
  if (wgs84.description().find("WGS 84") == std::string::npos &&
      wgs84.description().find("WGS_1984") == std::string::npos) {
    return fail("EPSG:4326 WKT description no longer identifies WGS84");
  }
  if (!near(wgs84.angular_units(), M_PI / 180.0, 1e-15)) {
    return fail("EPSG:4326 angular units changed");
  }
  if (!near(wgs84.spheroid_semi_major(), 6378137.0, 1e-6)) {
    return fail("EPSG:4326 semi-major axis changed");
  }

  const vic::geo::srs::spatial_reference copy(wgs84);
  if (!copy.is_valid() || !copy.is_geographic()) {
    return fail("spatial_reference copy constructor changed");
  }

  vic::geo::srs::spatial_reference assigned;
  assigned = wgs84;
  if (!assigned.is_valid() || !assigned.is_geographic()) {
    return fail("spatial_reference assignment changed");
  }

  return 0;
}

int check_projected_reference_and_transform() {
  vic::geo::srs::spatial_reference web_mercator("EPSG:3857");
  if (!web_mercator.is_valid()) {
    return fail("EPSG:3857 did not produce a valid spatial reference");
  }
  if (!web_mercator.is_projected() || web_mercator.is_geographic()) {
    return fail("EPSG:3857 classification changed");
  }
  if (!near(web_mercator.linear_units(), 1.0, 1e-12)) {
    return fail("EPSG:3857 linear units changed");
  }

  vic::geo::srs::spatial_reference::point2d_t origin_lonlat(0.0, 0.0);
  const vic::geo::srs::spatial_reference::point2d_t origin_projected =
      web_mercator.from_WGS84_lonlat(origin_lonlat);
  if (!vic::geo::srs::spatial_reference_transformation::is_valid(
          origin_projected)) {
    return fail("WGS84 to EPSG:3857 transformation became invalid");
  }
  if (!near(origin_projected[0], 0.0, 1e-8) ||
      !near(origin_projected[1], 0.0, 1e-8)) {
    return fail("WGS84 origin no longer maps to EPSG:3857 origin");
  }

  const vic::geo::srs::spatial_reference::point2d_t origin_roundtrip =
      web_mercator.to_WGS84_lonlat(origin_projected);
  if (!vic::geo::srs::spatial_reference_transformation::is_valid(
          origin_roundtrip)) {
    return fail("EPSG:3857 to WGS84 transformation became invalid");
  }
  if (!near(origin_roundtrip[0], 0.0, 1e-12) ||
      !near(origin_roundtrip[1], 0.0, 1e-12)) {
    return fail("EPSG:3857 origin roundtrip changed");
  }

  vic::geo::srs::spatial_reference::point3d_t origin3_lonlat(0.0, 0.0, 42.0);
  const vic::geo::srs::spatial_reference::point3d_t origin3_projected =
      web_mercator.from_WGS84_lonlat(origin3_lonlat);
  if (!vic::geo::srs::spatial_reference_transformation::is_valid(
          origin3_projected) ||
      !near(origin3_projected[2], 42.0, 1e-12)) {
    return fail("3D WGS84 to EPSG:3857 transformation changed altitude");
  }

  return 0;
}

int check_invalid_reference() {
  vic::geo::srs::spatial_reference invalid("NOT_A_REAL_SRS");
  if (invalid.is_valid()) {
    return fail("invalid SRS input unexpectedly produced a valid reference");
  }
  if (invalid.description() != "INVALID") {
    return fail("invalid SRS description changed");
  }

  vic::geo::srs::spatial_reference::point2d_t p(1.0, 2.0);
  const vic::geo::srs::spatial_reference::point2d_t transformed =
      invalid.to_WGS84_lonlat(p);
  if (vic::geo::srs::spatial_reference_transformation::is_valid(transformed)) {
    return fail("invalid SRS transformation unexpectedly succeeded");
  }

  invalid.reset("EPSG:4326");
  if (!invalid.is_valid() || !invalid.is_geographic()) {
    return fail("reset from invalid SRS to EPSG:4326 changed");
  }
  invalid.clear();
  if (invalid.is_valid()) {
    return fail("spatial_reference clear no longer invalidates the object");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_wgs84_reference()) {
    return status;
  }
  if (int status = check_projected_reference_and_transform()) {
    return status;
  }
  if (int status = check_invalid_reference()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_core_geo_srs spatial_reference"
            << std::endl;
  return 0;
}
