#include <vic/geo/builder/color_remap_transform.hpp>
#include <vic/geo/builder/geo_transform.hpp>
#include <vic/geo/builder/geo_utility.hpp>
#include <vic/geo/builder/quad_accessor.hpp>

#include <gdal_priv.h>

#include <cmath>
#include <cstdio>
#include <iostream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {

int fail(const std::string& message) {
  std::cerr << "Geo builder SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected, double tolerance) {
  return std::fabs(actual - expected) <= tolerance;
}

std::string temp_dir(const std::string& suffix) {
  char buffer[256];
  snprintf(buffer, sizeof(buffer), "/tmp/terra_sdk_geo_builder_%ld_%s",
           static_cast<long>(getpid()), suffix.c_str());
  return std::string(buffer);
}

int check_geo_utility_and_matrix() {
  const std::string cleaned =
      vic::geo::geo_utility::clean_path("//tmp///terra//sdk//geo_builder/");
  if (cleaned != "/tmp/terra/sdk/geo_builder") {
    return fail("geo_utility clean_path changed: " + cleaned);
  }

  const std::string root = temp_dir("mkpath");
  const std::string nested = root + "/a/b/c";
  if (!vic::geo::geo_utility::mkpath(nested) ||
      !vic::geo::geo_utility::has_dir(nested)) {
    return fail("geo_utility mkpath/has_dir changed");
  }
  rmdir((root + "/a/b/c").c_str());
  rmdir((root + "/a/b").c_str());
  rmdir((root + "/a").c_str());
  rmdir(root.c_str());

  vic::geo::geo_matrix matrix(10.0, 20.0, 2.0, -3.0);
  sl::fixed_size_array<6, double> gdal =
      vic::geo::geo_utility::gdal_array(matrix.mat());
  if (!near(gdal[0], 10.0, 1e-12) || !near(gdal[1], 2.0, 1e-12) ||
      !near(gdal[2], 0.0, 1e-12) || !near(gdal[3], 20.0, 1e-12) ||
      !near(gdal[4], 0.0, 1e-12) || !near(gdal[5], -3.0, 1e-12)) {
    return fail("geo_matrix to GDAL array conversion changed");
  }

  const std::string wgs84 = vic::geo::geo_utility::proj2srs("EPSG:4326");
  if (wgs84.empty() || wgs84.find("WGS") == std::string::npos) {
    return fail("geo_utility proj2srs EPSG:4326 parsing changed");
  }

  return 0;
}

int check_quad_accessor() {
  GDALAllRegister();

  vic::geo::quad_accessor accessor;
  if (!accessor.last_operation_success()) {
    return fail("new quad_accessor starts in failed state");
  }

  accessor.set_root_dir("/data/tiles");
  accessor.set_file_extension("png");
  accessor.set_quadtree_root_count(2, 3);
  if (accessor.quadtree_root_count(0) != 2 ||
      accessor.quadtree_root_count(1) != 3 ||
      accessor.level_quad_count(3, 0) != 16 ||
      accessor.level_quad_count(3, 1) != 24) {
    return fail("quad_accessor quadtree counts changed");
  }

  const std::string filename = accessor.quad_filename(7, 8193, 4098);
  if (filename != "/data/tiles/07/0001/0002/0002/0001.png") {
    return fail("quad_accessor filename convention changed: " + filename);
  }

  accessor.set_output_format("GTiff");
  if (!accessor.last_operation_success()) {
    return fail("quad_accessor rejected GDAL GTiff output format");
  }
  accessor.set_output_format("NO_SUCH_GDAL_DRIVER_FOR_TERRA_SDK_TEST");
  if (accessor.last_operation_success() ||
      accessor.last_error_message().find("Unable to set output format") ==
          std::string::npos) {
    return fail("quad_accessor invalid output format handling changed");
  }
  accessor.reset_error();
  if (!accessor.last_operation_success() || !accessor.last_error_message().empty()) {
    return fail("quad_accessor reset_error changed");
  }

  return 0;
}

int check_color_remap_transform() {
  vic::geo::color_remap_transform identity;
  if (!identity.is_identity()) {
    return fail("default color_remap_transform is no longer identity");
  }

  vic::geo::color_remap_transform contrast(10, 20, 240, 220, 5, 250);
  if (contrast.is_identity()) {
    return fail("non-default color_remap_transform reported identity");
  }
  if (!identity.to_pointer() || !contrast.to_pointer()) {
    return fail("color_remap_transform to_pointer changed");
  }

  return 0;
}

int check_geo_transform_identity() {
  GDALAllRegister();

  vic::geo::geo_transform transform("EPSG:4326", "EPSG:4326", 0.0);
  if (transform.src_srs().empty() || transform.dst_srs().empty() ||
      !near(transform.max_error(), 0.0, 1e-12)) {
    return fail("geo_transform EPSG:4326 creation changed");
  }

  double x = 12.5;
  double y = 45.25;
  double z = 7.0;
  int success = 0;
  GDALTransformerFunc fn = transform.get_trasformation();
  if (!fn(transform.to_pointer(), 0, 1, &x, &y, &z, &success) || !success) {
    return fail("geo_transform identity callback failed");
  }
  if (!near(x, 12.5, 1e-10) || !near(y, 45.25, 1e-10) ||
      !near(z, 7.0, 1e-10)) {
    return fail("geo_transform EPSG:4326 identity result changed");
  }

  vic::geo::geo_transform copy(transform);
  if (copy.src_srs().empty() || copy.dst_srs().empty()) {
    return fail("geo_transform copy constructor changed");
  }

  vic::geo::geo_transform assigned;
  assigned = transform;
  if (assigned.src_srs().empty() || assigned.dst_srs().empty()) {
    return fail("geo_transform assignment changed");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_geo_utility_and_matrix()) {
    return status;
  }
  if (int status = check_quad_accessor()) {
    return status;
  }
  if (int status = check_color_remap_transform()) {
    return status;
  }
  if (int status = check_geo_transform_identity()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_core_geo_builder utility and transforms"
            << std::endl;
  return 0;
}
