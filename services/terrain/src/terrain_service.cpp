#include <terra/service/terrain_service.hpp>

#include <terra/core/grid.hpp>
#include <terra/core/metadata.hpp>

#include <vic/vfs/repository.hpp>
#include <vic/xml/document.hpp>

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>

namespace terra {
namespace service {
namespace {

const char* manifest_media_type =
    "application/vnd.terra.dataset+json;version=1";
const char* patch_media_type = "application/octet-stream";
const char* problem_media_type = "application/problem+json";
const char* checksum_prefix = "fnv1a64:";

std::string lower_ascii(const std::string& value) {
  std::string result(value);
  std::transform(result.begin(), result.end(), result.begin(),
                 [](unsigned char character) {
                   return static_cast<char>(std::tolower(character));
                 });
  return result;
}

std::string header_value(const http_headers& headers,
                         const std::string& name) {
  const std::string expected = lower_ascii(name);
  for (const auto& header : headers) {
    if (lower_ascii(header.first) == expected) {
      return header.second;
    }
  }
  return std::string();
}

void set_header(http_response& response, const std::string& name,
                const std::string& value) {
  response.headers.emplace_back(name, value);
}

std::vector<std::uint8_t> bytes(const std::string& value) {
  return std::vector<std::uint8_t>(value.begin(), value.end());
}

std::string json_escape(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (unsigned char character : value) {
    switch (character) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (character < 0x20U) {
          output << "\\u00" << std::hex << std::setw(2)
                 << std::setfill('0') << static_cast<unsigned int>(character)
                 << std::dec << std::setfill(' ');
        } else {
          output << static_cast<char>(character);
        }
        break;
    }
  }
  output << '"';
  return output.str();
}

std::uint64_t fnv1a64(const std::vector<std::uint8_t>& payload) {
  std::uint64_t hash = UINT64_C(14695981039346656037);
  for (std::uint8_t value : payload) {
    hash ^= value;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

std::string hex64(std::uint64_t value) {
  std::ostringstream output;
  output << std::hex << std::nouppercase << std::setw(16)
         << std::setfill('0') << value;
  return output.str();
}

std::string checksum(const std::vector<std::uint8_t>& payload) {
  return std::string(checksum_prefix) + hex64(fnv1a64(payload));
}

std::string etag(const std::vector<std::uint8_t>& payload) {
  std::ostringstream output;
  output << '"' << "fnv1a64-" << hex64(fnv1a64(payload)) << '-'
         << payload.size() << '"';
  return output.str();
}

bool parse_size(const std::string& value, std::size_t& result) {
  if (value.empty() ||
      !std::all_of(value.begin(), value.end(), [](unsigned char character) {
        return std::isdigit(character);
      })) {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(value.c_str(), &end, 10);
  if (errno != 0 || !end || *end != '\0' ||
      parsed > std::numeric_limits<std::size_t>::max()) {
    return false;
  }
  result = static_cast<std::size_t>(parsed);
  return true;
}

bool parse_grid_value(const std::string& value, core::grid_value& result) {
  if (value.empty() || value[0] == '+') {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long long parsed = std::strtoll(value.c_str(), &end, 10);
  if (errno != 0 || !end || *end != '\0' ||
      parsed < core::grid_coordinate_min ||
      parsed > core::grid_coordinate_max) {
    return false;
  }
  result = static_cast<core::grid_value>(parsed);
  return true;
}

bool safe_identifier(const std::string& value) {
  if (value.empty() || value.size() > 64U) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    const bool ascii_alphanumeric =
        (character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9');
    return ascii_alphanumeric || character == '-' || character == '_';
  });
}

std::vector<std::string> split_path(const std::string& target) {
  std::vector<std::string> result;
  if (target.empty() || target[0] != '/' ||
      target.find('?') != std::string::npos ||
      target.find('#') != std::string::npos) {
    return result;
  }
  std::size_t begin = 1U;
  while (begin <= target.size()) {
    const std::size_t end = target.find('/', begin);
    const std::size_t count =
        end == std::string::npos ? target.size() - begin : end - begin;
    if (count == 0U) {
      return std::vector<std::string>();
    }
    result.push_back(target.substr(begin, count));
    if (end == std::string::npos) {
      break;
    }
    begin = end + 1U;
  }
  return result;
}

http_response problem(int status, const std::string& code,
                      const std::string& message) {
  http_response response;
  response.status = status;
  response.content_type = problem_media_type;
  const std::string body =
      std::string("{\"error\":{") +
      "\"code\":" + json_escape(code) + ',' +
      "\"message\":" + json_escape(message) + "}}\n";
  response.body = bytes(body);
  set_header(response, "Cache-Control", "no-store");
  set_header(response, "Content-Length", std::to_string(response.body.size()));
  set_header(response, "X-Content-Type-Options", "nosniff");
  return response;
}

bool read_metadata(const std::string& path, core::dataset_metadata& metadata,
                   std::size_t& root_count, std::string& error) {
  std::ifstream input(path.c_str(), std::ios::in);
  if (!input) {
    error = "unable to open terrain metadata";
    return false;
  }

  vic::xml::document document;
  document.parse(input);
  if (document.error()) {
    error = "unable to parse terrain metadata";
    return false;
  }
  vic::xml::node_iterator root = document.first_root("cbdam");
  if (root.is_null()) {
    error = "terrain metadata has no cbdam root";
    return false;
  }

  bool found_info = false;
  bool found_transform = false;
  metadata = core::dataset_metadata();
  metadata.format_version = 1U;
  for (vic::xml::node_iterator child = root.down(); !child.is_null();
       child = child.next()) {
    if (!child.is_element_node()) {
      continue;
    }
    if (child.tag() == "info") {
      if (!child.has_attribute("patch_dim") ||
          !child.has_attribute("height_scale_factor") ||
          !child.has_attribute("srs")) {
        error = "terrain metadata info is incomplete";
        return false;
      }
      const long patch_dimension = child.attributei("patch_dim");
      if (child.error() || patch_dimension < 0L ||
          static_cast<unsigned long>(patch_dimension) >
              std::numeric_limits<std::uint32_t>::max()) {
        error = "terrain patch dimension is invalid";
        return false;
      }
      metadata.patch_dimension =
          static_cast<std::uint32_t>(patch_dimension);
      metadata.height_scale_factor =
          child.attributed("height_scale_factor");
      metadata.srs = child.attribute("srs");
      metadata.about = child.attribute("about", "");
      if (child.error()) {
        error = "terrain metadata info is invalid";
        return false;
      }
      found_info = true;
    } else if (child.tag() == "coordinate_transform") {
      if (!child.has_attribute("type")) {
        error = "terrain transform type is missing";
        return false;
      }
      const std::string kind = child.attribute("type");
      if (kind == "planar") {
        const char* names[] = {"u0", "v0", "u1", "v1"};
        for (const char* name : names) {
          if (!child.has_attribute(name)) {
            error = "planar terrain bounds are incomplete";
            return false;
          }
        }
        metadata.transform = core::coordinate_transform_kind::planar;
        metadata.bounds.minimum =
            {{child.attributed("u0"), child.attributed("v0")}};
        metadata.bounds.maximum =
            {{child.attributed("u1"), child.attributed("v1")}};
        metadata.radius = 0.0;
      } else if (kind == "cylindrical") {
        if (!child.has_attribute("radius")) {
          error = "cylindrical terrain radius is missing";
          return false;
        }
        metadata.transform = core::coordinate_transform_kind::cylindrical;
        metadata.bounds.minimum = {{-180.0, -90.0}};
        metadata.bounds.maximum = {{180.0, 90.0}};
        metadata.radius = child.attributed("radius");
      } else {
        error = "terrain transform is unsupported by service v1";
        return false;
      }
      if (child.error()) {
        error = "terrain transform attributes are invalid";
        return false;
      }
      found_transform = true;
    }
  }
  if (!found_info || !found_transform) {
    error = "terrain metadata is incomplete";
    return false;
  }

  const core::metadata_validation validation =
      core::validate_dataset_metadata(metadata);
  if (!validation.valid()) {
    error = core::metadata_status_message(validation.status);
    return false;
  }
  root_count = validation.root_count;
  return true;
}

std::string manifest_json(const terrain_dataset_config& config,
                          const core::dataset_metadata& metadata,
                          std::size_t root_count) {
  const bool planar =
      metadata.transform == core::coordinate_transform_kind::planar;
  const std::string base = "/terra/v1/datasets/" + config.dataset_id;
  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << std::setprecision(17);
  output << "{\n"
         << "  \"schema\": \"terra.dataset-manifest\",\n"
         << "  \"schema_version\": 1,\n"
         << "  \"dataset_id\": " << json_escape(config.dataset_id)
         << ",\n"
         << "  \"format_version\": " << metadata.format_version << ",\n"
         << "  \"patch_dim\": " << metadata.patch_dimension << ",\n"
         << "  \"height_scale\": " << metadata.height_scale_factor
         << ",\n"
         << "  \"srs\": " << json_escape(metadata.srs) << ",\n"
         << "  \"about\": " << json_escape(metadata.about) << ",\n"
         << "  \"transform\": {\n"
         << "    \"kind\": \"" << (planar ? "planar" : "cylindrical")
         << "\",\n"
         << "    \"bounds\": [[" << metadata.bounds.minimum[0] << ", "
         << metadata.bounds.minimum[1] << "], ["
         << metadata.bounds.maximum[0] << ", "
         << metadata.bounds.maximum[1] << "]],\n"
         << "    \"radius\": " << metadata.radius << ",\n"
         << "    \"root_count\": " << root_count << "\n"
         << "  },\n"
         << "  \"levels\": {\"minimum\": " << config.minimum_level
         << ", \"maximum\": " << config.maximum_level << "},\n"
         << "  \"codec\": {\n"
         << "    \"name\": \"cbdam-quantized-height\",\n"
         << "    \"version\": 1,\n"
         << "    \"record_framing\": "
            "\"uint32le-length-prefixed-fragments\",\n"
         << "    \"checksum\": \"fnv1a64\"\n"
         << "  },\n"
         << "  \"endpoints\": {\n"
         << "    \"root\": "
         << json_escape(base + "/roots/{i}/{j}/{k}") << ",\n"
         << "    \"detail\": "
         << json_escape(base + "/patches/{i}/{j}/{k}") << "\n"
         << "  },\n"
         << "  \"textures\": [";
  for (std::size_t index = 0; index < config.textures.size(); ++index) {
    const texture_descriptor& texture = config.textures[index];
    if (index != 0U) {
      output << ',';
    }
    output << "\n    {\"id\": " << json_escape(texture.id)
           << ", \"kind\": " << json_escape(texture.kind)
           << ", \"url_template\": "
           << json_escape(texture.url_template)
           << ", \"matrix_level_offset\": "
           << texture.matrix_level_offset << ", \"maximum_level\": "
           << texture.maximum_level << '}';
  }
  if (!config.textures.empty()) {
    output << '\n' << "  ";
  }
  output << "]\n}\n";
  return output.str();
}

}  // namespace

class terrain_service::implementation {
 public:
  terrain_dataset_config config;
  core::dataset_metadata metadata;
  std::size_t root_count = 0U;
  vic::vfs::repository root_repository;
  vic::vfs::repository detail_repository;
  bool opened = false;

  http_response record_response(bool root, const core::grid_point& key,
                                bool head,
                                const std::string& if_none_match) const {
    const vic::vfs::repository& repository =
        root ? root_repository : detail_repository;
    const vic::vfs::repository::key_t repository_key(
        key[0], key[1], key[2]);
    if (!repository.has_data(repository_key)) {
      return problem(404, "patch_not_found",
                     root ? "root patch was not found"
                          : "detail patch was not found");
    }
    vic::vfs::repository::uint32_t size = 0U;
    const std::uint8_t* data = repository.get_data(repository_key, size);
    if (!data || size == 0U) {
      return problem(500, "repository_read_failed",
                     "repository returned an invalid patch record");
    }

    http_response response;
    response.status = 200;
    response.content_type = patch_media_type;
    const std::vector<std::uint8_t> payload(data, data + size);
    const std::string response_etag = etag(payload);
    set_header(response, "Content-Length", std::to_string(payload.size()));
    set_header(response, "X-Terra-Format-Version", "1");
    set_header(response, "X-Terra-Checksum", checksum(payload));
    set_header(response, "ETag", response_etag);
    set_header(response, "Cache-Control",
               "public, max-age=31536000, immutable");
    set_header(response, "X-Content-Type-Options", "nosniff");
    if (!if_none_match.empty() && if_none_match == response_etag) {
      response.status = 304;
      response.content_type.clear();
      return response;
    }
    if (!head) {
      response.body = payload;
    }
    return response;
  }
};

std::string http_response::header(const std::string& name) const {
  return header_value(headers, name);
}

payload_validation_status validate_payload(
    const std::vector<std::uint8_t>& payload,
    const std::string& expected_length,
    const std::string& expected_checksum) {
  std::size_t length = 0U;
  if (!parse_size(expected_length, length)) {
    return payload_validation_status::invalid_length;
  }
  if (expected_checksum.size() != std::char_traits<char>::length(checksum_prefix) +
                                      16U ||
      expected_checksum.compare(0U,
                                std::char_traits<char>::length(checksum_prefix),
                                checksum_prefix) != 0) {
    return payload_validation_status::invalid_checksum;
  }
  for (std::size_t index = std::char_traits<char>::length(checksum_prefix);
       index < expected_checksum.size(); ++index) {
    if (!std::isxdigit(static_cast<unsigned char>(expected_checksum[index]))) {
      return payload_validation_status::invalid_checksum;
    }
  }
  if (payload.size() != length) {
    return payload_validation_status::length_mismatch;
  }
  if (lower_ascii(expected_checksum) != checksum(payload)) {
    return payload_validation_status::checksum_mismatch;
  }
  return payload_validation_status::ok;
}

const char* payload_validation_status_message(
    payload_validation_status status) {
  switch (status) {
    case payload_validation_status::ok:
      return "ok";
    case payload_validation_status::invalid_length:
      return "invalid content length";
    case payload_validation_status::invalid_checksum:
      return "invalid payload checksum";
    case payload_validation_status::length_mismatch:
      return "payload length mismatch";
    case payload_validation_status::checksum_mismatch:
      return "payload checksum mismatch";
  }
  return "unknown payload validation status";
}

terrain_service::terrain_service()
    : implementation_(new implementation()) {}

terrain_service::~terrain_service() = default;
terrain_service::terrain_service(terrain_service&& other) noexcept = default;
terrain_service& terrain_service::operator=(terrain_service&& other) noexcept =
    default;

bool terrain_service::open(const terrain_dataset_config& config,
                           std::string& error) {
  implementation_.reset(new implementation());
  if (!safe_identifier(config.dataset_id)) {
    error = "dataset ID must contain only letters, digits, hyphens, or underscores";
    return false;
  }
  if (config.terrain_base_path.empty()) {
    error = "terrain base path is missing";
    return false;
  }
  if (config.minimum_level < 0 ||
      config.maximum_level < config.minimum_level ||
      config.maximum_level >= 40) {
    error = "terrain level range is invalid";
    return false;
  }
  for (const texture_descriptor& texture : config.textures) {
    if (!safe_identifier(texture.id) || texture.kind.empty() ||
        texture.url_template.empty() || texture.matrix_level_offset < 0 ||
        texture.maximum_level < 0 || texture.maximum_level > 28) {
      error = "texture descriptor is invalid";
      return false;
    }
  }

  if (!read_metadata(config.terrain_base_path + ".xml",
                     implementation_->metadata,
                     implementation_->root_count, error)) {
    return false;
  }
  implementation_->root_repository.open_read(
      config.terrain_base_path + ".root");
  if (!implementation_->root_repository.is_open()) {
    error = "unable to open terrain root repository";
    return false;
  }
  implementation_->detail_repository.open_read(
      config.terrain_base_path + ".data");
  if (!implementation_->detail_repository.is_open()) {
    error = "unable to open terrain detail repository";
    return false;
  }
  implementation_->config = config;
  implementation_->opened = true;
  error.clear();
  return true;
}

bool terrain_service::is_open() const {
  return implementation_ && implementation_->opened;
}

const core::dataset_metadata& terrain_service::metadata() const {
  return implementation_->metadata;
}

http_response terrain_service::handle(const http_request& request) const {
  if (!is_open()) {
    return problem(503, "service_unavailable",
                   "terrain dataset is not open");
  }
  const bool head = request.method == "HEAD";
  if (request.method != "GET" && !head) {
    http_response response =
        problem(405, "method_not_allowed", "only GET and HEAD are supported");
    set_header(response, "Allow", "GET, HEAD");
    return response;
  }

  const std::vector<std::string> segments = split_path(request.target);
  if (segments.size() < 5U || segments[0] != "terra" ||
      segments[1] != "v1" || segments[2] != "datasets") {
    return problem(400, "malformed_path",
                   "request path does not match the terrain v1 contract");
  }
  if (segments[3] != implementation_->config.dataset_id) {
    return problem(404, "dataset_not_found", "dataset was not found");
  }

  const std::string if_none_match =
      header_value(request.headers, "If-None-Match");
  if (segments.size() == 5U && segments[4] == "manifest") {
    const std::vector<std::uint8_t> payload = bytes(manifest_json(
        implementation_->config, implementation_->metadata,
        implementation_->root_count));
    const std::string response_etag = etag(payload);
    http_response response;
    response.status = 200;
    response.content_type = manifest_media_type;
    set_header(response, "Content-Length", std::to_string(payload.size()));
    set_header(response, "X-Terra-Format-Version", "1");
    set_header(response, "X-Terra-Checksum", checksum(payload));
    set_header(response, "ETag", response_etag);
    set_header(response, "Cache-Control", "public, max-age=60");
    set_header(response, "X-Content-Type-Options", "nosniff");
    if (!if_none_match.empty() && if_none_match == response_etag) {
      response.status = 304;
      response.content_type.clear();
      return response;
    }
    if (!head) {
      response.body = payload;
    }
    return response;
  }

  if (segments.size() != 8U ||
      (segments[4] != "roots" && segments[4] != "patches")) {
    return problem(400, "malformed_path",
                   "request path does not match a terrain patch endpoint");
  }
  core::grid_point key = {{0, 0, 0}};
  if (!parse_grid_value(segments[5], key[0]) ||
      !parse_grid_value(segments[6], key[1]) ||
      !parse_grid_value(segments[7], key[2])) {
    return problem(400, "malformed_patch_key",
                   "patch key must contain three bounded decimal integers");
  }
  return implementation_->record_response(
      segments[4] == "roots", key, head, if_none_match);
}

}  // namespace service
}  // namespace terra