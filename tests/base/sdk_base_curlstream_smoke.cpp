#include <vic/curlstream/curlstream.hpp>
#include <vic/curlstream/url.hpp>

#include <cstdio>
#include <iostream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "SDK smoke failed: " << message << std::endl;
  return 1;
}

int check_url_parser() {
  vic::url parsed("http://user:pass@example.com:8080/a/b/c.txt");
  if (parsed.protocol() != "http" ||
      parsed.auth() != "user:pass" ||
      parsed.host() != "example.com" ||
      parsed.port() != "8080" ||
      parsed.path() != "/a/b/c.txt") {
    return fail("vic_base_curlstream URL parser contract changed");
  }

  vic::url local("tiles/0/1.png");
  if (!local.protocol().empty() || !local.host().empty() ||
      !local.port().empty() || !local.auth().empty() ||
      local.path() != "tiles/0/1.png") {
    return fail("vic_base_curlstream relative URL contract changed");
  }

  vic::url base = parsed.base();
  if (base.url_string() !=
      "http://user:pass@example.com:8080//a/b/") {
    return fail("vic_base_curlstream URL base contract changed");
  }

  vic::url combined = base + vic::url("tile.xml");
  if (combined.url_string() !=
      "http://user:pass@example.com:8080//a/b/tile.xml") {
    return fail("vic_base_curlstream relative URL combination changed");
  }

  vic::url absolute = base + vic::url("/override.xml");
  if (absolute.url_string() != "/override.xml") {
    return fail("vic_base_curlstream absolute URL override changed");
  }

  return 0;
}

int check_local_stream() {
  const char* path = "terra_sdk_curlstream_smoke.txt";
  {
    vic::ocurlstream output(path);
    if (!output || !output.rdbuf()->is_open()) {
      return fail("vic_base_curlstream local output open failed");
    }
    output << "alpha" << '\n' << "beta" << '\n';
    output.close();
    if (!output) {
      std::remove(path);
      return fail("vic_base_curlstream local output close failed");
    }
  }

  {
    vic::icurlstream input(path);
    if (!input || !input.rdbuf()->is_open()) {
      std::remove(path);
      return fail("vic_base_curlstream local input open failed");
    }
    std::string first;
    std::string second;
    std::string third;
    std::getline(input, first);
    std::getline(input, second);
    std::getline(input, third);
    if (first != "alpha" || second != "beta" || !third.empty()) {
      std::remove(path);
      return fail("vic_base_curlstream local roundtrip content changed");
    }
    input.close();
  }

  std::remove(path);
  return 0;
}

}  // namespace

int main() {
  if (int status = check_url_parser()) {
    return status;
  }
  if (int status = check_local_stream()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_curlstream URL and local stream"
            << std::endl;
  return 0;
}
