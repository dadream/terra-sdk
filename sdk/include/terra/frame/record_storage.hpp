#ifndef TERRA_FRAME_RECORD_STORAGE_HPP
#define TERRA_FRAME_RECORD_STORAGE_HPP

#include <terra/codec/cbdam_height.hpp>
#include <terra/core/payload_budget.hpp>

namespace terra {
namespace frame {

class record_storage {
 public:
  class block {
   public:
    const codec::height_patch& value() const { return value_; }
   private:
    friend class record_storage;
    core::payload_budget::credit allocation_;
    codec::height_patch value_;
  };
  using handle = std::shared_ptr<const block>;

  explicit record_storage(std::size_t maximum_bytes) : budget_(maximum_bytes) {}
  // Replacing output holds its old allocation until the new decode succeeds.
  codec::decode_status decode(const std::uint8_t* data, std::size_t size,
                             std::uint32_t dimension, handle& output);
  codec::decode_status zero(std::uint32_t dimension, handle& output);
  std::size_t resident_bytes() const { return budget_.resident_bytes(); }
  std::size_t work_bytes() const { return budget_.work_bytes(); }
  std::size_t peak_bytes() const { return budget_.peak_bytes(); }
  std::size_t maximum_bytes() const { return budget_.maximum_bytes(); }
 private:
  core::payload_budget budget_;
};

}  // namespace frame
}  // namespace terra
#endif
