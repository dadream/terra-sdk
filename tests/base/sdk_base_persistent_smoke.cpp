#include <vic/persistent/map.hpp>

#include <cstdio>
#include <iostream>
#include <string>
#include <unistd.h>

namespace {

typedef vic::persistent::map<int, int> int_map_t;

int fail(const std::string& message) {
  std::cerr << "Persistent SDK smoke failed: " << message << std::endl;
  return 1;
}

std::string temp_path(const std::string& suffix) {
  char buffer[256];
  snprintf(buffer, sizeof(buffer), "/tmp/terra_sdk_persistent_%ld_%s",
           static_cast<long>(getpid()), suffix.c_str());
  std::remove(buffer);
  return std::string(buffer);
}

bool exists(const std::string& path) {
  return access(path.c_str(), F_OK) == 0;
}

int check_map_write_iteration_and_clear() {
  const std::string path = temp_path("map.db");

  {
    int_map_t values(path, "w", 32);
    if (!values.is_open() || !values.is_writable() ||
        !values.is_persistent() || !values.is_empty_at_creation()) {
      return fail("persistent map write-mode metadata changed");
    }
    if (values.file_name() != path || !values.empty()) {
      return fail("persistent map initial state changed");
    }

    values[2] = 20;
    values[1] = 10;
    values[3] = 30;

    {
      std::pair<int_map_t::iterator, bool> duplicate =
          values.insert(std::make_pair(2, 99));
      if (duplicate.second || static_cast<int>(duplicate.first->second) != 20) {
        return fail("persistent map duplicate insert behavior changed");
      }

      int expected_key = 1;
      int expected_value = 10;
      for (int_map_t::const_iterator it = values.begin(); it != values.end();
           ++it) {
        if (it->first != expected_key || it->second != expected_value) {
          return fail("persistent map ordered iteration changed");
        }
        ++expected_key;
        expected_value += 10;
      }
      if (expected_key != 4 || values.size() != 3) {
        return fail("persistent map size after insert changed");
      }

      int_map_t::iterator current = values.find(2);
      if (current == values.end() || current->first != 2 ||
          static_cast<int>(current->second) != 20) {
        return fail("persistent map find changed");
      }
      current->second = 22;
      if (static_cast<int>(values.find(2)->second) != 22) {
        return fail("persistent map data reference update changed");
      }

      int_map_t::iterator lower = values.lower_bound(2);
      int_map_t::iterator next = lower;
      ++next;
      if (lower == values.end() || lower->first != 2 ||
          next == values.end() || next->first != 3) {
        return fail("persistent map bound lookup changed");
      }
    }

    values.clear();
    if (!values.empty() || values.size() != 0) {
      return fail("persistent map clear changed");
    }
  }

  std::remove(path.c_str());
  return 0;
}

int check_persistent_reopen() {
  const std::string path = temp_path("reopen.db");

  {
    int_map_t writer(path, "w", 32);
    writer[4] = 40;
    writer[5] = 50;
  }

  {
    int_map_t reader(path, "r");
    if (!reader.is_open() || reader.is_writable() ||
        !reader.is_persistent() || reader.file_name() != path) {
      return fail("persistent map read-mode metadata changed");
    }
    int_map_t::const_iterator first = reader.find(4);
    int_map_t::const_iterator second = reader.find(5);
    if (first == reader.end() || second == reader.end() ||
        first->second != 40 || second->second != 50 ||
        reader.size() != 2) {
      return fail("persistent map reopen roundtrip changed");
    }
  }

  std::remove(path.c_str());
  return 0;
}

int check_temporary_cleanup() {
  const std::string path = temp_path("temporary.db");

  {
    int_map_t temporary(path, "t");
    if (!temporary.is_open() || !temporary.is_writable() ||
        temporary.is_persistent()) {
      return fail("temporary persistent map metadata changed");
    }
    temporary[7] = 70;
    if (!exists(path)) {
      return fail("temporary persistent map did not create backing file");
    }
  }

  if (exists(path)) {
    std::remove(path.c_str());
    return fail("temporary persistent map did not remove backing file");
  }
  return 0;
}

}  // namespace

int main() {
  if (int status = check_map_write_iteration_and_clear()) {
    return status;
  }
  if (int status = check_persistent_reopen()) {
    return status;
  }
  if (int status = check_temporary_cleanup()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_persistent map"
            << std::endl;
  return 0;
}
