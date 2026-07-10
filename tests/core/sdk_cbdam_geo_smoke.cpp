#include <vic/cbdam/geo/map_external_sampler.hpp>
#include <vic/cbdam/geo/map_mosaic_sampler.hpp>

#include <cmath>
#include <iostream>
#include <string>

namespace {

typedef vic::geo::map_sampler::aabox_t aabox_t;
typedef vic::geo::map_sampler::int32_t int32_t;

int fail(const std::string& message) {
  std::cerr << "CBDAM Geo SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(double actual, double expected, double tolerance) {
  return std::fabs(actual - expected) <= tolerance;
}

int32_t height_callback(void* context, double u, double v) {
  const int32_t offset = *static_cast<int32_t*>(context);
  return offset + static_cast<int32_t>(1000.0 * u) +
         static_cast<int32_t>(100.0 * v);
}

vic::geo::rgb8_color_t color_callback(void* context, double, double) {
  const int32_t offset = *static_cast<int32_t*>(context);
  vic::geo::rgb8_color_t color;
  color.r = static_cast<vic::geo::uint8_t>(10 + offset);
  color.g = static_cast<vic::geo::uint8_t>(60 + offset);
  color.b = static_cast<vic::geo::uint8_t>(110 + offset);
  return color;
}

class fake_tile_sampler : public vic::geo::map_sampler {
 public:
  fake_tile_sampler(const aabox_t& bounds, int32_t value, double spacing)
      : bounds_(bounds), value_(value), spacing_(spacing),
        loaded_sample_count_(0), minimized_(false) {}

  virtual bool is_empty() const { return bounds_.is_empty(); }

  virtual void minimize_footprint() const { minimized_ = true; }

  virtual sl::uint64_t stat_loaded_sample_count() const {
    return loaded_sample_count_;
  }

  virtual std::size_t band_count() const { return 1; }

  virtual bool sample_in(int32_t* sample, double u, double v) const {
    ++stat_requested_sample_count_;
    if (u < bounds_[0][0] || u > bounds_[1][0] ||
        v < bounds_[0][1] || v > bounds_[1][1]) {
      return false;
    }
    sample[0] = value_;
    ++loaded_sample_count_;
    return true;
  }

  virtual aabox_t bounding_rectangle() const { return bounds_; }

  virtual double minimum_sample_spacing(const aabox_t& b,
                                        double /*eps*/ = 0.0) const {
    if (b[0][0] > bounds_[1][0] || b[1][0] < bounds_[0][0] ||
        b[0][1] > bounds_[1][1] || b[1][1] < bounds_[0][1]) {
      return b.diagonal().two_norm();
    }
    return spacing_;
  }

  bool minimized() const { return minimized_; }

 private:
  aabox_t bounds_;
  int32_t value_;
  double spacing_;
  mutable sl::uint64_t loaded_sample_count_;
  mutable bool minimized_;
};

aabox_t make_box(double x0, double y0, double x1, double y1) {
  return aabox_t(sl::point2d(x0, y0), sl::point2d(x1, y1));
}

aabox_t make_empty_box() {
  aabox_t result;
  result.to_empty();
  return result;
}

int check_external_height_sampler() {
  int32_t offset = 7;
  vic::geo::map_height_int32_external_sampler sampler(
      0.25, 20.0, 10.0, &offset, height_callback, 2.0);

  if (sampler.is_empty() || sampler.band_count() != 1 ||
      sampler.unit_scale() != 64) {
    return fail("height external sampler metadata changed");
  }

  const int32_t absolute_value = sampler.value_at(0.0, 0.0);
  const int32_t expected_absolute =
      static_cast<int32_t>(2.0 * (7 + 500 + 50) * 64);
  if (absolute_value != expected_absolute) {
    return fail("height external sampler absolute value changed");
  }

  const int32_t parametric_value = sampler.value_at_parametric(0.25, 0.75);
  const int32_t expected_parametric =
      static_cast<int32_t>(2.0 * (7 + 250 + 75) * 64);
  if (parametric_value != expected_parametric) {
    return fail("height external sampler parametric value changed");
  }

  sampler.set_height_scale_factor(1.0);
  if (sampler.value_at_parametric(0.25, 0.75) !=
      static_cast<int32_t>((7 + 250 + 75) * 64)) {
    return fail("height external sampler scale factor changed");
  }

  aabox_t inside = make_box(-1.0, -1.0, 1.0, 1.0);
  aabox_t outside = make_box(20.0, 20.0, 22.0, 22.0);
  if (!near(sampler.minimum_sample_spacing(inside), 0.25, 1e-12)) {
    return fail("height external sampler spacing for inside bbox changed");
  }
  if (!near(sampler.minimum_sample_spacing(outside),
            outside.diagonal().two_norm(), 1e-12)) {
    return fail("height external sampler spacing for outside bbox changed");
  }

  sampler.set_callback(0, 0);
  if (!sampler.is_empty()) {
    return fail("height external sampler empty state changed");
  }

  return 0;
}

int check_external_rgb_sampler() {
  int32_t offset = 0;
  vic::geo::map_rgb_int16_8_external_sampler sampler(
      0.5, 2.0, 2.0, &offset, color_callback, 10, 110);

  if (sampler.is_empty() || sampler.band_count() != 3) {
    return fail("RGB external sampler metadata changed");
  }

  vic::geo::map_rgb_int16_8_external_sampler::value_t color =
      sampler.value_at(0.0, 0.0);
  if (color[0] != 0 || color[1] != 127 || color[2] != 254) {
    return fail("RGB external sampler remap changed");
  }

  sampler.set_remap_lo_hi(0, 255);
  color = sampler.value_at_parametric(0.25, 0.75);
  if (color[0] != 10 || color[1] != 60 || color[2] != 110) {
    return fail("RGB external sampler identity remap changed");
  }

  sampler.set_callback(0, 0);
  if (!sampler.is_empty()) {
    return fail("RGB external sampler empty state changed");
  }

  return 0;
}

int check_mosaic_sampler() {
  fake_tile_sampler tile_a(make_box(0.0, 0.0, 10.0, 10.0), 11, 0.5);
  fake_tile_sampler tile_b(make_box(10.0, 0.0, 20.0, 10.0), 22, 0.25);

  vic::geo::map_mosaic_sampler mosaic;
  mosaic.set_verbose(false);
  if (!mosaic.is_empty() || mosaic.tile_count() != 0 ||
      mosaic.band_count() != 0) {
    return fail("empty mosaic sampler metadata changed");
  }

  mosaic.insert(&tile_a);
  mosaic.insert(&tile_b);
  if (mosaic.tile_count() != 2 || mosaic.band_count() != 1 ||
      mosaic.is_empty()) {
    return fail("mosaic sampler insert metadata changed");
  }

  const aabox_t bounds = mosaic.bounding_rectangle();
  if (!near(bounds[0][0], 0.0, 1e-12) || !near(bounds[0][1], 0.0, 1e-12) ||
      !near(bounds[1][0], 20.0, 1e-12) || !near(bounds[1][1], 10.0, 1e-12)) {
    return fail("mosaic sampler bounding rectangle changed");
  }

  int32_t sample[1] = {0};
  if (!mosaic.sample_in(sample, 5.0, 5.0) || sample[0] != 11) {
    return fail("mosaic sampler first tile sample changed");
  }
  if (!mosaic.sample_in(sample, 15.0, 5.0) || sample[0] != 22) {
    return fail("mosaic sampler second tile sample changed");
  }
  if (mosaic.sample_in(sample, 30.0, 30.0)) {
    return fail("mosaic sampler outside sample unexpectedly succeeded");
  }
  if (mosaic.stat_requested_sample_count() != 3 ||
      mosaic.stat_loaded_sample_count() != 2) {
    return fail("mosaic sampler statistics changed");
  }

  const double spacing = mosaic.minimum_sample_spacing(make_box(11.0, 1.0,
                                                               12.0, 2.0));
  if (!near(spacing, 0.25, 1e-12)) {
    return fail("mosaic sampler minimum spacing changed");
  }

  mosaic.minimize_footprint();
  if (!tile_a.minimized() || !tile_b.minimized()) {
    return fail("mosaic sampler minimize_footprint no longer touches tiles");
  }

  mosaic.clear();
  if (!mosaic.is_empty() || mosaic.tile_count() != 0) {
    return fail("mosaic sampler clear changed");
  }

  return 0;
}

int check_mosaic_sampler_empty_tile_handling() {
  fake_tile_sampler empty_tile(make_empty_box(), 99, 0.125);
  fake_tile_sampler tile(make_box(1.0, 2.0, 3.0, 4.0), 33, 0.5);

  vic::geo::map_mosaic_sampler mosaic;
  mosaic.set_verbose(false);
  mosaic.insert(&empty_tile);
  if (!mosaic.is_empty() || mosaic.tile_count() != 1 ||
      mosaic.band_count() != 1) {
    return fail("mosaic sampler empty-tile metadata changed");
  }

  int32_t sample[1] = {0};
  if (mosaic.sample_in(sample, 2.0, 3.0)) {
    return fail("mosaic sampler unexpectedly sampled an empty tile");
  }
  if (mosaic.stat_requested_sample_count() != 1 ||
      mosaic.stat_loaded_sample_count() != 0 ||
      empty_tile.stat_requested_sample_count() != 0) {
    return fail("mosaic sampler empty-tile statistics changed");
  }

  mosaic.insert(&tile);
  if (mosaic.is_empty() || mosaic.tile_count() != 2 ||
      mosaic.band_count() != 1) {
    return fail("mosaic sampler non-empty insert after empty tile changed");
  }

  const aabox_t bounds = mosaic.bounding_rectangle();
  if (!near(bounds[0][0], 1.0, 1e-12) ||
      !near(bounds[0][1], 2.0, 1e-12) ||
      !near(bounds[1][0], 3.0, 1e-12) ||
      !near(bounds[1][1], 4.0, 1e-12)) {
    return fail("mosaic sampler empty tile affected bounding rectangle");
  }
  if (!mosaic.sample_in(sample, 2.0, 3.0) || sample[0] != 33) {
    return fail("mosaic sampler non-empty sample after empty tile changed");
  }

  return 0;
}

int check_mosaic_sampler_overlap_priority() {
  fake_tile_sampler first(make_box(0.0, 0.0, 10.0, 10.0), 101, 0.5);
  fake_tile_sampler second(make_box(5.0, 0.0, 15.0, 10.0), 202, 0.125);

  vic::geo::map_mosaic_sampler mosaic;
  mosaic.set_verbose(false);
  mosaic.insert(&first);
  mosaic.insert(&second);

  int32_t sample[1] = {0};
  if (!mosaic.sample_in(sample, 7.0, 5.0) || sample[0] != 101) {
    return fail("mosaic sampler overlapping tile priority changed");
  }
  if (first.stat_requested_sample_count() != 1 ||
      second.stat_requested_sample_count() != 0 ||
      mosaic.stat_requested_sample_count() != 1 ||
      mosaic.stat_loaded_sample_count() != 1) {
    return fail("mosaic sampler overlapping priority statistics changed");
  }

  if (!mosaic.sample_in(sample, 15.0, 5.0) || sample[0] != 202) {
    return fail("mosaic sampler second overlapping tile sample changed");
  }
  if (first.stat_requested_sample_count() != 1 ||
      second.stat_requested_sample_count() != 1 ||
      mosaic.stat_requested_sample_count() != 2 ||
      mosaic.stat_loaded_sample_count() != 2) {
    return fail("mosaic sampler second tile statistics changed");
  }

  const double spacing = mosaic.minimum_sample_spacing(make_box(6.0, 1.0,
                                                               8.0, 2.0));
  if (!near(spacing, 0.125, 1e-12)) {
    return fail("mosaic sampler overlapping spacing changed");
  }

  mosaic.stat_clear();
  first.stat_clear();
  second.stat_clear();
  if (mosaic.stat_requested_sample_count() != 0 ||
      mosaic.stat_loaded_sample_count() != 0 ||
      first.stat_requested_sample_count() != 0 ||
      second.stat_requested_sample_count() != 0) {
    return fail("mosaic sampler stat_clear state changed");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_external_height_sampler()) {
    return status;
  }
  if (int status = check_external_rgb_sampler()) {
    return status;
  }
  if (int status = check_mosaic_sampler()) {
    return status;
  }
  if (int status = check_mosaic_sampler_empty_tile_handling()) {
    return status;
  }
  if (int status = check_mosaic_sampler_overlap_priority()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_core_cbdam_geo samplers and mosaic priority"
            << std::endl;
  return 0;
}
