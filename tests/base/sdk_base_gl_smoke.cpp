#include <vic/gl/font.hpp>

#include <cmath>
#include <iostream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "GL SDK smoke failed: " << message << std::endl;
  return 1;
}

bool near(float actual, float expected, float tolerance = 1e-4f) {
  return std::fabs(actual - expected) <= tolerance;
}

int check_font_metrics_without_gl_context() {
  vic::gl::font font;
  if (!font.is_proportional() || !near(font.scale_x(), 32.0f) ||
      !near(font.scale_y(), 32.0f) || !near(font.spacing(), 0.05f)) {
    return fail("default embedded font metadata changed");
  }

  font.set_spacing(0.0f);
  font.set_scaling(10.0f, 20.0f);
  font.set_proportional(false);
  if (font.is_proportional() || !near(font.scale_x(), 10.0f) ||
      !near(font.scale_y(), 20.0f) || !near(font.spacing(), 0.0f)) {
    return fail("font fixed-mode metadata changed");
  }

  const float fixed_width = font.string_width("ABC");
  if (!near(fixed_width, 33.0f)) {
    return fail("font fixed-width string metrics changed");
  }

  float x0 = 0.0f;
  float y0 = 0.0f;
  float x1 = 0.0f;
  float y1 = 0.0f;
  font.string_bbox("ABC", x0, y0, x1, y1);
  if (!near(x0, 0.0f) || !near(y0, 0.0f) ||
      !near(x1, fixed_width) || !near(y1, 20.0f)) {
    return fail("font fixed-mode bbox changed");
  }

  font.set_proportional(true);
  font.set_spacing(0.0f);
  font.set_scaling(10.0f, 20.0f);
  const float narrow_width = font.string_width("III");
  const float wide_width = font.string_width("WWW");
  if (!font.is_proportional() || narrow_width <= 0.0f ||
      wide_width <= narrow_width || wide_width >= fixed_width) {
    return fail("font proportional metrics changed");
  }

  font.set_spacing(0.25f);
  const float spaced_width = font.string_width("III");
  if (spaced_width <= narrow_width) {
    return fail("font spacing no longer increases string width");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_font_metrics_without_gl_context()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_gl font metrics"
            << std::endl;
  return 0;
}
