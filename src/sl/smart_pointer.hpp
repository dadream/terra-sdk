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
#ifndef SL_SMART_POINTER_HPP
#define SL_SMART_POINTER_HPP

#include <sl/utility.hpp>      // for generic superclass interface
#include <memory>              // for std::unique_ptr, std::shared_ptr
#include <type_traits>         // for std::is_base_of, std::is_convertible, std::enable_if
#include <algorithm>           // for std::swap
#include <functional>          // for std::less

namespace sl {

  /**
   * sized_raw_array_pointer mimics a built-in pointer except that it also
   * contains a size, used to validate access to elements.
   */
  template <class T> 
  class sized_raw_array_pointer {
  protected:
    T*     pointer_;
    size_t count_;
  public:
    typedef T value_t;

    explicit inline sized_raw_array_pointer( T* p=0,  size_t sz=0) 
      : 
      pointer_(p), count_(sz) 
    {
      SL_REQUIRE("Null implies zero size", (p!=0) || (sz==0));
    }  // never throws

    /// The number of elements in the array
    inline size_t count() const {
      return count_;
    }
      
    /// The first element of the array
    inline T& operator*() const { 
      SL_REQUIRE("Not empty", pointer_);
      return *pointer_; 
    }

    /// Pointer to the first element of the array
    inline T* operator->() const { 
      return pointer_; 
    }

    /// Pointer to the first element of the array
    inline T* raw_pointer() const        { 
      return pointer_; 
    } 

    /// The i-th element of the array
    inline T& operator[](std::size_t i) const { 
      SL_REQUIRE("Good index", i<count());
      return pointer_[i]; 
    }

    /// Is the pointer null?
    inline operator bool() const { 
      return pointer_; 
    }
    
  };  // sized_raw_array_pointer

  /**
   *  A const pointer from a non-const one
   */
  template <class T>
  static inline sl::sized_raw_array_pointer<const T> to_constant_pointer(const sl::sized_raw_array_pointer<T>& ptr) {
    return sl::sized_raw_array_pointer<const T>(ptr.raw_pointer(), ptr.count());
  }
  
} // namespace sl

namespace sl {

  /**
   * scoped_pointer mimics a built-in pointer except that it guarantees deletion
   * of the object pointed to, either on destruction of the scoped_pointer or via
   * an explicit reset(). 
   */
  template <class T> 
  class scoped_pointer {
  private:
    std::unique_ptr<T> pointer_;
  public:
    typedef T value_t;

    explicit inline scoped_pointer( T* p=0 ) : pointer_(p) {}  // never throws
    inline ~scoped_pointer() = default;

    // Non-copyable
    scoped_pointer(const scoped_pointer&) = delete;
    scoped_pointer& operator=(const scoped_pointer&) = delete;

    // Move support
    inline scoped_pointer(scoped_pointer&& other) noexcept : pointer_(std::move(other.pointer_)) {}
    inline scoped_pointer& operator=(scoped_pointer&& other) noexcept {
      pointer_ = std::move(other.pointer_);
      return *this;
    }

    inline void reset( T* p=0 )          { pointer_.reset(p); }
    inline T& operator*() const          { return *pointer_; }  // never throws
    inline T* operator->() const         { return pointer_.get(); }   // never throws
    inline T* raw_pointer() const        { return pointer_.get(); }   // never throws

    inline operator bool() const { return static_cast<bool>(pointer_); }
  };  // scoped_pointer

} // namespace sl

namespace sl {

  /**
   * scoped_raw_array_pointer extends scoped_pointer to arrays. Deletion of the array pointed to
   * is guaranteed, either on destruction of the scoped_raw_array_pointer or via an explicit
   * reset(). 
   */
  template<class T> 
  class scoped_raw_array_pointer {
  private:
    std::unique_ptr<T[]> pointer_;

  public:
    typedef T value_t;
    
    explicit scoped_raw_array_pointer( T* p=0 ) : pointer_(p) {}  // never throws
    ~scoped_raw_array_pointer() = default;

    // Non-copyable
    scoped_raw_array_pointer(const scoped_raw_array_pointer&) = delete;
    scoped_raw_array_pointer& operator=(const scoped_raw_array_pointer&) = delete;
    
    inline void reset( T* p=0 )               { pointer_.reset(p); }
    
    T* raw_pointer() const                     { return pointer_.get(); }  // never throws
    T& operator[](std::size_t i) const { return pointer_[i]; }  // never throws

    inline operator bool() const { return static_cast<bool>(pointer_); }
  };  // scoped_raw_array_pointer

} // namespace sl

namespace sl {
  
  /**
   *  Base class for implementing reference counted objects
   */
  class reference_counted {
  protected:
    long  reference_count_;
  public:

    /// Initialize a reference counted object
    inline reference_counted() :
      reference_count_(0) {
    }

    /// The number of pointers referencing this object
    inline long use_count() const        { 
      return reference_count_; 
    }

    /// Reference this object
    inline void ref() {
      ++reference_count_;
    }

    /// Dereference this object
    inline void deref() {
      SL_REQUIRE("Was referenced", use_count() > 0);
      --reference_count_;
    }

    inline long* refcount_pointer() const {
      return (long*)(&reference_count_);
    }

  };

  template <class T>
  struct is_reference_counted {
    static const bool value = std::is_base_of<reference_counted, T>::value;
  };

} // namespace sl

namespace sl {
 
  template <class T, bool IsIntrusive>
  class shared_pointer_impl;

  // Non-intrusive version (std::shared_ptr under the hood)
  template <class T>
  class shared_pointer_impl<T, false> {
  protected:
    std::shared_ptr<T> impl_;
  public:
    typedef T value_t;

    inline shared_pointer_impl(T* p = 0) : impl_(p ? std::shared_ptr<T>(p) : std::shared_ptr<T>()) {}
    inline ~shared_pointer_impl() = default;

    inline shared_pointer_impl(const shared_pointer_impl& other) = default;
    inline shared_pointer_impl& operator=(const shared_pointer_impl& other) = default;

    template <class Y, typename std::enable_if<std::is_convertible<Y*, T*>::value, int>::type = 0>
    inline shared_pointer_impl(const shared_pointer_impl<Y, false>& other) : impl_(other.get_shared_ptr()) {}

    template <class Y, typename std::enable_if<std::is_convertible<Y*, T*>::value, int>::type = 0>
    inline shared_pointer_impl& operator=(const shared_pointer_impl<Y, false>& other) {
      impl_ = other.get_shared_ptr();
      return *this;
    }

    inline void reset(T* p = 0) {
      if (p == nullptr) {
        impl_.reset();
      } else {
        impl_.reset(p);
      }
    }
    inline T* raw_pointer() const { return impl_.get(); }
    inline long use_count() const { return impl_.use_count(); }
    inline bool is_unique() const { return impl_.use_count() == 1; }
    inline long* refcount_pointer() const { return nullptr; }

    inline void swap(shared_pointer_impl& other) noexcept { impl_.swap(other.impl_); }
    inline const std::shared_ptr<T>& get_shared_ptr() const { return impl_; }
    inline operator bool() const { return static_cast<bool>(impl_); }
  };

  // Intrusive version (manually managing references on reference_counted objects)
  template <class T>
  class shared_pointer_impl<T, true> {
  protected:
    T* pointer_;
  public:
    typedef T value_t;

    inline shared_pointer_impl(T* p = 0) : pointer_(p) {
      if (pointer_) pointer_->ref();
    }
    inline ~shared_pointer_impl() {
      if (pointer_) {
        pointer_->deref();
        if (pointer_->use_count() == 0) {
          delete pointer_;
        }
      }
    }
    inline shared_pointer_impl(const shared_pointer_impl& other) : pointer_(other.pointer_) {
      if (pointer_) pointer_->ref();
    }
    inline shared_pointer_impl& operator=(const shared_pointer_impl& other) {
      if (pointer_ != other.pointer_) {
        if (pointer_) {
          pointer_->deref();
          if (pointer_->use_count() == 0) {
            delete pointer_;
          }
        }
        pointer_ = other.pointer_;
        if (pointer_) pointer_->ref();
      }
      return *this;
    }

    template <class Y, typename std::enable_if<std::is_convertible<Y*, T*>::value, int>::type = 0>
    inline shared_pointer_impl(const shared_pointer_impl<Y, true>& other) : pointer_(other.raw_pointer()) {
      if (pointer_) pointer_->ref();
    }

    template <class Y, typename std::enable_if<std::is_convertible<Y*, T*>::value, int>::type = 0>
    inline shared_pointer_impl& operator=(const shared_pointer_impl<Y, true>& other) {
      if (pointer_ != other.raw_pointer()) {
        if (pointer_) {
          pointer_->deref();
          if (pointer_->use_count() == 0) {
            delete pointer_;
          }
        }
        pointer_ = other.raw_pointer();
        if (pointer_) pointer_->ref();
      }
      return *this;
    }

    inline void reset(T* p = 0) {
      if (pointer_ != p) {
        if (pointer_) {
          pointer_->deref();
          if (pointer_->use_count() == 0) {
            delete pointer_;
          }
        }
        pointer_ = p;
        if (pointer_) pointer_->ref();
      }
    }

    inline T* raw_pointer() const { return pointer_; }
    inline long use_count() const { return pointer_ ? pointer_->use_count() : 0; }
    inline bool is_unique() const { return use_count() == 1; }
    inline long* refcount_pointer() const { return pointer_ ? pointer_->refcount_pointer() : nullptr; }

    inline void swap(shared_pointer_impl& other) noexcept { std::swap(pointer_, other.pointer_); }
    inline operator bool() const { return pointer_ != nullptr; }
  };

  /**
   * An enhanced relative of scoped_pointer with reference counted copy semantics.
   * The object pointed to is deleted when the last shared_pointer pointing to it
   * is destroyed or reset.
   */
  template<class T> 
  class shared_pointer: public shared_pointer_impl<T, is_reference_counted<T>::value> {
  public:
    typedef shared_pointer_impl<T, is_reference_counted<T>::value> super_t;
    typedef T value_t;

    explicit inline shared_pointer(T* p =0) : super_t(p) {}
    
    inline shared_pointer(const shared_pointer& r): super_t(r) {}
  
    inline shared_pointer& operator=(const shared_pointer& r) {
      super_t::operator=(r);
      return *this;
    }
    
    template<class Y>
    inline shared_pointer(const shared_pointer<Y>& r) : super_t(r) {}

    template<class Y>
    inline shared_pointer& operator=(const shared_pointer<Y>& r) { 
      super_t::operator=(r);
      return *this;
    }

    inline T& operator*() const          { return *(this->raw_pointer()); }  // never throws
    inline T* operator->() const         { return this->raw_pointer(); }  // never throws
  };  // shared_pointer


  /**
   *  A const pointer from a non-const one
   */
  template <class T>
  static inline sl::shared_pointer<const T> to_constant_pointer(const sl::shared_pointer<T>& ptr) {
    return sl::shared_pointer<const T>(ptr);
  }

} // namespace sl
  
template<class T, typename U>
inline bool operator==(const sl::shared_pointer<T>& a, const sl::shared_pointer<U>& b) { 
  return a.raw_pointer() == b.raw_pointer(); 
}

template<class T, typename U>
inline bool operator!=(const sl::shared_pointer<T>& a, const sl::shared_pointer<U>& b) { 
  return a.raw_pointer() != b.raw_pointer(); 
}

namespace sl {

  /**
   * shared_raw_array_pointer extends shared_pointer to arrays.
   * The array pointed to is deleted when the last shared_raw_array_pointer pointing to it
   * is destroyed or reset.
   */
  template<class T> 
  class shared_raw_array_pointer {
  private:
    std::shared_ptr<T> impl_;
  public:
    typedef T value_t;

    explicit inline shared_raw_array_pointer(T* p =0) 
      : impl_(p ? std::shared_ptr<T>(p, std::default_delete<T[]>()) : std::shared_ptr<T>()) {}
    
    inline shared_raw_array_pointer(const shared_raw_array_pointer& r) : impl_(r.impl_) {}
  
    inline shared_raw_array_pointer& operator=(const shared_raw_array_pointer& r) {
      impl_ = r.impl_;
      return *this;
    }

    inline void reset(T* p = 0) {
      if (p == nullptr) {
        impl_.reset();
      } else {
        impl_.reset(p, std::default_delete<T[]>());
      }
    }
    inline T* raw_pointer() const { return impl_.get(); }
    inline long use_count() const { return impl_.use_count(); }
    inline bool is_unique() const { return impl_.use_count() == 1; }
    inline void swap(shared_raw_array_pointer& other) noexcept { impl_.swap(other.impl_); }

    inline T& operator[](std::size_t i) const { return (impl_.get())[i]; }  // never throws
    inline operator bool() const { return static_cast<bool>(impl_); }
  };  // shared_raw_array_pointer

  /**
   *  A const pointer from a non-const one
   */
  template <class T>
  static inline sl::shared_raw_array_pointer<const T> to_constant_pointer(const sl::shared_raw_array_pointer<T>& ptr) {
    return sl::shared_raw_array_pointer<const T>(ptr);
  }

} // namespace sl
  
template<class T, typename U>
inline bool operator==(const sl::shared_raw_array_pointer<T>& a, const sl::shared_raw_array_pointer<U>& b) { 
  return a.raw_pointer() == b.raw_pointer(); 
}

template<class T, typename U>
inline bool operator!=(const sl::shared_raw_array_pointer<T>& a, const sl::shared_raw_array_pointer<U>& b) { 
  return a.raw_pointer() != b.raw_pointer(); 
}

//  specializations for things in namespace std  -----------------------------//

namespace std {

  template<class T>
  inline void swap(sl::shared_pointer<T>& a, sl::shared_pointer<T>& b)
    { a.swap(b); }

  template<class T>
  inline void swap(sl::shared_raw_array_pointer<T>& a, sl::shared_raw_array_pointer<T>& b)
    { a.swap(b); }

  template<class T>
  struct less< sl::shared_pointer<T> >
  {
    bool operator()(const sl::shared_pointer<T>& a,
        const sl::shared_pointer<T>& b) const
      { return less<T*>()(a.raw_pointer(),b.raw_pointer()); }
  };

  template<class T>
  struct less< sl::shared_raw_array_pointer<T> >
  {
    bool operator()(const sl::shared_raw_array_pointer<T>& a,
        const sl::shared_raw_array_pointer<T>& b) const
      { return less<T*>()(a.raw_pointer(),b.raw_pointer()); }
  };

} // namespace std

#endif  // SL_SMART_POINTER_HPP
