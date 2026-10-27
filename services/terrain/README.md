# Terrain Delivery Service

This directory implements the versioned HTTP adapter for existing CBDAM
terrain repositories.

- `include/terra/service/terrain_service.hpp`: standard-type request, response,
  payload validation, and dataset configuration contract.
- `src/terrain_service.cpp`: read-only `terrain.xml/.root/.data` adapter and v1
  routing logic.
- `src/main.cpp`: small sequential HTTP reference server intended to run behind
  an HTTPS reverse proxy.
- `tests/terrain_service_contract.cpp`: current-reader byte parity, integrity,
  caching, malformed-key, missing-record, and path-safety tests.

The service may depend on legacy VIC storage code. Mini Program and public SDK
headers must not. See `docs/miniprogram/TERRAIN_SERVICE_V1.md` for endpoints,
deployment, and verification.