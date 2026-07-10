#include <vic/cbdam/base/coordinate_transform.hpp>
#include <vic/ratman/oriented_position.hpp>
#include <vic/ratman/ratman.hpp>
#include <vic/ratman/string_utility.hpp>

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

namespace {

int fail(const std::string& message) {
  std::cerr << "Ratman core SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected, double tolerance = 1e-9) {
  return std::fabs(actual - expected) <= tolerance;
}

template <typename Actual, typename Expected>
bool near_triplet(const Actual& actual,
                  const Expected& expected,
                  double tolerance = 1e-9) {
  return near(actual[0], expected[0], tolerance) &&
         near(actual[1], expected[1], tolerance) &&
         near(actual[2], expected[2], tolerance);
}

int check_string_utility() {
  if (ratman::string_utility::to_lower("MiXeD-123") != "mixed-123") {
    return fail("string_utility::to_lower changed");
  }

  std::vector<std::string> fields;
  ratman::string_utility::split("alpha,beta,,gamma", ",", fields);
  if (fields.size() != 4 || fields[0] != "alpha" || fields[1] != "beta" ||
      fields[2] != "" || fields[3] != "gamma") {
    return fail("string_utility::split no longer preserves empty fields");
  }

  if (ratman::string_utility::convert_into<int>("42") != 42) {
    return fail("string_utility::convert_into<int> changed");
  }
  if (!near(ratman::string_utility::convert_into<double>("3.25"), 3.25)) {
    return fail("string_utility::convert_into<double> changed");
  }

  return 0;
}

int check_oriented_position_planar_camera() {
  cbdam::planar_coordinate_transform::aabox_t bounds(
      cbdam::planar_coordinate_transform::point2d_t(0.0, 0.0),
      cbdam::planar_coordinate_transform::point2d_t(10.0, 10.0));
  cbdam::planar_coordinate_transform transform(bounds);

  ratman::oriented_position nadir(
      &transform,
      ratman::point2d_t(2.0, 3.0),
      10.0,
      0.0,
      0.0);
  if (!nadir.is_valid()) {
    return fail("oriented_position unexpectedly invalid with planar transform");
  }
  if (!near_triplet(nadir.ground_target_xyz(), ratman::point3d_t(2.0, 3.0, 0.0))) {
    return fail("oriented_position ground target changed");
  }
  if (!near_triplet(nadir.local_direction_xyz(), ratman::point3d_t(0.0, 0.0, 1.0))) {
    return fail("oriented_position nadir direction changed");
  }
  if (!near_triplet(nadir.position_xyz(), ratman::point3d_t(2.0, 3.0, 10.0))) {
    return fail("oriented_position nadir camera position changed");
  }

  ratman::oriented_position tilted(
      &transform,
      ratman::point2d_t(2.0, 3.0),
      10.0,
      ratman::deg2rad(90.0),
      ratman::deg2rad(90.0));
  if (!near_triplet(tilted.local_direction_xyz(), ratman::point3d_t(1.0, 0.0, 0.0), 1e-8)) {
    return fail("oriented_position yaw/tilt direction changed");
  }
  if (!near_triplet(tilted.position_xyz(), ratman::point3d_t(12.0, 3.0, 0.0), 1e-8)) {
    return fail("oriented_position yaw/tilt camera position changed");
  }

  ratman::oriented_position far(
      &transform,
      ratman::point2d_t(2.0, 3.0),
      20.0,
      ratman::deg2rad(30.0),
      ratman::deg2rad(60.0));
  const ratman::oriented_position mid = nadir.lerp(far, 0.25);
  if (!near(mid.distance_from_target(), 12.5) ||
      !near(mid.yaw(), ratman::deg2rad(7.5)) ||
      !near(mid.tilt(), ratman::deg2rad(15.0))) {
    return fail("oriented_position interpolation changed");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_string_utility()) {
    return status;
  }
  if (int status = check_oriented_position_planar_camera()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_core_ratman string utility and oriented position"
            << std::endl;
  return 0;
}
