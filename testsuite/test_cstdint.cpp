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

#include <sl/cstdint.hpp>
#include <sl/tester.hpp>

#include <cstdint>
#include <limits>

static std::size_t failed_test_count = 0;

template <class SL_T, class STD_T, int Bits, bool IsSigned>
void check_fixed_width_type(sl::tester& tester, const std::string& name) {
  static_assert(sizeof(SL_T) == sizeof(STD_T), "sl fixed-width integer type must match std fixed-width type size");
  static_assert(sizeof(SL_T) * 8 == Bits, "sl fixed-width integer type has unexpected bit width");
  static_assert(std::numeric_limits<SL_T>::is_signed == IsSigned, "sl fixed-width integer type has unexpected signedness");

  tester.test(name + " size", sizeof(SL_T), sizeof(STD_T));
  tester.test(name + " signed", std::numeric_limits<SL_T>::is_signed, IsSigned);
}

template <class SL_T, int Bits, bool IsSigned>
void check_least_or_fast_type(sl::tester& tester, const std::string& name) {
  static_assert(sizeof(SL_T) * 8 >= Bits, "sl least/fast integer type is too narrow");
  static_assert(std::numeric_limits<SL_T>::is_signed == IsSigned, "sl least/fast integer type has unexpected signedness");

  tester.test(name + " minimum size", sizeof(SL_T) * 8 >= std::size_t(Bits));
  tester.test(name + " signed", std::numeric_limits<SL_T>::is_signed, IsSigned);
}

void check_literal_macros(sl::tester& tester) {
  using sl::int8_t;
  using sl::int16_t;
  using sl::int32_t;
  using sl::uint8_t;
  using sl::uint16_t;
  using sl::uint32_t;

  tester.test("SL_INT8_C", int(SL_INT8_C(12)), int(int8_t(12)));
  tester.test("SL_UINT8_C", int(SL_UINT8_C(250)), int(uint8_t(250)));
  tester.test("SL_INT16_C", int(SL_INT16_C(-1234)), int(int16_t(-1234)));
  tester.test("SL_UINT16_C", int(SL_UINT16_C(54321)), int(uint16_t(54321)));
  tester.test("SL_INT32_C", SL_INT32_C(-123456), int32_t(-123456));
  tester.test("SL_UINT32_C", SL_UINT32_C(123456), uint32_t(123456));

#if defined(SL_INT64_C) && defined(SL_UINT64_C)
  using sl::int64_t;
  using sl::uint64_t;
  tester.test("SL_INT64_C", SL_INT64_C(-123456789), int64_t(-123456789));
  tester.test("SL_UINT64_C", SL_UINT64_C(123456789), uint64_t(123456789));
#endif
}

int main() {
  sl::tester tester("cstdint aliases");

  check_fixed_width_type<sl::int8_t, std::int8_t, 8, true>(tester, "int8_t");
  check_fixed_width_type<sl::uint8_t, std::uint8_t, 8, false>(tester, "uint8_t");
  check_fixed_width_type<sl::int16_t, std::int16_t, 16, true>(tester, "int16_t");
  check_fixed_width_type<sl::uint16_t, std::uint16_t, 16, false>(tester, "uint16_t");
  check_fixed_width_type<sl::int32_t, std::int32_t, 32, true>(tester, "int32_t");
  check_fixed_width_type<sl::uint32_t, std::uint32_t, 32, false>(tester, "uint32_t");

#if defined(SL_INT64_C) && defined(SL_UINT64_C)
  check_fixed_width_type<sl::int64_t, std::int64_t, 64, true>(tester, "int64_t");
  check_fixed_width_type<sl::uint64_t, std::uint64_t, 64, false>(tester, "uint64_t");
#endif

  check_least_or_fast_type<sl::int_least8_t, 8, true>(tester, "int_least8_t");
  check_least_or_fast_type<sl::uint_least8_t, 8, false>(tester, "uint_least8_t");
  check_least_or_fast_type<sl::int_fast8_t, 8, true>(tester, "int_fast8_t");
  check_least_or_fast_type<sl::uint_fast8_t, 8, false>(tester, "uint_fast8_t");
  check_least_or_fast_type<sl::int_least16_t, 16, true>(tester, "int_least16_t");
  check_least_or_fast_type<sl::uint_least16_t, 16, false>(tester, "uint_least16_t");
  check_least_or_fast_type<sl::int_fast16_t, 16, true>(tester, "int_fast16_t");
  check_least_or_fast_type<sl::uint_fast16_t, 16, false>(tester, "uint_fast16_t");
  check_least_or_fast_type<sl::int_least32_t, 32, true>(tester, "int_least32_t");
  check_least_or_fast_type<sl::uint_least32_t, 32, false>(tester, "uint_least32_t");
  check_least_or_fast_type<sl::int_fast32_t, 32, true>(tester, "int_fast32_t");
  check_least_or_fast_type<sl::uint_fast32_t, 32, false>(tester, "uint_fast32_t");

#if defined(SL_INT64_C) && defined(SL_UINT64_C)
  check_least_or_fast_type<sl::int_least64_t, 64, true>(tester, "int_least64_t");
  check_least_or_fast_type<sl::uint_least64_t, 64, false>(tester, "uint_least64_t");
  check_least_or_fast_type<sl::int_fast64_t, 64, true>(tester, "int_fast64_t");
  check_least_or_fast_type<sl::uint_fast64_t, 64, false>(tester, "uint_fast64_t");
#endif

  check_least_or_fast_type<sl::intmax_t, 64, true>(tester, "intmax_t");
  check_least_or_fast_type<sl::uintmax_t, 64, false>(tester, "uintmax_t");
  tester.test("intmax_t std size", sizeof(sl::intmax_t), sizeof(std::intmax_t));
  tester.test("uintmax_t std size", sizeof(sl::uintmax_t), sizeof(std::uintmax_t));

  check_literal_macros(tester);

  failed_test_count += tester.failed_test_count();
  return int(failed_test_count);
}
