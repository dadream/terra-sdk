#include <sl/config.hpp>
#if SL_HAVE_THREADS

#include <sl/thread.hpp>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>

namespace sl {

  //--------------------------------------------------------------------
  // Mutex Implementation Details
  //--------------------------------------------------------------------

  struct mutex::Impl {
    virtual ~Impl() = default;
    virtual void lock() = 0;
    virtual bool try_lock() = 0;
    virtual void unlock() = 0;
  };

  struct NormalMutexImpl : mutex::Impl {
    std::mutex m;
    void lock() override { m.lock(); }
    bool try_lock() override { return m.try_lock(); }
    void unlock() override { m.unlock(); }
  };

  struct RecursiveMutexImpl : mutex::Impl {
    std::recursive_mutex m;
    void lock() override { m.lock(); }
    bool try_lock() override { return m.try_lock(); }
    void unlock() override { m.unlock(); }
  };

  mutex::mutex(RecursionMode mode) {
    if (mode == Recursive) {
      impl_ = std::make_unique<RecursiveMutexImpl>();
    } else {
      impl_ = std::make_unique<NormalMutexImpl>();
    }
  }

  mutex::~mutex() = default;

  void mutex::lock() {
    impl_->lock();
  }

  bool mutex::try_lock() {
    return impl_->try_lock();
  }

  void mutex::unlock() {
    impl_->unlock();
  }

  //--------------------------------------------------------------------
  // Wait Condition Implementation Details
  //--------------------------------------------------------------------

  struct wait_condition::Impl {
    std::condition_variable_any cv;
  };

  wait_condition::wait_condition() {
    impl_ = std::make_unique<Impl>();
  }

  wait_condition::~wait_condition() = default;

  struct MutexLockWrapper {
    mutex::Impl* impl;
    void lock() { impl->lock(); }
    void unlock() { impl->unlock(); }
  };

  void wait_condition::wait(mutex &m) {
    MutexLockWrapper wrapper{ m.get_impl() };
    impl_->cv.wait(wrapper);
  }
		
  void wait_condition::notify_one() {
    impl_->cv.notify_one();
  }

  void wait_condition::notify_all() {
    impl_->cv.notify_all();
  }

  //--------------------------------------------------------------------
  // Thread Implementation Details
  //--------------------------------------------------------------------

  thread::thread()
      : stack_size_(0),
        priority_(InheritPriority),
        is_running_(false),
        is_finished_(false) {
  }
  
  thread::~thread() {
    if (is_running()) {
      std::terminate();
    }
    if (thread_ && thread_->joinable()) {
      thread_->join();
    }
  }

  bool thread::is_finished() const {
    std::lock_guard<mutex> lock(mutex_);
    return is_finished_;
  }
  
  bool thread::is_running() const {
    std::lock_guard<mutex> lock(mutex_);
    return is_running_;
  }
  
  thread::Priority thread::priority() const {
    std::lock_guard<mutex> lock(mutex_);
    return priority_;
  }
  
  void thread::set_priority(Priority p) {
    std::lock_guard<mutex> lock(mutex_);
    priority_ = p;
  }
  
  std::size_t thread::stack_size() const {
    std::lock_guard<mutex> lock(mutex_);
    return stack_size_;
  }
  
  void thread::set_stack_size(std::size_t s) {
    std::lock_guard<mutex> lock(mutex_);
    stack_size_ = s;
  }

  bool thread::wait() {
    if (thread_ && thread_->joinable()) {
      thread_->join();
    }
    return true;
  }

  void thread::start() {
    bool expected_not_running = false;
    {
      std::lock_guard<mutex> lock(mutex_);
      if (!is_running_) {
        is_running_ = true;
        is_finished_ = false;
        expected_not_running = true;
      }
    }
    if (expected_not_running) {
      thread_ = std::make_unique<std::thread>([this]() {
        try {
          this->run();
        } catch(...) {
          std::terminate();
        }
        std::lock_guard<mutex> lock(mutex_);
        is_running_ = false;
        is_finished_ = true;
      });
    }
  }

  void thread::usleep(unsigned long usecs) {
    std::this_thread::sleep_for(std::chrono::microseconds(usecs));
  }

  void thread::yield_current_thread() {
    std::this_thread::yield();
  }

  std::size_t thread::hardware_concurrency() {
    return std::thread::hardware_concurrency();
  }
} // namespace sl

#endif // SL_HAVE_THREADS
