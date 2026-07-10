#include <vic/vfs/repository.hpp>
#include <vic/vfs/virtual_file_system_local.hpp>

#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

int fail(const std::string& message) {
  std::cerr << "VFS SDK smoke failed: " << message << std::endl;
  return 1;
}

std::string temp_path(const std::string& suffix) {
  char buffer[256];
  snprintf(buffer, sizeof(buffer), "/tmp/terra_sdk_vfs_%ld_%s",
           static_cast<long>(getpid()), suffix.c_str());
  std::remove(buffer);
  return std::string(buffer);
}

vic::vfs::repository::key_t make_key(int x, int y, int z) {
  vic::vfs::repository::key_t key;
  key[0] = x;
  key[1] = y;
  key[2] = z;
  return key;
}

bool payload_equal(const vic::vfs::repository::uint8_t* actual,
                   vic::vfs::repository::uint32_t size,
                   const std::vector<vic::vfs::repository::uint8_t>& expected) {
  return actual && size == expected.size() &&
         std::memcmp(actual, &expected[0], expected.size()) == 0;
}

int check_repository_roundtrip() {
  const std::string path = temp_path("repository.db");
  const vic::vfs::repository::key_t first_key = make_key(1, -2, 3);
  const vic::vfs::repository::key_t second_key = make_key(4, 5, -6);
  const vic::vfs::repository::key_t missing_key = make_key(99, 99, 99);
  std::vector<vic::vfs::repository::uint8_t> first_payload;
  first_payload.push_back(1);
  first_payload.push_back(2);
  first_payload.push_back(3);
  first_payload.push_back(4);
  first_payload.push_back(5);
  std::vector<vic::vfs::repository::uint8_t> second_payload;
  second_payload.push_back(10);
  second_payload.push_back(20);
  second_payload.push_back(30);
  second_payload.push_back(40);

  {
    vic::vfs::repository repo;
    if (repo.is_open()) {
      return fail("new repository unexpectedly starts open");
    }
    repo.open_write(path, 32);
    if (!repo.is_open() || !repo.write_mode()) {
      return fail("repository did not enter write mode");
    }
    if (repo.file_name() != path) {
      return fail("repository write filename changed");
    }

    repo.set_data(first_key, &first_payload[0], first_payload.size());
    repo.set_data(second_key, &second_payload[0], second_payload.size());
    if (!repo.has_data(first_key) || !repo.has_data(second_key)) {
      return fail("repository write mode cannot find inserted payloads");
    }
    repo.close();
    if (repo.is_open()) {
      return fail("repository close left handle open");
    }
  }

  {
    vic::vfs::repository repo;
    repo.open_read(path);
    if (!repo.is_open() || repo.write_mode()) {
      return fail("repository did not enter read mode");
    }
    if (repo.file_name() != path || repo.size() == 0) {
      return fail("repository read metadata changed");
    }
    if (!repo.has_data(first_key) || !repo.has_data(second_key) ||
        repo.has_data(missing_key)) {
      return fail("repository has_data result changed");
    }

    vic::vfs::repository::uint32_t size = 0;
    const vic::vfs::repository::uint8_t* first =
        repo.get_data(first_key, size);
    if (!payload_equal(first, size, first_payload)) {
      return fail("repository first payload roundtrip changed");
    }
    const vic::vfs::repository::uint8_t* second =
        repo.get_data(second_key, size);
    if (!payload_equal(second, size, second_payload)) {
      return fail("repository second payload roundtrip changed");
    }
    if (repo.get_data(missing_key, size) != 0) {
      return fail("repository missing payload unexpectedly returned data");
    }
  }

  std::remove(path.c_str());
  return 0;
}

int check_local_vfs_file_io() {
  const std::string path = temp_path("plain.bin");
  const char payload[] = "local-vfs-file";

  vic::vfs::virtual_file_system_local vfs;
  FILE* out = vfs.open(path, "wb");
  if (!out) {
    return fail("virtual_file_system_local failed to open plain file");
  }
  if (std::fwrite(payload, 1, sizeof(payload), out) != sizeof(payload)) {
    return fail("virtual_file_system_local plain file write failed");
  }
  vfs.close(out);

  FILE* in = vfs.open(path, "rb");
  if (!in) {
    return fail("virtual_file_system_local failed to reopen plain file");
  }
  char read_back[sizeof(payload)] = {0};
  if (std::fread(read_back, 1, sizeof(read_back), in) != sizeof(read_back)) {
    return fail("virtual_file_system_local plain file read failed");
  }
  vfs.close(in);
  if (std::memcmp(read_back, payload, sizeof(payload)) != 0) {
    return fail("virtual_file_system_local plain file payload changed");
  }

  std::remove(path.c_str());
  return 0;
}

int check_local_vfs_repository_io() {
  const std::string path = temp_path("vfs_repository.db");
  const vic::vfs::virtual_file_system_local::key_t first_key =
      make_key(7, 8, 9);
  const vic::vfs::virtual_file_system_local::key_t second_key =
      make_key(-7, -8, -9);
  const vic::vfs::virtual_file_system_local::key_t missing_key =
      make_key(100, 100, 100);

  vic::vfs::virtual_file_system_local::byte_array_t first_payload;
  first_payload.push_back(42);
  first_payload.push_back(43);
  first_payload.push_back(44);
  vic::vfs::virtual_file_system_local::byte_array_t second_payload;
  second_payload.push_back(50);
  second_payload.push_back(60);

  {
    vic::vfs::virtual_file_system_local writer;
    writer.set_max_opened_repositories(1);
    writer.write(path, first_key, first_payload, 16);
    writer.write(path, second_key, second_payload, 16);
  }

  {
    vic::vfs::virtual_file_system_local reader;
    reader.set_max_opened_repositories(1);

    vic::vfs::virtual_file_system_local::byte_array_t read_first;
    reader.fetch(path, first_key, read_first);
    if (read_first != first_payload) {
      return fail("virtual_file_system_local first repository fetch changed");
    }

    std::vector<std::string> urls;
    urls.push_back(path);
    urls.push_back(path);
    std::vector<vic::vfs::virtual_file_system_local::key_t> keys;
    keys.push_back(second_key);
    keys.push_back(missing_key);
    std::vector<vic::vfs::virtual_file_system_local::byte_array_t> results(2);
    reader.multiple_fetch(urls, keys, results);
    if (results[0] != second_payload) {
      return fail("virtual_file_system_local multiple_fetch payload changed");
    }
    if (!results[1].empty()) {
      return fail("virtual_file_system_local missing key returned data");
    }
  }

  std::remove(path.c_str());
  return 0;
}

}  // namespace

int main() {
  if (int status = check_repository_roundtrip()) {
    return status;
  }
  if (int status = check_local_vfs_file_io()) {
    return status;
  }
  if (int status = check_local_vfs_repository_io()) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_core_vfs repository and local VFS"
            << std::endl;
  return 0;
}
