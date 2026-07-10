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
#ifndef SL_FLOAT_CAST_HPP
#define SL_FLOAT_CAST_HPP

#include <sl/config.hpp>

#include <cmath>

namespace sl {

  /// Round x to the  nearest integer value, using  the current rounding direction.
  static inline long int fast_round_to_integer(double x) {
    return std::lrint(x);
  }
  /// Round x to the  nearest integer value, using  the current rounding direction.
  static inline long int fast_round_to_integer(float x) {
    return std::lrintf(x);
  }

} // namespace sl


#endif
