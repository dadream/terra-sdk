# Terra SDK Consumer Examples

These examples consume an installed Terra SDK package. They do not reach into
the source tree and are used by the release gate after extracting the native
archive.

```bash
cmake -S native_cpp -B build/native_cpp \
  -DTerraSdk_DIR=/path/to/prefix/lib64/cmake/TerraSdk
cmake --build build/native_cpp
./build/native_cpp/terra_sdk_cpp_example
```

Use the same commands with `native_c` for the C ABI example. Although its
source is C99, CMake uses the C++ linker because the distributed static
implementation is written in C++.
