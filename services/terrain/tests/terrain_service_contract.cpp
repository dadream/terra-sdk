#include <terra/service/terrain_service.hpp>

#include <vic/vfs/repository.hpp>

#include <cstdint>
#include <fstream>
#include <iterator>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

terra::service::http_response request(
    const terra::service::terrain_service& service,
    const std::string& method, const std::string& target,
    const terra::service::http_headers& headers = {}) {
  terra::service::http_request value;
  value.method = method;
  value.target = target;
  value.headers = headers;
  return service.handle(value);
}

std::string text(const terra::service::http_response& response) {
  return std::string(response.body.begin(), response.body.end());
}

std::vector<std::uint8_t> file_payload(const std::string& path) {
  std::ifstream input(path.c_str(), std::ios::in | std::ios::binary);
  require(static_cast<bool>(input), "texture fixture failed to open");
  return std::vector<std::uint8_t>(std::istreambuf_iterator<char>(input),
                                   std::istreambuf_iterator<char>());
}

std::vector<std::uint8_t> current_repository_payload(
    const std::string& repository_path, std::int32_t i, std::int32_t j,
    std::int32_t k) {
  vic::vfs::repository repository;
  repository.open_read(repository_path);
  require(repository.is_open(), "current repository reader failed to open");
  const vic::vfs::repository::key_t key(i, j, k);
  vic::vfs::repository::uint32_t size = 0U;
  const std::uint8_t* data = repository.get_data(key, size);
  require(data != nullptr && size != 0U,
          "current repository reader returned no payload");
  return std::vector<std::uint8_t>(data, data + size);
}

void require_payload_contract(
    const terra::service::http_response& response,
    const std::vector<std::uint8_t>& expected) {
  require(response.status == 200, "patch response status changed");
  require(response.content_type == "application/octet-stream",
          "patch media type changed");
  require(response.body == expected,
          "service payload differs from current repository reader");
  require(response.header("X-Terra-Format-Version") == "1",
          "patch format version header changed");
  require(response.header("Cache-Control") ==
              "public, max-age=31536000, immutable",
          "patch cache policy changed");
  require(!response.header("ETag").empty(), "patch ETag is missing");
  require(terra::service::validate_payload(
              response.body, response.header("Content-Length"),
              response.header("X-Terra-Checksum")) ==
              terra::service::payload_validation_status::ok,
          "valid patch payload failed integrity validation");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 3, "expected terrain base path and texture arguments");
    const std::string terrain_base = argv[1];
    const std::string texture_path = argv[2];

    terra::service::terrain_dataset_config config;
    config.dataset_id = "ps-1k";
    config.terrain_base_path = terrain_base;
    config.minimum_level = 0;
    config.maximum_level = 30;
    terra::service::texture_descriptor external_texture;
    external_texture.id = "blue-marble";
    external_texture.kind = "global-geodetic";
    external_texture.url_template =
        "https://example.invalid/blue-marble/{z}/{x}/{y}.jpg";
    external_texture.maximum_level = 8;
    config.textures.push_back(external_texture);

    terra::service::texture_descriptor texture;
    texture.id = "ps-1k";
    texture.kind = "planar-single";
    texture.url_template = "/terra/v1/datasets/ps-1k/textures/ps-1k";
    texture.local_file_path = texture_path;
    texture.maximum_level = 0;
    config.textures.push_back(texture);

    terra::service::terrain_service closed_service;
    require(request(closed_service, "GET",
                    "/terra/v1/datasets/ps-1k/manifest")
                .status == 503,
            "unopened service did not return 503");

    terra::service::terrain_service service;
    std::string error;
    require(service.open(config, error), "service open failed: " + error);
    require(service.is_open(), "service did not remain open");
    require(service.metadata().patch_dimension == 64U,
            "service metadata patch dimension changed");

    const auto manifest =
        request(service, "GET", "/terra/v1/datasets/ps-1k/manifest");
    require(manifest.status == 200, "manifest response failed");
    require(manifest.content_type ==
                "application/vnd.terra.dataset+json;version=1",
            "manifest media type changed");
    const std::string manifest_text = text(manifest);
    require(manifest_text.find("\"schema_version\": 1") !=
                std::string::npos,
            "manifest schema version is missing");
    require(manifest_text.find("\"patch_dim\": 64") !=
                std::string::npos,
            "manifest patch dimension is missing");
    require(manifest_text.find("/roots/{i}/{j}/{k}") !=
                std::string::npos &&
                manifest_text.find("/patches/{i}/{j}/{k}") !=
                    std::string::npos,
            "manifest endpoint templates are missing");
    require(manifest_text.find("planar-single") != std::string::npos,
            "manifest texture descriptor is missing");
    require(manifest_text.find("blue-marble") != std::string::npos,
            "manifest external texture descriptor is missing");
    require(manifest_text.find(terrain_base) == std::string::npos,
            "manifest leaked a repository path");
    require(terra::service::validate_payload(
                manifest.body, manifest.header("Content-Length"),
                manifest.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::ok,
            "manifest integrity contract failed");
    const auto manifest_not_modified = request(
        service, "GET", "/terra/v1/datasets/ps-1k/manifest",
        {{"If-None-Match", manifest.header("ETag")}});
    require(manifest_not_modified.status == 304 &&
                manifest_not_modified.body.empty(),
            "conditional manifest request did not return 304");

    const std::vector<std::uint8_t> expected_texture =
        file_payload(texture_path);
    const auto texture_response = request(
        service, "GET", "/terra/v1/datasets/ps-1k/textures/ps-1k");
    require(texture_response.status == 200 &&
                texture_response.content_type == "image/png" &&
                texture_response.body == expected_texture,
            "planar texture response changed");
    require(terra::service::validate_payload(
                texture_response.body,
                texture_response.header("Content-Length"),
                texture_response.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::ok,
            "planar texture integrity contract failed");
    const auto texture_head = request(
        service, "HEAD", "/terra/v1/datasets/ps-1k/textures/ps-1k");
    require(texture_head.status == 200 && texture_head.body.empty() &&
                texture_head.header("Content-Length") ==
                    std::to_string(expected_texture.size()),
            "planar texture HEAD contract changed");
    const auto texture_not_modified = request(
        service, "GET", "/terra/v1/datasets/ps-1k/textures/ps-1k",
        {{"If-None-Match", texture_response.header("ETag")}});
    require(texture_not_modified.status == 304 &&
                texture_not_modified.body.empty(),
            "conditional texture request did not return 304");

    const std::vector<std::uint8_t> root_payload =
        current_repository_payload(terrain_base + ".root", 0, 0,
                                   268435456);
    require(root_payload.size() == 10967U,
            "checked-in root record size changed");
    const auto root = request(
        service, "GET",
        "/terra/v1/datasets/ps-1k/roots/0/0/268435456");
    require_payload_contract(root, root_payload);

    const std::vector<std::uint8_t> detail_payload =
        current_repository_payload(terrain_base + ".data", -268435456, 0,
                                   268435456);
    require(detail_payload.size() == 9225U,
            "checked-in detail record size changed");
    const auto detail = request(
        service, "GET",
        "/terra/v1/datasets/ps-1k/patches/-268435456/0/268435456");
    require_payload_contract(detail, detail_payload);

    std::vector<std::uint8_t> truncated = detail.body;
    truncated.pop_back();
    require(terra::service::validate_payload(
                truncated, detail.header("Content-Length"),
                detail.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::length_mismatch,
            "truncated payload was not rejected");
    truncated = detail.body;
    truncated[0] ^= 0x01U;
    require(terra::service::validate_payload(
                truncated, detail.header("Content-Length"),
                detail.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::checksum_mismatch,
            "corrupt payload was not rejected");
    require(terra::service::validate_payload(
                detail.body, "+9225", detail.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::invalid_length,
            "signed length header was not rejected");
    require(terra::service::validate_payload(
                detail.body, "invalid", detail.header("X-Terra-Checksum")) ==
                terra::service::payload_validation_status::invalid_length,
            "invalid length header was not rejected");
    require(terra::service::validate_payload(
                detail.body, detail.header("Content-Length"), "sha256:bad") ==
                terra::service::payload_validation_status::invalid_checksum,
            "invalid checksum header was not rejected");

    const auto not_modified = request(
        service, "GET",
        "/terra/v1/datasets/ps-1k/patches/-268435456/0/268435456",
        {{"If-None-Match", detail.header("ETag")}});
    require(not_modified.status == 304 && not_modified.body.empty(),
            "conditional patch request did not return 304");

    const auto head = request(
        service, "HEAD",
        "/terra/v1/datasets/ps-1k/roots/0/0/268435456");
    require(head.status == 200 && head.body.empty() &&
                head.header("Content-Length") ==
                    std::to_string(root_payload.size()),
            "HEAD patch contract changed");

    require(request(service, "GET",
                    "/terra/v1/datasets/ps-1k/patches/a/0/0")
                .status == 400,
            "nonnumeric patch key was accepted");
    require(request(service, "GET",
                    "/terra/v1/datasets/ps-1k/patches/268435457/0/0")
                .status == 400,
            "out-of-grid patch key was accepted");
    require(request(service, "GET",
                    "/terra/v1/datasets/ps-1k/roots/-268435456/0/268435456")
                .status == 404,
            "detail record leaked through the root endpoint");
    require(request(service, "GET",
                    "/terra/v1/datasets/ps-1k/patches/123/456/789")
                .status == 404,
            "missing patch did not return 404");
    require(request(service, "GET",
                    "/terra/v1/datasets/unknown/manifest")
                .status == 404,
            "unknown dataset did not return 404");
    require(request(service, "POST",
                    "/terra/v1/datasets/ps-1k/manifest")
                .status == 405,
            "unsupported method did not return 405");
    require(request(service, "GET",
                    "/terra/v1/datasets/ps-1k/../terrain.data")
                .status == 400,
            "path traversal shape was not rejected");

    terra::service::terrain_dataset_config invalid = config;
    invalid.dataset_id = "../unsafe";
    terra::service::terrain_service invalid_service;
    require(!invalid_service.open(invalid, error),
            "unsafe dataset ID was accepted");

    std::cout << "Terrain service v1 contract and repository parity passed.\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << exception.what() << '\n';
    return 1;
  }
}