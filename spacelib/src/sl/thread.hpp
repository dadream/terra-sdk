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

#ifndef SL_THREAD_HPP 
#define SL_THREAD_HPP                                                        

#include <sl/config.hpp>
#include <ostream>
#include <memory>
#include <thread>

#if !SL_HAVE_THREADS
# error "No thread support on this platform"
#endif

namespace sl {

  /**
   * Mutual exclusion objects for access to shared
   * memory areas for several threads.
   */
  class mutex {
    SL_DISABLE_COPY(mutex);
  public:
    enum RecursionMode  {
      Recursive, NonRecursive
    };

    struct Impl;

  private: 
    std::unique_ptr<Impl> impl_;

    friend class wait_condition;
  public:
    /// Constructor.
    mutex(RecursionMode mode = NonRecursive);

    /// Destructor.
    ~mutex();

    /// Lock the mutex.
    void lock();

    /// Try to lock the mutex.
    bool try_lock();

    /// Unlock the mutex.
    void unlock();

    /// Internal accessor for wait condition implementation
    Impl* get_impl() const { return impl_.get(); }
  };

  /**
   * Lock guards
   */
  class mutex_locker {
    SL_DISABLE_COPY(mutex_locker);
  protected:
    mutex* mutex_;
    bool   lock_performed_;
  public:
    inline explicit mutex_locker(mutex* m) : mutex_(m), lock_performed_(false) {
      relock();
    }
    inline ~mutex_locker() {
      unlock();
    }
    inline void unlock() {
      if (mutex_ && lock_performed_) {
	mutex_->unlock();
	lock_performed_ = false;
      }
    }
    inline void relock() {
      if (mutex_ && !lock_performed_) {
	mutex_->lock();
	lock_performed_ = true;
      }
    }
    inline mutex* the_mutex() const {
      return mutex_;
    }
  };

  /**
   * Signalling objects for synchronizing the execution flow for
   * several threads.
   */
  class wait_condition {
    SL_DISABLE_COPY(wait_condition);
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
  public:
    wait_condition();

    ~wait_condition();

    /// Wait for the condition.
    void wait(mutex &m);

    /// Notify one thread that is waiting for the condition.
    void notify_one();

    /// Notify all threads that are waiting for the condition.
    void notify_all();
  };

  /**
   * Threads of execution.
   */
  class thread {
    SL_DISABLE_COPY(thread);
  public:
    enum Priority  {
      IdlePriority=0,
      LowestPriority=1,
      LowPriority=2,
      NormalPriority=3,
      HighPriority=4,
      HighestPriority=5,
      TimeCriticalPriority=6,
      InheritPriority=7 };
  protected:
    std::unique_ptr<std::thread> thread_;

    std::size_t stack_size_;
    sl::thread::Priority priority_;
    mutable mutex mutex_;   ///< Serializer for access to the thread private data.
    bool is_running_;           ///< True if this object is a thread of execution.
    bool is_finished_;           ///< True if this object is a thread of execution.

  public:
    thread();
    virtual ~thread();

    Priority priority() const;
    void set_priority(Priority p);
    std::size_t stack_size() const;
    void set_stack_size(std::size_t s);

  public:
    bool is_running() const;
    bool is_finished() const;
    bool wait();
    void start();
  protected:
    virtual void run() = 0;
  public:
    static void usleep(unsigned long usecs);

    static void yield_current_thread();
    
    /// Determine the number of threads which can possibly execute concurrently.
    static std::size_t hardware_concurrency();
  };

} // namespace sl

#endif
