#include <vic/fetcher/text_fetcher.hpp>

#include <iostream>
#include <string>

namespace {

class test_text_fetcher : public vic::text_fetcher {
public:
  value_t* decode_bytes(const sl::uint8_t* buf, std::size_t buf_size) const {
    return decoded(buf, buf_size);
  }

  void push_test_result(const std::string& key,
                        status_t status,
                        value_t* value) {
    push_result(key, std::make_pair(status, value));
  }
};

int fail(const std::string& message) {
  std::cerr << "SDK smoke failed: " << message << std::endl;
  return 1;
}

test_text_fetcher::value_t* make_text(const std::string& text) {
  test_text_fetcher::value_t* value = new test_text_fetcher::value_t;
  value->assign(text.begin(), text.end());
  return value;
}

std::string to_string(const test_text_fetcher::value_t& value) {
  return std::string(value.begin(), value.end());
}

int check_fetcher_state(test_text_fetcher& fetcher) {
  if (fetcher.is_connected()) {
    return fail("vic_base_fetcher initial connection state changed");
  }
  if (!fetcher.is_http("http://example.test/data.txt") ||
      fetcher.is_http("https://example.test/data.txt") ||
      fetcher.is_http("file:///tmp/data.txt")) {
    return fail("vic_base_fetcher URL protocol classification changed");
  }
  if (!fetcher.is_http_pipelining() || fetcher.batch_count() == 0 ||
      fetcher.buffer_capacity() != 16 || fetcher.buffer_size() != 0) {
    return fail("vic_base_fetcher initial capacity/pipelining changed");
  }

  return 0;
}

int check_text_decode(test_text_fetcher& fetcher) {
  const sl::uint8_t bytes[] = {
      static_cast<sl::uint8_t>('h'),
      static_cast<sl::uint8_t>('e'),
      static_cast<sl::uint8_t>('l'),
      static_cast<sl::uint8_t>('l'),
      static_cast<sl::uint8_t>('o')};
  test_text_fetcher::value_t* decoded =
      fetcher.decode_bytes(bytes, sizeof(bytes));
  if (!decoded || decoded->size() != 5 || to_string(*decoded) != "hello") {
    delete decoded;
    return fail("vic_base_fetcher text decode contract changed");
  }
  delete decoded;

  return 0;
}

int check_result_buffer(test_text_fetcher& fetcher) {
  fetcher.push_test_result("one", test_text_fetcher::DONE, make_text("one"));
  if (fetcher.buffer_size() != 1 || !fetcher.is_serving("one")) {
    return fail("vic_base_fetcher result buffer push changed");
  }

  test_text_fetcher::status_data_pair_t result = fetcher.fetch("one");
  if (result.first != test_text_fetcher::DONE || !result.second ||
      to_string(*result.second) != "one" || fetcher.buffer_size() != 0) {
    delete result.second;
    return fail("vic_base_fetcher result fetch changed");
  }
  delete result.second;

  fetcher.push_test_result("empty", test_text_fetcher::NULL_DATA, 0);
  result = fetcher.fetch("empty");
  if (result.first != test_text_fetcher::NULL_DATA || result.second != 0) {
    return fail("vic_base_fetcher null result handling changed");
  }

  for (int i = 0; i < 17; ++i) {
    std::string key("key");
    key += static_cast<char>('A' + i);
    std::string value("value");
    value += static_cast<char>('A' + i);
    fetcher.push_test_result(key, test_text_fetcher::DONE, make_text(value));
  }
  if (fetcher.buffer_size() != fetcher.buffer_capacity()) {
    fetcher.clear();
    return fail("vic_base_fetcher result buffer capacity changed");
  }

  result = fetcher.fetch("keyA");
  if (result.first != test_text_fetcher::NOT_FOUND || result.second != 0) {
    delete result.second;
    fetcher.clear();
    return fail("vic_base_fetcher oldest result eviction changed");
  }

  result = fetcher.fetch("keyB");
  if (result.first != test_text_fetcher::DONE || !result.second ||
      to_string(*result.second) != "valueB") {
    delete result.second;
    fetcher.clear();
    return fail("vic_base_fetcher post-eviction result changed");
  }
  delete result.second;

  fetcher.clear();
  if (fetcher.buffer_size() != 0) {
    return fail("vic_base_fetcher clear changed");
  }

  return 0;
}

}  // namespace

int main() {
  test_text_fetcher fetcher;
  fetcher.update_stop();

  if (int status = check_fetcher_state(fetcher)) {
    return status;
  }
  if (int status = check_text_decode(fetcher)) {
    return status;
  }
  if (int status = check_result_buffer(fetcher)) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_fetcher lifecycle and text decode"
            << std::endl;
  return 0;
}
