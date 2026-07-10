#include <vic/img/gl_image.hpp>
#include <vic/img/gl_quadtree_image_processor.hpp>

#include <iostream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "SDK smoke failed: " << message << std::endl;
  return 1;
}

int blended_channel(int dst, int src, int src_alpha_plus_one) {
  return dst + (((src - dst) * src_alpha_plus_one + (1 << 7)) >> 8);
}

unsigned char legacy_blended_alpha(int dst_alpha_after_channel_blend,
                                   int src_alpha_plus_one) {
  // Mirrors the current legacy operator precedence in blend_in().
  const int result = (255 - ((256 - src_alpha_plus_one) *
                            (255 - dst_alpha_after_channel_blend) +
                            ((1 << 9) - 1))) >> 8;
  return static_cast<unsigned char>(result);
}

int check_gl_image_layout() {
  vic::img::gl_image<unsigned char> image(3, 2, 2);
  if (image.channels() != 3 || image.width() != 2 ||
      image.height() != 2 || image.depth() != 1 || image.size() != 12 ||
      image.offset(1, 0) != 3 || image.offset(0, 1) != 6) {
    return fail("vic_base_img gl_image extents or offsets changed");
  }

  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      for (int c = 0; c < 3; ++c) {
        image(c, x, y) = static_cast<unsigned char>(100 * y + 10 * x + c);
      }
    }
  }
  if (image.to_pointer()[0] != 0 || image.to_pointer()[1] != 1 ||
      image.to_pointer()[2] != 2 || image.to_pointer()[3] != 10 ||
      image.to_pointer()[6] != 100 || image.to_pointer()[11] != 112 ||
      image.front() != 0 || image.back() != 112) {
    return fail("vic_base_img gl_image linear storage changed");
  }

  image.fill(7, 8, 9);
  if (image.to_pointer()[0] != 7 || image.to_pointer()[1] != 8 ||
      image.to_pointer()[2] != 9 || image.to_pointer()[9] != 7 ||
      image.to_pointer()[10] != 8 || image.to_pointer()[11] != 9) {
    return fail("vic_base_img gl_image repeated fill changed");
  }

  image.fill_channel(1, 42);
  if (image(1, 0, 0) != 42 || image(1, 1, 0) != 42 ||
      image(1, 0, 1) != 42 || image(1, 1, 1) != 42 ||
      image(0, 0, 0) != 7 || image(2, 1, 1) != 9) {
    return fail("vic_base_img gl_image channel fill changed");
  }

  unsigned short source_data[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  vic::img::gl_image<unsigned char> converted;
  converted.assign(source_data, 2, 2, 2);
  if (converted.channels() != 2 || converted.width() != 2 ||
      converted.height() != 2 || converted(0, 0, 0) != 1 ||
      converted(1, 1, 1) != 8) {
    return fail("vic_base_img gl_image typed assignment changed");
  }

  vic::img::gl_image<unsigned char> alpha(4, 2, 1);
  alpha(0, 0, 0) = 1;
  alpha(1, 0, 0) = 2;
  alpha(2, 0, 0) = 3;
  alpha(3, 0, 0) = 99;
  alpha(0, 1, 0) = 20;
  alpha(1, 1, 0) = 20;
  alpha(2, 1, 0) = 20;
  alpha(3, 1, 0) = 99;
  alpha.set_alpha_from_black(10);
  if (alpha(3, 0, 0) != 0 || alpha(3, 1, 0) != 255) {
    return fail("vic_base_img gl_image alpha-from-black changed");
  }

  alpha.set_alpha_from_value();
  if (alpha(3, 0, 0) != 2 || alpha(3, 1, 0) != 20) {
    return fail("vic_base_img gl_image alpha-from-value changed");
  }

  return 0;
}

int check_quadtree_magnify() {
  typedef vic::img::gl_image<unsigned char> image_t;

  image_t src(1, 4, 4);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      src(0, x, y) = static_cast<unsigned char>(10 * y + x);
    }
  }

  image_t dst(1, 4, 4);
  dst.fill(0);
  vic::img::gl_quadtree_image_processor processor;
  processor.magnify_in(dst, 1, 1, 0, src, 0, 0, 0);

  const unsigned char expected[4][4] = {
      {2, 2, 3, 3},
      {2, 2, 3, 3},
      {12, 12, 13, 13},
      {12, 12, 13, 13}};
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      if (dst(0, x, y) != expected[y][x]) {
        return fail("vic_base_img quadtree magnify output changed");
      }
    }
  }

  image_t copied(1, 4, 4);
  processor.magnify_in(copied, 0, 0, 0, src, 0, 0, 0);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      if (copied(0, x, y) != src(0, x, y)) {
        return fail("vic_base_img quadtree magnify copy path changed");
      }
    }
  }

  return 0;
}

int check_quadtree_blend() {
  typedef vic::img::gl_image<unsigned char> image_t;

  image_t src(4, 1, 1);
  src(0, 0, 0) = 110;
  src(1, 0, 0) = 120;
  src(2, 0, 0) = 130;
  src(3, 0, 0) = 127;

  image_t rgba_dst(4, 1, 1);
  rgba_dst(0, 0, 0) = 10;
  rgba_dst(1, 0, 0) = 20;
  rgba_dst(2, 0, 0) = 30;
  rgba_dst(3, 0, 0) = 40;

  vic::img::gl_quadtree_image_processor processor;
  processor.blend_in(rgba_dst, src);

  const int src_alpha_plus_one = 128;
  const int expected_alpha_channel =
      blended_channel(40, 127, src_alpha_plus_one);
  if (rgba_dst(0, 0, 0) != blended_channel(10, 110, src_alpha_plus_one) ||
      rgba_dst(1, 0, 0) != blended_channel(20, 120, src_alpha_plus_one) ||
      rgba_dst(2, 0, 0) != blended_channel(30, 130, src_alpha_plus_one) ||
      rgba_dst(3, 0, 0) !=
          legacy_blended_alpha(expected_alpha_channel, src_alpha_plus_one)) {
    return fail("vic_base_img quadtree RGBA blend output changed");
  }

  image_t rgb_dst(3, 1, 1);
  rgb_dst(0, 0, 0) = 10;
  rgb_dst(1, 0, 0) = 20;
  rgb_dst(2, 0, 0) = 30;
  processor.blend_in(rgb_dst, src);
  if (rgb_dst(0, 0, 0) != blended_channel(10, 110, src_alpha_plus_one) ||
      rgb_dst(1, 0, 0) != blended_channel(20, 120, src_alpha_plus_one) ||
      rgb_dst(2, 0, 0) != blended_channel(30, 130, src_alpha_plus_one)) {
    return fail("vic_base_img quadtree RGB blend output changed");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_gl_image_layout()) {
    return status;
  }
  if (int status = check_quadtree_magnify()) {
    return status;
  }
  if (int status = check_quadtree_blend()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_img gl_image and quadtree processor"
            << std::endl;
  return 0;
}
