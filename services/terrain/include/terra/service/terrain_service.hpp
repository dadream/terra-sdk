#ifndef TERRA_SERVICE_TERRAIN_SERVICE_HPP
#define TERRA_SERVICE_TERRAIN_SERVICE_HPP

#include <terra/core/types.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace terra {
namespace service {

using http_headers = std::vector<std::pair<std::string, std::string>>;

struct http_request {
  std::string method;
  std::string target;
  http_headers headers;
};

struct http_response {
  int status = 500;
  std::string content_type = "application/problem+json";
  http_headers headers;
  std::vector<std::uint8_t> body;

  std::string header(const std::string& name) const;
};

struct texture_descriptor {
  std::string id;
  std::string kind;
  std::string url_template;
  std::string local_file_path;
  int matrix_level_offset = 0;
  int maximum_level = 0;
};

struct terrain_dataset_config {
  std::string dataset_id;
  std::string terrain_base_path;
  int minimum_level = 0;
  int maximum_level = 30;
  std::vector<texture_descriptor> textures;
};

enum class payload_validation_status {
  ok = 0,
  invalid_length,
  invalid_checksum,
  length_mismatch,
  checksum_mismatch
};

payload_validation_status validate_payload(
    const std::vector<std::uint8_t>& payload,
    const std::string& expected_length,
    const std::string& expected_checksum);

const char* payload_validation_status_message(
    payload_validation_status status);

class terrain_service {
 public:
  terrain_service();
  ~terrain_service();

  terrain_service(terrain_service&& other) noexcept;
  terrain_service& operator=(terrain_service&& other) noexcept;

  terrain_service(const terrain_service&) = delete;
  terrain_service& operator=(const terrain_service&) = delete;

  bool open(const terrain_dataset_config& config, std::string& error);
  bool is_open() const;
  const core::dataset_metadata& metadata() const;
  http_response handle(const http_request& request) const;

 private:
  class implementation;
  std::unique_ptr<implementation> implementation_;
};

}  // namespace service
}  // namespace terra

#endif  // TERRA_SERVICE_TERRAIN_SERVICE_HPP