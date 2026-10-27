#ifndef TERRA_FRAME_HEIGHT_STORAGE_HPP
#define TERRA_FRAME_HEIGHT_STORAGE_HPP

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/payload_budget.hpp>

#include <cstddef>
#include <memory>

namespace terra {
namespace frame {

// Numeric height payload only. Encoded input, record cache, topology/metadata
// and render meshes have separate owners. A cache entry and an immutable
// prepared frame share one allocation; removing either is not a refund.
class height_storage {
  using credit = core::payload_budget::credit;
 public:
  class block {
   public:
    block() = default;
    block(const block&) = delete;
    block& operator=(const block&) = delete;
    const codec::height_diamond& value() const { return value_; }
    bool has_fragment(std::size_t fragment) const { return value_.has_fragment(fragment); }
   private:
    friend class height_storage;
    credit allocation_;
    codec::height_diamond value_;
  };
  using handle = std::shared_ptr<block>;

  class refinement {
   public:
    refinement() = default;
    refinement(const refinement&) = delete;
    refinement& operator=(const refinement&) = delete;
    const codec::height_refinement& value() const { return value_; }
   private:
    friend class height_storage;
    // Destruction frees arrays before refunding their production credit.
    credit allocation_;
    codec::height_refinement value_;
    std::size_t copy_remaining_ = 0U;
  };

  explicit height_storage(std::size_t maximum_bytes);
  handle empty() const;
  codec::hierarchy_status root(const codec::height_patch& record, handle& output);
  // copy_bytes covers unchanged fragments copied from shared destination
  // blocks. The whole refinement peak is admitted before the codec runs.
  codec::hierarchy_status refine(const codec::height_diamond& parent,
      const codec::height_patch& detail, std::size_t copy_bytes, refinement& output);
  bool replace(handle& destination, std::size_t fragment,
               refinement& source, std::size_t child);
  static std::size_t copy_bytes(const handle& destination, std::size_t replaced_fragment);
  static std::size_t fragment_bytes(std::size_t dimension);
  static std::size_t workspace_bytes(std::size_t dimension);
  static std::size_t refinement_bytes(const codec::height_diamond& parent, std::size_t copies);
  std::size_t resident_bytes() const;
  std::size_t work_bytes() const;
  std::size_t peak_bytes() const;
  std::size_t maximum_bytes() const;
 private:
  core::payload_budget budget_;
};

}  // namespace frame
}  // namespace terra
#endif
