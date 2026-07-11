#ifndef WMTS_GEOIMAGE_QUAD_FETCHER_HPP
#define WMTS_GEOIMAGE_QUAD_FETCHER_HPP

#include <vic/cbdam/base/geoimage_quad_fetcher.hpp>
#include <vic/geo/base/wmts_global_geodetic_source.hpp>

namespace cbdam {

class wmts_geoimage_quad_fetcher : public geoimage_quad_fetcher {
public:
  typedef geoimage_quad_fetcher super_t;
  typedef super_t::key_t key_t;
  typedef vic::geo::base::wmts_global_geodetic_source source_t;

  wmts_geoimage_quad_fetcher(
      const source_t& source,
      const std::string& desired_srs = "EPSG:4326",
      const aabox2d_t& desired_uv_box =
          aabox2d_t(point2d_t(-180.0, -90.0),
                    point2d_t(180.0, 90.0)),
      const std::size_t& desired_quad_width = 256,
      const std::string& default_about = "");

  virtual ~wmts_geoimage_quad_fetcher();

  const source_t& source() const;

  virtual bool is_out_of_bounds(
      const key_t& key, const aabox2d_t& key_uv_box) const;

protected:
  virtual void handle_data_response(
      const key_t& key, const uint8_t* buffer,
      std::size_t buffer_size);

  virtual void direct_connect();
  virtual void direct_disconnect();
  virtual void direct_send_requests();
  virtual void direct_receive();

  virtual void http_connect();
  virtual void http_disconnect();
  virtual std::string http_url_string(
      const key_t& key, const aabox2d_t& uv_box) const;

private:
  source_t source_;
  bool tile_decoded_;
};

}  // namespace cbdam

#endif
