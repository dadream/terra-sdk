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
#ifndef SL_CONFIG_HPP 
#define SL_CONFIG_HPP                                                        
#include <sl/config/config.h>

#include <vector> // HACK - to import std::ptrdiff_t, std::size_t ... 

/*
**----------------------------------------------------------
** BEGIN C++ configuration
**----------------------------------------------------------
*/

# if HAVE_LONG_LONG
#   define HAVE_INTMAX_BITS HAVE_LONG_LONG_BITS
# else
# if HAVE_MSVC_INT64
#   define HAVE_INTMAX_BITS  64
# else
#   define HAVE_INTMAX_BITS  HAVE_LONG_BITS
# endif
# endif

# if HAVE_RESTRICT
#   define HAVE_RESTRICT_ENABLED 1
# elif HAVE_PRIVATE_RESTRICT
#   define restrict __restrict
#   define HAVE_RESTRICT_ENABLED 1
# elif HAVE_PRIVATE_SGI_RESTRICT
#   define restrict __restrict__
#   define HAVE_RESTRICT_ENABLED 1
# else
#   define restrict /*no restrict*/
#   undef HAVE_RESTRICT_ENABLED
# endif

# undef CXX_CURRENT_FUNCTION
# if HAVE_PRETTY_FUNCTION
#  define CXX_CURRENT_FUNCTION          __PRETTY_FUNCTION__
# elif HAVE_FUNCTION
#  define CXX_CURRENT_FUNCTION          __FUNCTION__
# elif HAVE_FUNC
#  define CXX_CURRENT_FUNCTION          __func__
# else
#  define CXX_CURRENT_FUNCTION          ((char*)0)
# endif

# ifdef _MSC_VER
#  pragma warning(disable:4786)         // '255' characters in the debug information
#  pragma warning(disable:4305)         // conversion from double to float (5.0)
# endif //_MSC_VER

// --- Threads

# if HAVE_POSIX_THREADS || HAVE_WIN32_THREADS
#    define SL_HAVE_THREADS 1
# else
#    undef SL_HAVE_THREADS
# endif

// --- Template metaprograms

//#define SL_NO_TEMPLATE_METAPROGRAMS 1
// Set to 1 to remove use of metaprograms

// --- Containers

// C++14 provides standard unordered containers. Keep the historical stlext
// selector disabled by default to avoid changing container iteration behavior.
# undef HAVE_STLEXT_UNORDERED_CONTAINERS
/*
**----------------------------------------------------------
** END C++ configuration
**----------------------------------------------------------
*/

/**
 *   The main namespace, containing all user-visible features.
 */
namespace sl {

  // Import the ubiquitous ptrdiff_t, size_t in sl namespace
  using std::ptrdiff_t;
  using std::size_t;

  /**
   *  The namespace that contains purely internal features.
   */
  namespace detail {
  }

  /**
   *  The namespace that contains all common tags.
   */
  namespace tags {
  }
}
  
/** 
 * \def SL_DEFERRED
 * macro replacing "= 0" for declaring deferred features in
 * classes. This makes it possible to grep SL_DEFERRED to get
 * a list of the features that have to be defined in subclasses.
 */
#define SL_DEFERRED =0

/** 
 * \def SL_USEVAR
 * macro for "using" a variable and avoiding argument not used 
 * warnings
 */
#define SL_USEVAR(VAR) ((void)(VAR))

/**
 * \def SL_DISABLE_COPY
 *  Some classes do not permit copies to be made of an object. These
 *  classes contains a private copy constructor and assignment
 *  operator to disable copying (the compiler gives an error message).
 */
#define SL_DISABLE_COPY(Class) \
    Class(const Class &); \
    Class &operator=(const Class &);

#endif

