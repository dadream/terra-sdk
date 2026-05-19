//+++HDR+++
//======================================================================
//  This file is part of the SL software library.
//
//  Copyright (C) 1993-2010 by Enrico Gobbetti (gobbetti@crs4.it)
//  Copyright (C) 1996-2010 by CRS4 Visual Computing Group, Pula, Italy
//
//  For more information, visit the CRS4 Visual Computing Group 
//  web pages at http://www.crs4.it/vvr/.
//
//  This file may be used under the terms of the GNU General Public
//  License as published by the Free Software Foundation and appearing
//  in the file LICENSE included in the packaging of this file.
//
//  CRS4 reserves all rights not expressly granted herein.
//  
//  This file is provided AS IS with NO WARRANTY OF ANY KIND, 
//  INCLUDING THE WARRANTY OF DESIGN, MERCHANTABILITY AND FITNESS 
//  FOR A PARTICULAR PURPOSE.
//
//======================================================================
//---HDR---//
/////// ALWAYS TEST IN DEBUG MODE
#if !(defined(__sgi) && !defined(__GNUC__))
#  undef NDEBUG
#endif
///////

#include <sl/utility.hpp>
#include <sl/tester.hpp>
#include <sl/ball.hpp>

//--------------------

static std::size_t failed_test_count = 0;

//--------------------

typedef double value_t;
typedef sl::point3d point_t;
typedef sl::intervald interval_t;

void test_miniball() {
  typedef double value_t;
  const int       d = 3;
  const int       np = 100000;
  const int       nb = 1000;

  sl::ball_builder<d,value_t> mb;
  sl::random::uniform<value_t> rng;

  sl::tester tester(std::string() + "ball_builder < " + sl::to_string(d) + ", " + sl::numeric_traits<value_t>::what() + " >");
  
  rng.set_seed(1999);
  mb.begin_model();
  for (int i=0; i<np; ++i) {
    sl::ball_builder<d,value_t>::point_t p;
    for (int j=0; j<d; ++j) {
      p[j] = rng.value();
    }
    mb.put_point(p);
  }
  mb.end_model();

  tester.test("mbp center", (mb.last_bounding_volume().center() - point_t(0.5f, 0.5f, 0.5f)).two_norm(), interval_t("0.0"));
  tester.test("mbp radius", mb.last_bounding_volume().radius(), interval_t("0.85"));
  tester.test("mbp volume", mb.last_bounding_volume().volume(), interval_t("2.55"));
  
  
  rng.set_seed(1999);
  mb.begin_model();
  for (int i=0; i<nb; ++i) {
    sl::ball_builder<d,value_t>::point_t p;
    for (int j=0; j<d; ++j) {
      p[j] = rng.value();
    }
    mb.put_ball(sl::ball<d,value_t>(p,rng.value()));
  }
  mb.end_model();

  tester.test("mbb center", (mb.last_bounding_volume().center() - point_t(0.5f, 0.5f, 0.5f)).two_norm(), interval_t("0."));
  tester.test("mbb radius", mb.last_bounding_volume().radius(), interval_t("1.6"));
  tester.test("mbb volume", mb.last_bounding_volume().volume(), interval_t("18"));

  failed_test_count += tester.failed_test_count();
}


int main() {
  test_miniball();
  return (int)failed_test_count;
}
