#include <terra/c_api/terra.h>

int main(void) {
  terra_manifest_v1 manifest = {0};
  manifest.struct_size = (uint32_t)sizeof(manifest);
  return terra_abi_version() == TERRA_C_API_VERSION &&
                 terra_sizeof_manifest_v1() == sizeof(manifest)
             ? 0
             : 1;
}
