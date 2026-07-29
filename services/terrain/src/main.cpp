#include <terra/service/terrain_service.hpp>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <signal.h>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>

namespace {

volatile sig_atomic_t stop_requested = 0;

void request_stop(int) {
  stop_requested = 1;
}

struct options {
  std::string dataset_id;
  std::string terrain_base_path;
  std::string bind_address = "127.0.0.1";
  int port = 18081;
  int minimum_level = 0;
  int maximum_level = 30;
  int maximum_requests = 0;
  terra::service::texture_descriptor texture;
  bool has_texture = false;
};

bool parse_int(const std::string& value, int minimum, int maximum,
               int& result) {
  if (value.empty()) {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long parsed = std::strtol(value.c_str(), &end, 10);
  if (errno != 0 || !end || *end != '\0' || parsed < minimum ||
      parsed > maximum) {
    return false;
  }
  result = static_cast<int>(parsed);
  return true;
}

bool valid_dataset_id(const std::string& value) {
  if (value.empty()) {
    return false;
  }
  for (const char character : value) {
    const bool alpha_numeric =
        (character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9');
    if (!alpha_numeric && character != '-' &&
        character != '_' && character != '.') {
      return false;
    }
  }
  return true;
}

bool apply_cloud_environment(options& result) {
  const char* port = std::getenv("PORT");
  if (!port || !*port) {
    return true;
  }
  if (!parse_int(port, 1, 65535, result.port)) {
    return false;
  }
  result.bind_address = "0.0.0.0";
  return true;
}

void print_usage(const char* program) {
  std::cerr
      << "Usage: " << program
      << " --dataset-id ID --terrain BASE [options]\n"
      << "Options:\n"
      << "  --bind ADDRESS             IPv4 address (default 127.0.0.1)\n"
      << "  --port PORT                TCP port (default 18081 or PORT env)\n"
      << "  --min-level LEVEL          Dataset minimum level\n"
      << "  --max-level LEVEL          Dataset maximum level\n"
      << "  --max-requests COUNT       Exit after COUNT requests; 0 is unlimited\n"
      << "  --texture-id ID            Optional texture descriptor ID\n"
      << "  --texture-kind KIND        Optional texture descriptor kind\n"
      << "  --texture-template URL     Optional credential-free URL template\n"
      << "  --texture-file FILE        Optional local PNG served by descriptor ID\n"
      << "  --texture-level-offset N   Optional matrix level offset\n"
      << "  --texture-max-level N      Optional maximum texture level\n";
}

bool take_value(int argc, char** argv, int& index, std::string& value) {
  if (index + 1 >= argc) {
    return false;
  }
  ++index;
  value = argv[index];
  return true;
}

bool parse_options(int argc, char** argv, options& result) {
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    std::string value;
    if (argument == "--help") {
      return false;
    }
    if (argument == "--dataset-id") {
      if (!take_value(argc, argv, index, result.dataset_id)) {
        return false;
      }
    } else if (argument == "--terrain") {
      if (!take_value(argc, argv, index, result.terrain_base_path)) {
        return false;
      }
    } else if (argument == "--bind") {
      if (!take_value(argc, argv, index, result.bind_address)) {
        return false;
      }
    } else if (argument == "--port") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 1, 65535, result.port)) {
        return false;
      }
    } else if (argument == "--min-level") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 0, 39, result.minimum_level)) {
        return false;
      }
    } else if (argument == "--max-level") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 0, 39, result.maximum_level)) {
        return false;
      }
    } else if (argument == "--max-requests") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 0, std::numeric_limits<int>::max(),
                     result.maximum_requests)) {
        return false;
      }
    } else if (argument == "--texture-id") {
      if (!take_value(argc, argv, index, result.texture.id)) {
        return false;
      }
      result.has_texture = true;
    } else if (argument == "--texture-kind") {
      if (!take_value(argc, argv, index, result.texture.kind)) {
        return false;
      }
      result.has_texture = true;
    } else if (argument == "--texture-template") {
      if (!take_value(argc, argv, index, result.texture.url_template)) {
        return false;
      }
      result.has_texture = true;
    } else if (argument == "--texture-file") {
      if (!take_value(argc, argv, index, result.texture.local_file_path)) {
        return false;
      }
      result.has_texture = true;
    } else if (argument == "--texture-level-offset") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 0, 28, result.texture.matrix_level_offset)) {
        return false;
      }
      result.has_texture = true;
    } else if (argument == "--texture-max-level") {
      if (!take_value(argc, argv, index, value) ||
          !parse_int(value, 0, 28, result.texture.maximum_level)) {
        return false;
      }
      result.has_texture = true;
    } else {
      return false;
    }
  }
  return valid_dataset_id(result.dataset_id) &&
         !result.terrain_base_path.empty();
}

std::string trim(const std::string& value) {
  const std::size_t begin = value.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) {
    return std::string();
  }
  const std::size_t end = value.find_last_not_of(" \t\r\n");
  return value.substr(begin, end - begin + 1U);
}

bool read_request(int socket, terra::service::http_request& request) {
  std::string input;
  input.reserve(4096U);
  char buffer[2048];
  while (input.find("\r\n\r\n") == std::string::npos) {
    const ssize_t count = recv(socket, buffer, sizeof(buffer), 0);
    if (count <= 0) {
      return false;
    }
    input.append(buffer, static_cast<std::size_t>(count));
    if (input.size() > 16384U) {
      return false;
    }
  }

  std::istringstream lines(input.substr(0U, input.find("\r\n\r\n")));
  std::string line;
  if (!std::getline(lines, line)) {
    return false;
  }
  line = trim(line);
  std::istringstream first_line(line);
  std::string version;
  if (!(first_line >> request.method >> request.target >> version) ||
      version.compare(0U, 5U, "HTTP/") != 0) {
    return false;
  }
  while (std::getline(lines, line)) {
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    const std::size_t separator = line.find(':');
    if (separator == std::string::npos) {
      return false;
    }
    request.headers.emplace_back(trim(line.substr(0U, separator)),
                                 trim(line.substr(separator + 1U)));
  }
  return true;
}

const char* reason_phrase(int status) {
  switch (status) {
    case 200:
      return "OK";
    case 304:
      return "Not Modified";
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

bool send_all(int socket, const std::uint8_t* data, std::size_t size) {
  std::size_t sent = 0U;
  while (sent < size) {
    const ssize_t count =
        send(socket, data + sent, size - sent, MSG_NOSIGNAL);
    if (count <= 0) {
      return false;
    }
    sent += static_cast<std::size_t>(count);
  }
  return true;
}

bool send_response(int socket, const terra::service::http_response& response) {
  std::ostringstream headers;
  headers << "HTTP/1.1 " << response.status << ' '
          << reason_phrase(response.status) << "\r\n"
          << "Server: terra-terrain-service/1\r\n"
          << "Connection: close\r\n";
  if (!response.content_type.empty()) {
    headers << "Content-Type: " << response.content_type << "\r\n";
  }
  for (const auto& header : response.headers) {
    headers << header.first << ": " << header.second << "\r\n";
  }
  headers << "\r\n";
  const std::string header_text = headers.str();
  if (!send_all(socket,
                reinterpret_cast<const std::uint8_t*>(header_text.data()),
                header_text.size())) {
    return false;
  }
  return response.body.empty() ||
         send_all(socket, response.body.data(), response.body.size());
}

terra::service::http_response health_response(const std::string& dataset_id) {
  terra::service::http_response response;
  response.status = 200;
  response.content_type = "application/json";
  const std::string body =
      "{\"status\":\"ok\",\"dataset\":\"" + dataset_id + "\"}\n";
  response.body.assign(body.begin(), body.end());
  response.headers.emplace_back("Cache-Control", "no-store");
  response.headers.emplace_back("Content-Length",
                                std::to_string(response.body.size()));
  return response;
}

}  // namespace

int main(int argc, char** argv) {
  options parsed;
  if (!apply_cloud_environment(parsed) ||
      !parse_options(argc, argv, parsed)) {
    print_usage(argv[0]);
    return 2;
  }

  terra::service::terrain_dataset_config config;
  config.dataset_id = parsed.dataset_id;
  config.terrain_base_path = parsed.terrain_base_path;
  config.minimum_level = parsed.minimum_level;
  config.maximum_level = parsed.maximum_level;
  if (parsed.has_texture) {
    config.textures.push_back(parsed.texture);
  }

  terra::service::terrain_service service;
  std::string error;
  if (!service.open(config, error)) {
    std::cerr << "[terrain-service][error] startup_failed reason=" << error
              << '\n';
    return 1;
  }

  const int server = socket(AF_INET, SOCK_STREAM, 0);
  if (server < 0) {
    std::cerr << "[terrain-service][error] socket_failed\n";
    return 1;
  }
  const int reuse = 1;
  if (setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) !=
      0) {
    std::cerr << "[terrain-service][error] socket_option_failed\n";
    close(server);
    return 1;
  }

  sockaddr_in address;
  std::memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(static_cast<std::uint16_t>(parsed.port));
  if (inet_pton(AF_INET, parsed.bind_address.c_str(), &address.sin_addr) != 1) {
    std::cerr << "[terrain-service][error] invalid_bind_address\n";
    close(server);
    return 1;
  }
  if (bind(server, reinterpret_cast<const sockaddr*>(&address),
           sizeof(address)) != 0 ||
      listen(server, 16) != 0) {
    std::cerr << "[terrain-service][error] listen_failed\n";
    close(server);
    return 1;
  }

  struct sigaction stop_action;
  std::memset(&stop_action, 0, sizeof(stop_action));
  stop_action.sa_handler = request_stop;
  sigemptyset(&stop_action.sa_mask);
  if (sigaction(SIGINT, &stop_action, nullptr) != 0 ||
      sigaction(SIGTERM, &stop_action, nullptr) != 0) {
    std::cerr << "[terrain-service][error] signal_setup_failed\n";
    close(server);
    return 1;
  }
  std::cout << "[terrain-service] ready address=" << parsed.bind_address
            << " port=" << parsed.port
            << " dataset=" << parsed.dataset_id << '\n';
  std::cout.flush();

  int request_count = 0;
  int client_error_count = 0;
  int error_count = 0;
  while (!stop_requested &&
         (parsed.maximum_requests == 0 ||
          request_count < parsed.maximum_requests)) {
    sockaddr_in client_address;
    socklen_t client_size = sizeof(client_address);
    const int client =
        accept(server, reinterpret_cast<sockaddr*>(&client_address),
               &client_size);
    if (client < 0) {
      if (errno == EINTR) {
        if (stop_requested) {
          break;
        }
        continue;
      }
      std::cerr << "[terrain-service][error] accept_failed\n";
      close(server);
      return 1;
    }

    terra::service::http_request request;
    terra::service::http_response response;
    if (read_request(client, request)) {
      if (request.method == "GET" &&
          (request.target == "/healthz" || request.target == "/readyz")) {
        response = health_response(parsed.dataset_id);
      } else {
        response = service.handle(request);
      }
    } else {
      request.method = "INVALID";
      request.target = "<malformed>";
      response.status = 400;
      response.content_type = "application/problem+json";
      const std::string body =
          "{\"error\":{\"code\":\"malformed_request\","
          "\"message\":\"unable to parse HTTP request\"}}\n";
      response.body.assign(body.begin(), body.end());
      response.headers.emplace_back("Cache-Control", "no-store");
      response.headers.emplace_back("Content-Length",
                                    std::to_string(response.body.size()));
    }
    const bool sent = send_response(client, response);
    close(client);
    ++request_count;
    if (response.status >= 500) {
      ++error_count;
      std::cerr << "[terrain-service][error] request_failed status="
                << response.status << '\n';
    } else if (response.status >= 400) {
      ++client_error_count;
    }
    if (!sent) {
      ++error_count;
      std::cerr << "[terrain-service][error] response_write_failed\n";
    }
  }

  close(server);
  std::cout << "[terrain-service] stopped requests=" << request_count
            << " client_errors=" << client_error_count
            << " errors=" << error_count << '\n';
  return 0;
}
