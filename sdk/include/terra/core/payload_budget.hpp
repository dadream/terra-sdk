#ifndef TERRA_CORE_PAYLOAD_BUDGET_HPP
#define TERRA_CORE_PAYLOAD_BUDGET_HPP

#include <cstddef>
#include <memory>

namespace terra {
namespace core {

// Single-threaded numeric payload accounting. Owners destroy their arrays
// before their credit. Shared readers retain the owner, not another charge.
class payload_budget {
  struct state;
 public:
  class credit {
   public:
    credit() = default;
    credit(const credit&) = delete;
    credit& operator=(const credit&) = delete;
    credit(credit&& other) noexcept;
    credit& operator=(credit&& other) noexcept;
    ~credit();
    std::size_t bytes() const { return bytes_; }
    bool attached() const { return bool(owner_); }
    bool is_work_credit() const { return bool(owner_) && !resident_; }
    bool belongs_to(const payload_budget& budget) const;
    void clear();
    void shrink(std::size_t bytes);
   private:
    friend class payload_budget;
    std::shared_ptr<state> owner_;
    std::size_t bytes_ = 0U;
    bool resident_ = false;
  };

  explicit payload_budget(std::size_t maximum_bytes);
  credit resident_credit() const;
  bool reserve(std::size_t bytes, credit& output);
  // Transfer part of one authorized work grant without refunding/re-reserving.
  // Refusal leaves both credits unchanged. No allocation or counter change.
  bool split_work(credit& source, std::size_t bytes, credit& output);
  void adopt(credit& source, credit& destination, std::size_t bytes);
  std::size_t resident_bytes() const;
  std::size_t work_bytes() const;
  std::size_t peak_bytes() const;
  std::size_t maximum_bytes() const;
 private:
  std::shared_ptr<state> state_;
};

}  // namespace core
}  // namespace terra
#endif
