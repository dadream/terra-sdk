#include <terra/frame/imagery.hpp>
#include <terra/frame/imagery_input.hpp>
#include <terra/frame/surface_projection.hpp>
#include "imagery_memory.hpp"

#include <algorithm>
#include <cmath>
#include <chrono>
#include <limits>
#include <map>
#include <new>
#include <set>
#include <string>
#include <stdexcept>
#include <utility>

#if defined(__EMSCRIPTEN__)
extern "C" double terra_monotonic_milliseconds();
#endif

namespace terra {
namespace frame {
namespace {

template<class T> using memory_vector = std::vector<T, imagery_memory::allocator<T>>;
template<class T> using memory_set = std::set<T, std::less<T>, imagery_memory::allocator<T>>;
template<class K, class V> using memory_map = std::map<K, V, std::less<K>,
    imagery_memory::allocator<std::pair<const K, V>>>;
using memory_string = std::basic_string<char, std::char_traits<char>, imagery_memory::allocator<char>>;

memory_string tile_key(const imagery::node_key& tile) {
  return memory_string(std::to_string(tile.level).c_str()) +
      "/" + std::to_string(tile.row).c_str() + "/" + std::to_string(tile.column).c_str();
}

core::bounds2d cell_bounds(const imagery::node_key& source,
                          const imagery::node_key& tile) {
  const double scale = std::ldexp(1.0, tile.level - source.level);
  const double u = static_cast<double>(tile.column) / scale - source.column;
  const double v = static_cast<double>(tile.row) / scale - source.row;
  return core::bounds2d(core::vector2d{{u, v}},
                        core::vector2d{{u + 1.0 / scale, v + 1.0 / scale}});
}

bool intersects(const core::bounds2d& left, const core::bounds2d& right) {
  return left.minimum[0] < right.maximum[0] &&
      left.maximum[0] > right.minimum[0] &&
      left.minimum[1] < right.maximum[1] &&
      left.maximum[1] > right.minimum[1];
}

bool outside_hull_edge(const std::vector<core::vector2d>& hull,
                       const core::bounds2d& cell, std::size_t i) {
  const auto& a = hull[i];
  const auto& b = hull[(i + 1U) % hull.size()];
  const double dx = b[0] - a[0], dy = b[1] - a[1];
  const double u = dy > 0.0 ? cell.minimum[0] : cell.maximum[0];
  const double v = dx > 0.0 ? cell.maximum[1] : cell.minimum[1];
  return dx * (v - a[1]) - dy * (u - a[0]) <= 0.0;
}

double milliseconds() {
#if defined(__EMSCRIPTEN__)
  return terra_monotonic_milliseconds();
#else
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}

}  // namespace

bool valid_measurement_region(const measurement_region& row) {
  if(row.flags>7U)return false;
  const auto& r=row.value;
  if(std::isnan(r.pixels_per_uv)||r.pixels_per_uv<0.0)return false;
  for(unsigned i=0U;i<2U;++i)if(!std::isfinite(r.uv.minimum[i])||!std::isfinite(r.uv.maximum[i])||r.uv.minimum[i]>r.uv.maximum[i])return false;
  if(row.flags&1U)for(double v:r.projection)if(!std::isfinite(v))return false;
  if(row.flags&2U)for(const auto& p:r.triangle)for(double v:p)if(!std::isfinite(v))return false;
  if((row.flags&1U)&&!(row.flags&2U)&&(!(row.flags&4U)||!(r.numerator_bound>=0.0)))return false;
  return !(row.flags&4U)||(std::isfinite(r.numerator_bound)&&r.numerator_bound>=-1.0);
}
double imagery_region_error(const measurement_region& row, const core::bounds2d& cell) {
  const auto& region=row.value;
  const auto& c = region.projection;
  if (!(row.flags&1U)) return region.pixels_per_uv;
  if ((row.flags&4U) && region.numerator_bound >= 0.0) {
    double minimum_w = c[6];
    for (int axis = 0; axis < 2; ++axis) {
      const double lo = std::max(cell.minimum[axis], region.uv.minimum[axis]);
      const double hi = std::min(cell.maximum[axis], region.uv.maximum[axis]);
      if (lo >= hi) return 0.0;
      minimum_w += std::min(c[7 + axis] * lo, c[7 + axis] * hi);
    }
    return std::min(region.pixels_per_uv, minimum_w > 0.0 ?
        region.numerator_bound / (minimum_w * minimum_w) : std::numeric_limits<double>::infinity());
  }
  // A triangle clipped by four UV half-planes has at most seven vertices.
  std::array<core::vector2d, 12> points{}, scratch{};
  std::copy(region.triangle.begin(), region.triangle.end(), points.begin());
  std::size_t count = 3;
  for (int edge = 0; edge < 4 && count; ++edge) {
    const int axis = edge / 2;
    const double bound = edge % 2 ? cell.maximum[axis] : cell.minimum[axis];
    const double sign = edge % 2 ? -1.0 : 1.0;
    std::size_t next = 0;
    for (std::size_t i = 0; i < count; ++i) {
      const auto& a = points[i]; const auto& b = points[(i + 1) % count];
      const double da = sign * (a[axis] - bound), db = sign * (b[axis] - bound);
      if (da >= 0.0) scratch[next++] = a;
      if ((da < 0.0) != (db < 0.0)) {
        const double t = da / (da - db);
        scratch[next++] = {{a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])}};
      }
    }
    count = next; points.swap(scratch);
  }
  double minimum_w = std::numeric_limits<double>::infinity(), maximum = 0.0;
  std::array<double, 12> depths{}, norms{};
  for (std::size_t i = 0; i < count; ++i) {
    const double u = points[i][0], v = points[i][1];
    const double x = c[0] + c[1] * u + c[2] * v;
    const double y = c[3] + c[4] * u + c[5] * v;
    const double w = c[6] + c[7] * u + c[8] * v;
    minimum_w = std::min(minimum_w, w);
    const double a = c[1] * w - x * c[7], b = c[2] * w - x * c[8];
    const double d = c[4] * w - y * c[7], e = c[5] * w - y * c[8];
    const double aa = a*a + d*d, bb = b*b + e*e, ab = a*b + d*e;
    depths[i] = w;
    norms[i] = std::sqrt(std::max(0.0, 0.5 * (aa + bb + std::hypot(aa - bb, 2.0 * ab))));
    if (w > 0.0) maximum = std::max(maximum, norms[i] / (w * w));
  }
  if (count < 3U) return 0.0;
  double area = 0.0;
  for (std::size_t i = 1; i + 1 < count; ++i) {
    area += std::abs((points[i][0] - points[0][0]) * (points[i+1][1] - points[0][1]) -
                     (points[i][1] - points[0][1]) * (points[i+1][0] - points[0][0]));
  }
  if (area == 0.0) return 0.0;
  if (!(minimum_w > 0.0)) return std::numeric_limits<double>::infinity();
  // At fixed W the convex envelope of ||N|| uses at most two polygon
  // vertices. Its rational maximum can occur inside their segment.
  for (std::size_t i = 0; i < count; ++i) for (std::size_t j = i + 1; j < count; ++j) {
    const double dw = depths[j] - depths[i], dn = norms[j] - norms[i];
    if (dw == 0.0 || dn / dw <= 0.0) continue;
    const double critical = 2.0 * (depths[i] - norms[i] * dw / dn);
    if (critical > std::min(depths[i], depths[j]) && critical < std::max(depths[i], depths[j])) {
      const double t = (critical - depths[i]) / dw;
      maximum = std::max(maximum, (norms[i] + t * dn) / (critical * critical));
    }
  }
  return maximum;
}

// Only the owning controller can normalize an input, in bounded slices. Public
// handles expose no writable storage. Once normalized, all successor cuts share
// the same numeric data and its root bound; membership/order are separate.
class imagery_surface_input {
 public:
  std::shared_ptr<imagery_memory::account> owner = imagery_memory::current_account();
  imagery_memory::charge payload{0U, false, true};
  mutable imagery_surface data;
  std::uint64_t identity = 0U;
  mutable std::size_t normalized = 0U;
  mutable double root_error = 0.0;
  explicit imagery_surface_input(imagery_surface value) : data(std::move(value)) {
    identity = owner->next_input_id++;
    payload.resize(data.regions.capacity() * sizeof(measurement_region) +
      data.hull.capacity() * sizeof(core::vector2d));
  }
  static constexpr std::size_t allocation_envelope() {
    return sizeof(imagery_surface_input) + sizeof(imagery_memory::allocator<imagery_surface_input>) +
      2U * sizeof(std::shared_ptr<void>);
  }
};

static double normalized_region_error(const measurement_region& row,const core::bounds2d& cell) {
  for(unsigned axis=0U;axis<2U;++axis)if(cell.minimum[axis]>row.value.uv.minimum[axis]||
      cell.maximum[axis]<row.value.uv.maximum[axis])return imagery_region_error(row,cell);
  return row.value.pixels_per_uv;
}
static bool normalize_input_region(const imagery_surface_input& input,const core::bounds2d& root_cell) {
  auto& row=input.data.regions[input.normalized];
  if(!valid_measurement_region(row))return false;
  row.value.pixels_per_uv=imagery_region_error(row,row.value.uv);
  input.root_error=std::max(input.root_error,std::ldexp(normalized_region_error(row,root_cell),input.data.source.level));
  ++input.normalized;return true;
}

struct imagery_input_work::state {
  std::shared_ptr<imagery_memory::account> owner=imagery_memory::current_account();
  imagery_memory::charge members_charge{0U,false,true};
  std::vector<imagery_surface> members;
  std::shared_ptr<imagery_surface_input> current;
  std::size_t count=0U,fresh_left=0U,regions_left=0U,hull_left=0U;
  std::size_t current_regions=0U,current_hull=0U,total_regions=0U,total_hull=0U,new_bytes=0U;
  bool failed=false;
  bool surface_complete()const{return !current||
    (current->data.regions.size()==current_regions&&current->data.hull.size()==current_hull);}
};
void imagery_input_work::state_deleter::operator()(state* value)const {
  if(!value)return;
  auto owner=value->owner;value->~state();::operator delete(value);
  owner->release(sizeof(state));owner->inputs-=sizeof(state);
}
imagery_input_work::imagery_input_work()=default;
imagery_input_work::~imagery_input_work()=default;
imagery_input_work::imagery_input_work(imagery_input_work&& other)noexcept
    :state_(std::move(other.state_)),empty_(other.empty_){other.empty_=false;}
imagery_input_work& imagery_input_work::operator=(imagery_input_work&& other)noexcept {
  if(this!=&other){state_=std::move(other.state_);empty_=other.empty_;other.empty_=false;}return *this;
}
std::uint64_t imagery_input_work::work_bytes(std::size_t members,std::size_t fresh,
    std::size_t regions,std::size_t hull) {
  if(members>65536U||fresh>members||regions>1048576U||hull>393216U||(!fresh&&(regions||hull)))
    return std::numeric_limits<std::uint64_t>::max();
  return members?sizeof(state)+imagery_controller::input_work_bytes(members,fresh,regions,hull):0U;
}
bool imagery_input_work::active()const{return empty_||bool(state_);}
bool imagery_input_work::has_member()const{return state_&&!state_->members.empty();}
bool imagery_input_work::failed()const{return state_&&state_->failed;}
bool imagery_input_work::complete()const {
  return empty_||(state_&&!state_->failed&&state_->members.size()==state_->count&&
    !state_->fresh_left&&!state_->regions_left&&!state_->hull_left&&state_->surface_complete());
}
std::size_t imagery_input_work::allocated_bytes()const {
  return state_?sizeof(state)+state_->members.capacity()*sizeof(imagery_surface)+state_->new_bytes:0U;
}
std::size_t imagery_input_work::remaining_regions()const {
  return state_&&state_->current?state_->current_regions-state_->current->data.regions.size():0U;
}
std::size_t imagery_input_work::remaining_hull()const {
  return state_&&state_->current?state_->current_hull-state_->current->data.hull.size():0U;
}
bool imagery_input_work::append_surface(std::uint32_t index,const imagery::node_key& source,
    std::size_t regions,std::size_t hull) {
  if(!state_||state_->failed||!state_->surface_complete()||state_->members.size()>=state_->count||
      !state_->fresh_left||regions>state_->regions_left||hull>state_->hull_left||
      !source.is_valid()||source.level>27||state_->owner->next_input_id==std::numeric_limits<std::uint64_t>::max())return false;
  auto& s=*state_;imagery_memory::scope scope(s.owner);
  imagery_surface description;description.draw_index=index;description.source=source;
  const auto before=s.owner->inputs;
  auto current=std::allocate_shared<imagery_surface_input>(
    imagery_memory::input_allocator<imagery_surface_input,imagery_surface_input::allocation_envelope()>(),std::move(description));
  current->data.regions.reserve(regions);
  current->payload.resize(current->data.regions.capacity()*sizeof(measurement_region));
  current->data.hull.reserve(hull);
  current->payload.resize(current->data.regions.capacity()*sizeof(measurement_region)+
    current->data.hull.capacity()*sizeof(core::vector2d));
  imagery_surface member;member.draw_index=index;member.source=source;member.retained_input=current;
  s.members.push_back(std::move(member));s.current=std::move(current);
  s.new_bytes+=s.owner->inputs-before;s.current_regions=regions;s.current_hull=hull;
  --s.fresh_left;s.regions_left-=regions;s.hull_left-=hull;return true;
}
bool imagery_input_work::append_retained(std::shared_ptr<const imagery_surface_input> input,std::uint32_t index) {
  if(!state_||state_->failed||!input||input->owner!=state_->owner||!state_->surface_complete()||
      state_->members.size()+state_->fresh_left>=state_->count||
      input->data.regions.size()>1048576U-state_->total_regions||input->data.hull.size()>393216U-state_->total_hull)return false;
  imagery_surface member;member.draw_index=index;member.source=input->data.source;member.retained_input=std::move(input);
  state_->total_regions+=member.retained_input->data.regions.size();state_->total_hull+=member.retained_input->data.hull.size();
  state_->members.push_back(std::move(member));state_->current.reset();state_->current_regions=state_->current_hull=0U;return true;
}
bool imagery_input_work::append_region(const measurement_region& region) {
  if(!state_||state_->failed||!remaining_regions())return false;
  if(!valid_measurement_region(region)){state_->failed=true;return false;}
  state_->current->data.regions.push_back(region);return true;
}
bool imagery_input_work::append_hull(const core::vector2d& point) {
  if(!state_||state_->failed||!remaining_hull())return false;
  if(!std::isfinite(point[0])||!std::isfinite(point[1])){state_->failed=true;return false;}
  state_->current->data.hull.push_back(point);return true;
}
bool imagery_input_work::append_regions(const surface_projection_work& source,std::size_t first,std::size_t count) {
  if(!state_||state_->failed||!state_->current||count>256U||count>remaining_regions()||
      (count&&first>std::numeric_limits<std::size_t>::max()-(count-1U)))return false;
  measurement_region row;std::size_t copied=0U;
  if(!source.read(count?first+count-1U:first,&row,count?1U:0U,copied)||copied!=(count?1U:0U))return false;
  for(std::size_t i=0U;i<count;++i) {
    if(!source.read(first+i,&row,1U,copied)||copied!=1U||!append_region(row))return false;
  }
  return true;
}
bool imagery_input_work::append_hull(const surface_layout& source,std::size_t first,std::size_t count) {
  if(!source||!state_||state_->failed||!state_->current||count>256U||count>remaining_hull()||
      first>source.hull_count()||count>source.hull_count()-first)return false;
  for(std::size_t i=0U;i<count;++i)if(!append_hull(source.hull()[first+i]))return false;
  return true;
}
void imagery_input_work::invalidate(){if(state_)state_->failed=true;}
void imagery_input_work::cancel(){state_.reset();empty_=false;}

bool imagery_input_work::normalize_surface(std::size_t maximum,std::size_t& normalized) {
  normalized=0U;
  if(!complete()||!state_||state_->members.size()!=1U||!state_->current||maximum>256U)return false;
  auto& input=*state_->current;auto& surface=input.data;
  const int divisor=1<<surface.source.level;
  const imagery::node_key root(0,surface.source.row/divisor,surface.source.column/divisor);
  const auto cell=cell_bounds(surface.source,root);
  while(input.normalized<surface.regions.size()&&normalized<maximum) {
    if(!normalize_input_region(input,cell)){state_->failed=true;return false;}
    ++normalized;
  }
  return true;
}
std::shared_ptr<const imagery_surface_input> imagery_input_work::take_surface() {
  if(!complete()||!state_||state_->members.size()!=1U||!state_->current||
      state_->current->normalized!=state_->current->data.regions.size())return {};
  auto result=std::move(state_->current);
  cancel();return result;
}

struct imagery_controller::implementation {
  imagery_memory::charge structure_charge{sizeof(implementation)};
  imagery_memory::charge input_charge{0U, false, true};
  const imagery_surface& input(std::size_t index) const { return surfaces[index].retained_input->data; }
  struct reference {
    std::size_t surface = 0U;
    std::uint64_t input_identity = 0U;
    // Cell error before division by tile_size. It belongs to an immutable
    // measurement, not a draw position or a particular capacity decision.
    double error = 0.0;
    // Roots cover the whole immutable input range. Only filtered child
    // references need an explicit list of region indices.
    std::size_t full_range = 0U;
    std::vector<std::size_t, imagery_memory::allocator<std::size_t, true>> regions;
    // Non-owning scratch links for one child's retained-input lookup. A moved
    // reference clears the link; region payload ownership never follows it.
    reference* next_cached = nullptr;
    std::size_t size() const { return full_range ? full_range : regions.size(); }
    std::size_t at(std::size_t index) const { return full_range ? index : regions[index]; }
  };
  struct root_input {
    imagery::node_key tile;
    memory_vector<reference> refs;
    double error = 0.0;
  };
  struct node {
    imagery::node_key tile;
    memory_vector<reference> refs;
    double error = 0.0;
    memory_string resource;
    std::uint64_t revision = 0U;
    std::uint64_t children_revision = 0U;
    memory_vector<node*> children;
    node* parent = nullptr;
    bool split = false;
  };
  struct input_binding {
    std::uint64_t lookup_revision = 0U;
    reference* cached = nullptr;
  };
  using input_binding_value = std::pair<const std::uint64_t, input_binding>;
  // Fund one registry node per member before begin(). The allocator checks
  // the actual standard-library node against this envelope at compile time.
  static constexpr std::size_t input_binding_envelope = sizeof(input_binding_value) + 8U * sizeof(void*);
  using input_bindings = std::map<std::uint64_t, input_binding, std::less<std::uint64_t>,
      imagery_memory::input_allocator<input_binding_value, input_binding_envelope>>;
  struct child_measurement {
    node* parent = nullptr;
    unsigned child = 0U;
    std::size_t source = 0U, region = 0U, edge = 0U;
    bool source_started = false;
    node* cached = nullptr;
    std::size_t cached_reference = 0U;
    bool child_started = false;
    std::uint64_t lookup_revision = 0U;
    bool cache_checked = false;
    core::bounds2d cell;
    double divisor = 1.0, error = 0.0;
    reference ref;
    memory_vector<reference> refs;
    memory_vector<node*> completed;
  };
  using priority_queue = memory_set<std::pair<double, memory_string>>;
  struct exchange_plan {
    node* target = nullptr;
    memory_vector<node*> children;
    memory_vector<node*> donors;
    priority_queue::const_iterator next;
    priority_queue parents;
    memory_set<node*> added, removed;
    memory_map<memory_string, std::int64_t> resource_delta;
    std::size_t resources = 0U, draws = 0U, committed = 0U;
    bool admitted = false;
  };
  memory_map<memory_string, node> nodes;
  memory_map<memory_string, node>::iterator retiring_references;
  std::size_t retiring_reference = 0U;
  memory_map<memory_string, node>::iterator reclaiming_node;
  std::size_t reclaiming_reference = 0U;
  bool reclaiming = false;
  memory_set<memory_string> previous_splits;
  std::uint64_t revision = 0U;
  std::vector<imagery_surface> surfaces;
  input_bindings inputs_by_identity;
  std::uint64_t lookup_revision = 0U;
  imagery_budget budget;
  imagery_cut quality;
  memory_map<memory_string, node*> leaves;
  memory_map<memory_string, std::size_t> resources;
  bool binding_failed = false;
  // Nodes remain alive across camera revisions; queue priorities belong to one
  // measurement revision and survive all bounded continuation steps.
  priority_queue refining;
  priority_queue restoring;
  priority_queue coarsening;
  std::shared_ptr<exchange_plan> exchange;
  std::shared_ptr<child_measurement> child_work;
  std::size_t reference_allowance = 0U, reference_needed = 0U;
  std::size_t output_allowance = 0U, output_needed = 0U;
  memory_set<memory_string> splits;
  std::size_t draws = 0U;
  std::size_t minimum_draws = 0U;
  bool valid = false;
  bool measuring_cut = false;
  memory_vector<node*> roots;
  std::size_t root_resource_count = 0U;
  memory_vector<node*> measuring;
  memory_map<memory_string, node*> measured_leaves;
  memory_set<memory_string> measured_splits;
  std::size_t measured_draws = 0U;
  memory_map<memory_string, root_input> initializing_roots;
  memory_set<memory_string> initializing_resources;
  bool initializing = false;
  root_input* initializing_input = nullptr;
  std::size_t initializing_surface = 0U;
  std::size_t initializing_region = 0U;
  std::uint64_t admission_revision = 0U;
  memory_map<memory_string, double> partition_blocked;
  memory_string prune_position;
  enum class output_kind { none, empty, roots, leaves };
  output_kind output_type = output_kind::none;
  std::uint64_t leaf_revision = 0U, output_leaf_revision = 0U;
  std::shared_ptr<const std::vector<imagery_draw>> output;
  double output_error = 0.0;
  std::size_t output_textures = 0U;
  bool output_level_limited = false;

  struct draw_snapshot {
    imagery_memory::charge payload{0U, true};
    std::vector<imagery_draw> values;
  };

  template<class Visitor> void visit_output(output_kind kind, Visitor visit) const {
    if (kind == output_kind::roots) for (const auto* value : roots) visit(*value);
    else if (kind == output_kind::leaves) for (const auto& leaf : leaves) visit(*leaf.second);
  }

  bool read_output(imagery_cut& result, output_kind kind) {
    if (output_type != kind || (kind == output_kind::leaves && output_leaf_revision != leaf_revision)) {
      std::size_t count = 0U;
      visit_output(kind, [&](const node& value) { count += value.refs.size(); });
      const auto bytes = count * sizeof(imagery_draw);
      if (bytes > output_allowance) {
        output_needed = bytes;
        result.draws = output;
        result.output_pending = true;
        result.decisions_complete = false;
        return false;
      }
      auto snapshot = std::allocate_shared<draw_snapshot>(imagery_memory::allocator<draw_snapshot>());
      auto* next = &snapshot->values;
      next->reserve(count);
      snapshot->payload.resize(next->capacity() * sizeof(imagery_draw));
      output_allowance -= bytes;
      double error = 0.0;
      bool level_limited = false;
      visit_output(kind, [&](const node& value) {
        error = std::max(error, value.error);
        level_limited = level_limited || (value.error > budget.requested_pixel_error &&
          std::isfinite(value.error) && value.tile.level >= static_cast<int>(budget.maximum_level));
        for (const auto& ref : value.refs) {
          imagery_draw draw;
          draw.draw_index = surfaces[ref.surface].draw_index;
          draw.tile = value.tile;
          draw.pixel_error = value.error;
          next->push_back(draw);
        }
      });
      // Commit identity and summaries together, only after allocation succeeds.
      output = std::shared_ptr<const std::vector<imagery_draw>>(snapshot, next);
      output_error = error;
      output_textures = kind == output_kind::roots ? root_resource_count : kind == output_kind::leaves ? resources.size() : 0U;
      output_level_limited = level_limited;
      output_type = kind; output_leaf_revision = leaf_revision;
    }
    result.draws = output;
    result.maximum_pixel_error = output_error;
    result.selected_texture_count = output_textures;
    result.limited_by_level = output_level_limited;
    return true;
  }

  // The owned measurement snapshot stores the error over each complete region.
  // Ancestors containing that region need no repeated projective clipping.
  static double region_error(const measurement_region& row, const core::bounds2d& cell) {
    return normalized_region_error(row,cell);
  }

  void add_leaf(node& value) {
    ++leaf_revision;
    leaves[tile_key(value.tile)] = &value;
    ++resources[value.resource];
    draws += value.refs.size();
  }

  void remove_leaf(node& value) {
    ++leaf_revision;
    leaves.erase(tile_key(value.tile));
    const auto found = resources.find(value.resource);
    if (found != resources.end() && --found->second == 0U) resources.erase(found);
    draws -= value.refs.size();
  }

  std::size_t split_resource_count(const node& value, const memory_vector<node*>& children) const {
    const auto found = resources.find(value.resource);
    const bool released = found != resources.end() && found->second == 1U;
    std::size_t count = resources.size() - (released ? 1U : 0U);
    memory_set<memory_string> added;
    for (const auto* child : children) {
      if ((!resources.count(child->resource) || (released && child->resource == value.resource)) &&
          added.insert(child->resource).second) ++count;
    }
    return count;
  }

  void enqueue(node& value, bool restore = true) {
    const auto key = tile_key(value.tile);
    // Admission receipts may wake an existing leaf while an exchange spans
    // slices. A leaf must never remain in both scheduling queues.
    refining.erase({-value.error, key});
    restoring.erase({-value.error, key});
    const bool retained = previous_splits.count(key) != 0U;
    // History may order required work, but cannot request optional finer
    // imagery after a parent already meets the current target. Display
    // retention and transitions are owned by presentation, not this cut.
    if (value.error <= budget.requested_pixel_error) return;
    if (value.tile.level >= static_cast<int>(budget.maximum_level)) return;
    const auto blocked = partition_blocked.find(key);
    if (blocked != partition_blocked.end() && value.error <= blocked->second * 1.1) return;
    if (retained && restore) restoring.emplace(-value.error, key);
    else if (std::isfinite(value.error)) refining.emplace(-value.error, key);
  }

  void refresh_coarsening(node* value) {
    if (!value) return;
    const auto key = tile_key(value->tile);
    coarsening.erase({value->error, key});
    if (value->children_revision != revision || value->children.empty() || !std::isfinite(value->error)) return;
    for (const auto* child : value->children) {
      if (leaves.count(tile_key(child->tile)) == 0U) return;
    }
    coarsening.emplace(value->error, key);
  }

  node& measure(const imagery::node_key& tile, memory_vector<reference> refs,
                double measured_error) {
    const auto key = tile_key(tile);
    node& result = nodes[key];
    result.tile = tile;
    result.split = splits.count(key) != 0U;
    result.refs = std::move(refs);
    result.error = measured_error;
    result.revision = revision;
    result.children_revision = 0U;
    if (budget.resource_key) {
      const auto resource = budget.resource_key(tile, result.error);
      result.resource.assign(resource.data(), resource.size());
    } else result.resource = key;
    binding_failed = binding_failed || result.resource.empty();
    return result;
  }

  imagery_reclaim_progress reclaim_references(std::size_t needed, std::size_t visits, bool restart) {
    imagery_reclaim_progress result;
    if (!needed) return result;
    if (restart || !reclaiming) {
      reclaiming_node = nodes.begin(); reclaiming_reference = 0U; reclaiming = true;
    }
    while (reclaiming_node != nodes.end() && result.visited < visits && result.released_bytes < needed) {
      ++result.visited;
      auto& value = reclaiming_node->second;
      // Unmeasured children still depend on these indices, even when another
      // parent currently owns the child cursor. Evicting that frontier makes
      // memory pressure repeatedly reconstruct its own pending work. Expanded
      // parents reuse their children; terminal leaves cannot be enqueued under
      // this revision's fixed error/level budget.
      const bool frontier = value.revision == revision && value.children_revision != revision &&
          value.tile.level < static_cast<int>(budget.maximum_level) &&
          value.error > budget.requested_pixel_error;
      if (frontier || (child_work && child_work->parent == &value) || reclaiming_reference == value.refs.size()) {
        ++reclaiming_node; reclaiming_reference = 0U;
        continue;
      }
      auto& ref = value.refs[reclaiming_reference++];
      if (!ref.regions.capacity()) continue;
      result.released_bytes += ref.regions.capacity() * sizeof(std::size_t);
      decltype(ref.regions) empty;
      ref.regions.swap(empty);
    }
    result.pending = reclaiming_node != nodes.end();
    return result;
  }

  // One priority credit visits at most 64 hull edges, region references or
  // bookkeeping boundaries. A dense near-horizon parent cannot monopolize a
  // continuation. The published cut keeps its parent until all four children
  // have complete measurements and their common capacity check succeeds.
  bool children_ready(node& parent) {
    if (parent.children_revision == revision) return true;
    if (parent.tile.column > (std::numeric_limits<int>::max() - 1) / 2 ||
        parent.tile.row > (std::numeric_limits<int>::max() - 1) / 2) {
      parent.children.clear(); parent.children_revision = revision;
      return true;
    }
    if (!child_work) {
      child_work = std::allocate_shared<child_measurement>(imagery_memory::allocator<child_measurement>());
      child_work->parent = &parent;
    }
    auto& work = *child_work;
    for (std::size_t remaining = 64U; remaining; --remaining) {
      const imagery::node_key tile(parent.tile.level + 1,
          parent.tile.row * 2 + static_cast<int>(work.child / 2U),
          parent.tile.column * 2 + static_cast<int>(work.child % 2U));
      if (!work.child_started) {
        const auto found = nodes.find(tile_key(tile));
        work.cached = found == nodes.end() || found->second.revision == revision ? nullptr : &found->second;
        work.cached_reference = 0U;
        work.lookup_revision = ++lookup_revision;
        work.child_started = true;
        continue;
      }
      if (work.cached && work.cached_reference < work.cached->refs.size()) {
        auto& cached = work.cached->refs[work.cached_reference++];
        const auto found = inputs_by_identity.find(cached.input_identity);
        if (found == inputs_by_identity.end() || !cached.size()) continue;
        auto& binding = found->second;
        cached.next_cached = binding.lookup_revision == work.lookup_revision ? binding.cached : nullptr;
        binding.lookup_revision = work.lookup_revision;
        binding.cached = &cached;
        continue;
      }
      if (work.source == parent.refs.size()) {
        if (!work.refs.empty()) {
          node& child = measure(tile, std::move(work.refs), work.error);
          child.parent = &parent; work.completed.push_back(&child);
        }
        work.refs.clear(); work.source = 0U; work.error = 0.0;
        work.child_started = false;
        if (++work.child == 4U) {
          parent.children = std::move(work.completed);
          parent.children_revision = revision;
          child_work.reset();
          return true;
        }
        continue;
      }
      const auto& source_ref = parent.refs[work.source];
      const auto& surface = input(source_ref.surface);
      if (!work.source_started) {
        work.ref = reference(); work.ref.surface = source_ref.surface;
        work.ref.input_identity = source_ref.input_identity;
        work.region = work.edge = 0U;
        work.cell = cell_bounds(surface.source, tile);
        work.divisor = std::ldexp(1.0, tile.level - surface.source.level);
        work.cache_checked = !work.cached;
        work.source_started = true;
      } else if (!work.cache_checked) {
        // Build each child's lookup once, not once per overlapping surface.
        // Generation tags reject pointers from an earlier child/cancelled cut.
        // Duplicate members consume distinct cached payloads from the chain.
        auto& binding = inputs_by_identity.at(source_ref.input_identity);
        auto* found = binding.lookup_revision == work.lookup_revision ? binding.cached : nullptr;
        if (!found) { work.cache_checked = true; continue; }
        auto& cached = *found;
        binding.cached = cached.next_cached;
        // Pressure may have reclaimed its region array since indexing. Such
        // an entry is a cache miss, never proof of an empty current footprint.
        if (!cached.size()) continue;
        work.error = std::max(work.error, cached.error / budget.tile_size);
        work.refs.push_back(std::move(cached));
        work.refs.back().surface = source_ref.surface;
        work.refs.back().next_cached = nullptr;
        cached = reference();
        ++work.source; work.source_started = false;
      } else if (surface.hull.size() >= 3U && work.edge < surface.hull.size()) {
        if (outside_hull_edge(surface.hull, work.cell, work.edge++)) {
          ++work.source; work.source_started = false;
        }
      } else if (work.region < source_ref.size()) {
        const auto index = source_ref.at(work.region);
        const auto& region = surface.regions[index];
        if (!intersects(region.value.uv, work.cell)) { ++work.region; continue; }
        const double measured = region_error(region, work.cell);
        if (measured > 0.0) {
          if (work.ref.regions.size() == work.ref.regions.capacity()) {
            const auto capacity = std::min(source_ref.size(),
                std::max<std::size_t>(64U, 2U * work.ref.regions.capacity()));
            const auto bytes = capacity * sizeof(std::size_t);
            // reserve holds both buffers until the move completes. Fund the
            // whole new capacity, not only its net growth. Keep the cursor at
            // this region on refusal; no half-written reference is published.
            if (bytes > reference_allowance) { reference_needed = bytes; return false; }
            reference_allowance -= bytes;
            work.ref.regions.reserve(capacity);
          }
          work.ref.regions.push_back(index);
          work.ref.error = std::max(work.ref.error, measured / work.divisor);
          work.error = std::max(work.error, work.ref.error / budget.tile_size);
        }
        ++work.region;
      } else {
        if (!work.ref.regions.empty()) work.refs.push_back(std::move(work.ref));
        ++work.source; work.source_started = false;
      }
    }
    return false;
  }

  bool begin(std::vector<imagery_surface> input,
             const imagery_budget& limits,imagery_memory::charge* member_charge=nullptr) {
    // Validate all retained handles before moving any payload or changing the
    // published controller. A draw position is never an input identity.
    for (const auto& surface : input) if (surface.retained_input &&
        (surface.retained_input->owner != imagery_memory::current_account() ||
         !surface.regions.empty() || !surface.hull.empty())) return false;
    const auto new_inputs = std::count_if(input.begin(), input.end(),
      [](const imagery_surface& surface) { return !surface.retained_input; });
    if (static_cast<std::uint64_t>(new_inputs) > std::numeric_limits<std::uint64_t>::max() -
        imagery_memory::current_account()->next_input_id) return false;
    for (auto& surface : input) {
      if (!surface.retained_input) {
        const auto index = surface.draw_index;
        auto owned = std::allocate_shared<imagery_surface_input>(
          imagery_memory::input_allocator<imagery_surface_input, imagery_surface_input::allocation_envelope()>(),
          std::move(surface));
        surface = imagery_surface(); surface.draw_index = index;
        surface.retained_input = std::move(owned);
      }
      surface.source = surface.retained_input->data.source;
    }
    reclaiming = false;
    exchange.reset();
    child_work.reset();
    reference_needed = 0U;
    output_needed = 0U;
    valid = false;
    binding_failed = false;
    output_type = output_kind::none;
    output.reset();
    const auto& surfaces = this->surfaces;
    const auto& budget = limits;
    imagery_cut result;
    if (!std::isfinite(budget.requested_pixel_error) || budget.requested_pixel_error <= 0.0 ||
        budget.tile_size == 0U || budget.maximum_level > 27U ||
        budget.maximum_texture_count == 0U || budget.maximum_draw_count == 0U) return false;
    result.requested_pixel_error = budget.requested_pixel_error;
    result.feasible_pixel_error = budget.requested_pixel_error;
    ++revision;
    valid = false;
    refining.clear(); restoring.clear(); coarsening.clear();
    measuring_cut = true;
    roots.clear(); root_resource_count = 0U;
    measuring.clear(); measured_leaves.clear(); measured_splits.clear(); measured_draws = 0U;
    initializing_roots.clear(); initializing_resources.clear();
    initializing = false; initializing_input = nullptr;
    initializing_surface = initializing_region = 0U;
    minimum_draws = 0U;
    this->surfaces = std::move(input);
    if(member_charge)input_charge=std::move(*member_charge);
    else input_charge.resize(this->surfaces.capacity() * sizeof(imagery_surface));
    // A user resource callback may allocate/throw when copied. The transferred
    // member array must already carry its own charge on that failure path.
    this->budget = limits;
    inputs_by_identity.clear(); lookup_revision = 0U;
    for (const auto& surface : surfaces) {
      if (!surface.source.is_valid() || surface.source.level > 27) return false;
      if (!surface.retained_input->data.regions.empty()) ++minimum_draws;
      inputs_by_identity.emplace(surface.retained_input->identity, input_binding());
    }
    if (minimum_draws > budget.maximum_draw_count) return false;
    retiring_references = nodes.begin();
    retiring_reference = 0U;
    initializing = !surfaces.empty();
    quality = result;
    valid = true;
    return true;
  }

  // Grouping, validation, normalization and root binding all belong to the
  // bounded work loop. One credit handles at most 64 regions or boundaries,
  // including empty surfaces. Roots reference their implicit full input range.
  // No partial root set is published while this input snapshot is incomplete.
  void initialize_regions() {
    for (std::size_t remaining = 64U; remaining; --remaining) {
      if (initializing_surface == surfaces.size()) {
        if (initializing_roots.empty()) {
          initializing = false;
          valid = !binding_failed && initializing_resources.size() <= budget.maximum_texture_count;
          root_resource_count = initializing_resources.size();
          initializing_resources.clear();
          return;
        }
        auto it = initializing_roots.begin();
        auto& root = it->second;
        node& value = measure(root.tile, std::move(root.refs), root.error);
        value.parent = nullptr;
        roots.push_back(&value); measuring.push_back(&value);
        initializing_resources.insert(value.resource);
        initializing_roots.erase(it);
        continue;
      }
      const auto& owned = *surfaces[initializing_surface].retained_input;
      auto& surface = owned.data;
      if (!initializing_input) {
        if (surface.regions.empty()) { ++initializing_surface; continue; }
        const int divisor = 1 << surface.source.level;
        const imagery::node_key root(0,
            surface.source.row / divisor, surface.source.column / divisor);
        auto& entry = initializing_roots[tile_key(root)];
        entry.tile = root;
        reference ref;
        ref.surface = initializing_surface; ref.full_range = surface.regions.size();
        ref.input_identity = owned.identity;
        entry.refs.push_back(std::move(ref));
        if (owned.normalized == surface.regions.size()) {
          entry.error = std::max(entry.error, owned.root_error / budget.tile_size);
          ++initializing_surface;
          continue;
        }
        initializing_region = owned.normalized;
        initializing_input = &entry;
        continue;
      }
      auto& root = *initializing_input;
      const auto cell = cell_bounds(surface.source, root.tile);
      if (!normalize_input_region(owned,cell)) {
        valid = initializing = false;
        return;
      }
      root.error = std::max(root.error, owned.root_error / budget.tile_size);
      if (++initializing_region == surface.regions.size()) {
        initializing_region = 0U;
        initializing_input = nullptr;
        ++initializing_surface;
      }
    }
  }

  void discard_children_under(const node& ancestor) {
    if (!child_work) return;
    for (const node* value = child_work->parent; value; value = value->parent) {
      if (value == &ancestor) { child_work.reset(); return; }
    }
  }

  void collapse(node& value) {
    discard_children_under(value);
    const auto key = tile_key(value.tile);
    for (auto* child : value.children) {
      const auto child_key = tile_key(child->tile);
      remove_leaf(*child);
      refining.erase({-child->error, child_key});
      restoring.erase({-child->error, child_key});
    }
    add_leaf(value);
    value.split = false;
    splits.erase(key);
    enqueue(value, false);
    refresh_coarsening(value.parent);
  }

  void split(node& value, const memory_vector<node*>& children_of_node) {
    remove_leaf(value);
    value.split = true;
    for (node* child : children_of_node) {
      add_leaf(*child);
      enqueue(*child);
    }
    splits.insert(tile_key(value.tile));
    refresh_coarsening(&value);
    refresh_coarsening(value.parent);
  }

  bool eligible_donor(const node& donor, const node& target) const {
    return (target.error > budget.requested_pixel_error &&
              donor.error <= budget.requested_pixel_error) || donor.error < target.error * 0.8;
  }

  void exchange_resource(const memory_string& resource, int delta) {
    auto& plan = *exchange;
    const auto existing = resources.find(resource);
    auto& change = plan.resource_delta[resource];
    const auto before = static_cast<std::int64_t>(existing == resources.end() ? 0U : existing->second) + change;
    if (before == 0) ++plan.resources;
    change += delta;
    if (before + delta == 0) --plan.resources;
  }

  bool exchange_leaf(node* value) const {
    return exchange->added.count(value) ||
      (!exchange->removed.count(value) && leaves.count(tile_key(value->tile)));
  }

  bool exchange_parent(node* value) const {
    return value && value->children_revision == revision && !value->children.empty() &&
      std::isfinite(value->error) && std::all_of(value->children.begin(), value->children.end(),
        [&](node* child) { return exchange_leaf(child); });
  }

  void begin_exchange(node& target, const memory_vector<node*>& children_of_node,
                      std::size_t next_draws) {
    // Every surface outside the target still needs at least one draw, even
    // after all possible donations. Reject impossible requests without churn.
    const auto children_draws = next_draws - (draws - target.refs.size());
    if (children_draws + minimum_draws - target.refs.size() > budget.maximum_draw_count ||
        coarsening.empty() || !std::isfinite(target.error) ||
        !eligible_donor(nodes.at(coarsening.begin()->second), target)) return;
    exchange = std::allocate_shared<exchange_plan>(imagery_memory::allocator<exchange_plan>());
    auto& plan = *exchange;
    plan.target = &target; plan.children = children_of_node;
    plan.next = coarsening.begin(); plan.draws = next_draws; plan.resources = resources.size();
    exchange_resource(target.resource, -1);
    for (const auto* child : children_of_node) exchange_resource(child->resource, 1);
  }

  // Price one potential donation per priority step. The actual cut and queues
  // stay intact until the complete replacement is feasible. Newly exposed
  // parents join the same error order without copying the complete tree.
  void price_exchange() {
    auto& plan = *exchange;
    if (plan.next == coarsening.end() && plan.parents.empty()) { exchange.reset(); return; }
    const bool nested = !plan.parents.empty() &&
      (plan.next == coarsening.end() || *plan.parents.begin() < *plan.next);
    const auto item = nested ? *plan.parents.begin() : *plan.next++;
    if (nested) plan.parents.erase(plan.parents.begin());
    node& donor = nodes.at(item.second);
    if (!eligible_donor(donor, *plan.target)) { exchange.reset(); return; }
    // Never donate the target or an ancestor containing it.
    for (const node* parent = plan.target; parent; parent = parent->parent) if (parent == &donor) return;
    if (!exchange_parent(&donor)) return;
    for (node* child : donor.children) {
      plan.removed.insert(child); plan.added.erase(child);
      exchange_resource(child->resource, -1);
      plan.draws -= child->refs.size();
    }
    plan.added.insert(&donor);
    exchange_resource(donor.resource, 1);
    plan.draws += donor.refs.size();
    plan.donors.push_back(&donor);
    plan.admitted = plan.resources <= budget.maximum_texture_count && plan.draws <= budget.maximum_draw_count;
    if (!plan.admitted && exchange_parent(donor.parent))
      plan.parents.emplace(donor.parent->error, tile_key(donor.parent->tile));
  }

  bool accept_cut(const std::vector<imagery::node_key>& tiles, std::uint64_t epoch) {
    if (!tiles.empty()) reclaiming = false;
    if (epoch != admission_revision) {
      admission_revision = epoch;
      partition_blocked.clear();
      if (!measuring_cut) for (const auto& leaf : leaves)
        if (!exchange || leaf.second != exchange->target) enqueue(*leaf.second);
    }
    if (tiles.empty()) return true;
    if (!valid || measuring_cut || exchange) return false;
    for (const auto& tile : tiles) {
      const auto found = nodes.find(tile_key(tile));
      if (found == nodes.end() || found->second.revision != revision) return false;
    }
    for (const auto& tile : tiles) {
      node& value = nodes.at(tile_key(tile));
      if (!value.split) continue;
      // Confirming the unchanged parent must not restart its pending work.
      // Only an actual ancestor collapse invalidates the child measurement.
      discard_children_under(value);
      memory_vector<node*> pending{&value};
      while (!pending.empty()) {
        node& child = *pending.back(); pending.pop_back();
        const auto child_key = tile_key(child.tile);
        const auto leaf = leaves.find(child_key);
        if (leaf != leaves.end()) remove_leaf(child);
        if (child.split && child.children_revision == revision) pending.insert(pending.end(), child.children.begin(), child.children.end());
        child.split = false;
        splits.erase(child_key);
        refining.erase({-child.error, child_key});
        restoring.erase({-child.error, child_key});
        coarsening.erase({child.error, child_key});
      }
      const auto key = tile_key(tile);
      add_leaf(value);
      partition_blocked[key] = value.error;
      refresh_coarsening(value.parent);
    }
    previous_splits = splits;
    return true;
  }

  imagery_cut step(std::size_t maximum_changes, std::size_t maximum_priorities,
                   double maximum_milliseconds, std::size_t maximum_reference_work_bytes,
                   std::size_t maximum_output_work_bytes) {
    reclaiming = false;
    const bool publication_waiting = output_needed != 0U;
    output_allowance = maximum_output_work_bytes;
    output_needed = 0U;
    reference_allowance = maximum_reference_work_bytes;
    // Publishing a funded snapshot does not consume or invalidate a pending
    // index allocation. Its quote must survive this independent receipt.
    if (!publication_waiting) reference_needed = 0U;
    imagery_cut result = quality;
    if (!valid) return imagery_cut();
    const double started = milliseconds();
    std::size_t changes = 0U, priorities = 0U;
    const auto time_left = [&]() { return !publication_waiting && !reference_needed &&
      (maximum_milliseconds <= 0.0 || milliseconds() - started < maximum_milliseconds); };
    while (initializing && priorities < maximum_priorities && time_left()) {
      initialize_regions();
      ++priorities;
    }
    if (!valid) return imagery_cut();
    if (initializing) {
      read_output(result, output_kind::empty);
      result.complete = true;
      result.rebuilding = true;
      result.maximum_pixel_error = result.feasible_pixel_error = std::numeric_limits<double>::infinity();
      result.priority_update_count = priorities;
      result.cached_node_count = nodes.size();
      return result;
    }
    while (!measuring.empty() && priorities < maximum_priorities && time_left()) {
      node& value = *measuring.back();
      ++priorities;
      const auto key = tile_key(value.tile);
      if (value.split && std::isfinite(value.error) &&
          value.error <= budget.requested_pixel_error) {
        // A valid parent bound covers the whole subtree. Retire descendants
        // lazily instead of remeasuring every obsolete fine leaf before merging.
        if (changes >= maximum_changes) break;
        value.split = false;
        ++changes;
      }
      if (value.split && value.tile.level < static_cast<int>(budget.maximum_level)) {
        if (!children_ready(value)) continue;
        const auto& descendants = value.children;
        if (!descendants.empty()) {
          measured_splits.insert(key);
          measuring.pop_back();
          measuring.insert(measuring.end(), descendants.begin(), descendants.end());
          continue;
        }
      }
      measuring.pop_back();
      value.split = false;
      measured_leaves[key] = &value;
      measured_draws += value.refs.size();
    }
    if (measuring_cut && measuring.empty()) {
      measuring_cut = false;
      leaves.swap(measured_leaves);
      ++leaf_revision;
      measured_leaves.clear();
      splits.swap(measured_splits);
      measured_splits.clear();
      draws = measured_draws;
      resources.clear();
      for (const auto& leaf : leaves) ++resources[leaf.second->resource];
      for (const auto& leaf : leaves) {
        enqueue(*leaf.second);
        refresh_coarsening(leaf.second->parent);
      }
    }
    while (!measuring_cut && !exchange && !coarsening.empty() && changes < maximum_changes && time_left()) {
      node& value = nodes.at(coarsening.begin()->second);
      if (resources.size() <= budget.maximum_texture_count && draws <= budget.maximum_draw_count &&
          value.error > budget.requested_pixel_error) break;
      coarsening.erase(coarsening.begin());
      collapse(value);
      ++changes;
    }
    while (!measuring_cut && (exchange || !restoring.empty() || !refining.empty()) && changes < maximum_changes &&
           priorities < maximum_priorities &&
           time_left()) {
      if (exchange) {
        if (!exchange->admitted) { price_exchange(); ++priorities; continue; }
        if (exchange->committed < exchange->donors.size()) {
          node& donor = *exchange->donors[exchange->committed++];
          coarsening.erase({donor.error, tile_key(donor.tile)});
          collapse(donor);
        } else {
          split(*exchange->target, exchange->children);
          exchange.reset();
        }
        ++changes;
        continue;
      }
      // History breaks ties, but an old split must not outrank a newly visible
      // region with greater error in the latest measured view.
      auto& queue = restoring.empty() ? refining : refining.empty() ||
          restoring.begin()->first <= refining.begin()->first ? restoring : refining;
      const auto key = child_work ? tile_key(child_work->parent->tile) : queue.begin()->second;
      ++priorities;
      node& value = *leaves.at(key);
      if (!children_ready(value)) continue;
      refining.erase({-value.error, key}); restoring.erase({-value.error, key});
      const auto& children_of_node = value.children;
      if (children_of_node.empty()) continue;
      std::size_t next_draws = draws - value.refs.size();
      for (const auto* child : children_of_node) next_draws += child->refs.size();
      const bool textures_fit = split_resource_count(value, children_of_node) <= budget.maximum_texture_count;
      const bool draws_fit = next_draws <= budget.maximum_draw_count;
      if (!textures_fit || !draws_fit) {
        begin_exchange(value, children_of_node, next_draws);
        continue;
      }
      split(value, children_of_node);
      ++changes;
    }
    if (binding_failed) return imagery_cut();
    const bool rebuilding = measuring_cut || exchange || resources.size() > budget.maximum_texture_count || draws > budget.maximum_draw_count;
    result.rebuilding = rebuilding;
    result.decisions_complete = !rebuilding && restoring.empty() && refining.empty();
    result.change_count = changes;
    result.priority_update_count = priorities;
    result.pending_refinement_count = restoring.size() + refining.size();
    if (!read_output(result, rebuilding ? output_kind::roots : output_kind::leaves)) {
      result.complete = true;
      return result;
    }
    // Progress changes independently of output identity. Only a completed cut
    // needs the refusal diagnostics; continuation never rescans every draw.
    if (result.decisions_complete) for (const auto& current : leaves) {
      const node& value = *current.second;
      if (value.error > budget.requested_pixel_error && std::isfinite(value.error)) {
        if (value.tile.level < static_cast<int>(budget.maximum_level)) {
          // Diagnostics must never launch a synchronous child scan. A queue
          // refusal has already measured its children; a partition receipt
          // can suppress work without them and supplies its own limit proof.
          const auto& descendants = value.children;
          std::size_t count = draws - value.refs.size();
          if (value.children_revision == revision) {
            for (const auto* child : descendants) count += child->refs.size();
            result.limited_by_texture_budget = result.limited_by_texture_budget ||
              split_resource_count(value, descendants) > budget.maximum_texture_count;
            result.limited_by_draw_budget = result.limited_by_draw_budget || count > budget.maximum_draw_count;
          }
          result.limited_by_partition_budget = result.limited_by_partition_budget || partition_blocked.count(tile_key(value.tile)) != 0U;
          ++result.pending_refinement_count;
        }
      }
    }
    // Feasible error describes the admitted cut. It never replaces the demand.
    result.feasible_pixel_error = std::max(result.requested_pixel_error, result.maximum_pixel_error);
    result.complete = true;
    if (result.decisions_complete) previous_splits = splits;
    // Retire indices of removed inputs using spare priority credits, including
    // after an allocation stop. A valid coarse parent must publish without
    // first visiting its obsolete fine subtree. Keep topology history, and
    // keep reusable cells of retained measurements even before they are visited
    // in the successor cut. Pressure reclamation can still evict this cache.
    while (retiring_references != nodes.end() && priorities < maximum_priorities &&
        (maximum_milliseconds <= 0.0 || milliseconds() - started < maximum_milliseconds)) {
      ++priorities;
      for (std::size_t count = 0U; count < 64U && retiring_references != nodes.end(); ++count) {
        auto& value = retiring_references->second;
        if (value.revision == revision || retiring_reference == value.refs.size()) {
          ++retiring_references; retiring_reference = 0U;
          continue;
        }
        auto& ref = value.refs[retiring_reference++];
        if (!inputs_by_identity.count(ref.input_identity)) ref = reference();
      }
    }
    while (result.decisions_complete && nodes.size() > 4096U && priorities < maximum_priorities && time_left()) {
      auto it = nodes.upper_bound(prune_position);
      if (it == nodes.end()) { prune_position.clear(); break; }
      prune_position = it->first;
      ++priorities;
      if (it->second.revision != revision) nodes.erase(it);
    }
    result.priority_update_count = priorities;
    result.cached_node_count = nodes.size();
    return result;
  }

};

struct imagery_controller::memory : imagery_memory::account {};
imagery_controller::imagery_controller() : memory_(std::make_shared<memory>()) {
  imagery_memory::scope scope(memory_);
  implementation_.reset(new implementation());
}
imagery_controller::~imagery_controller() = default;
void imagery_controller::clear() {
  imagery_memory::scope scope(memory_);
  implementation_.reset(new implementation());
}
std::size_t imagery_controller::allocated_bytes() const { return memory_->bytes; }
std::size_t imagery_controller::input_allocated_bytes() const { return memory_->inputs; }
std::uint64_t imagery_controller::input_work_bytes(std::size_t members, std::size_t new_inputs,
    std::size_t regions, std::size_t hull_points) {
  return std::uint64_t(members) * (sizeof(imagery_surface) + implementation::input_binding_envelope) +
    std::uint64_t(new_inputs) * imagery_surface_input::allocation_envelope() +
    std::uint64_t(regions) * sizeof(measurement_region) + std::uint64_t(hull_points) * sizeof(core::vector2d);
}
bool imagery_controller::stage_input(imagery_input_work& work,std::size_t members,std::size_t fresh,
    std::size_t regions,std::size_t hull,std::uint64_t maximum_bytes) {
  const auto bytes=imagery_input_work::work_bytes(members,fresh,regions,hull);
  if(work.active()||bytes==std::numeric_limits<std::uint64_t>::max()||bytes>maximum_bytes||
      fresh>std::numeric_limits<std::uint64_t>::max()-memory_->next_input_id)return false;
  if(!members){work.empty_=true;return true;}
  imagery_memory::scope scope(memory_);
  auto* raw=::operator new(sizeof(imagery_input_work::state),std::nothrow);if(!raw)return false;
  memory_->acquire(sizeof(imagery_input_work::state));memory_->inputs+=sizeof(imagery_input_work::state);
  decltype(work.state_) state(::new(raw) imagery_input_work::state);
  state->members.reserve(members);state->members_charge.resize(state->members.capacity()*sizeof(imagery_surface));
  state->count=members;state->fresh_left=fresh;state->regions_left=state->total_regions=regions;state->hull_left=state->total_hull=hull;
  work.state_=std::move(state);return true;
}
bool imagery_controller::commit_input(imagery_input_work&& work,const imagery_budget& budget) {
  if(!work.complete()||(work.state_&&work.state_->owner!=memory_))return false;
  imagery_memory::scope scope(memory_);bool result;
  if(work.empty_)result=implementation_->begin({},budget);
  else result=implementation_->begin(std::move(work.state_->members),budget,&work.state_->members_charge);
  work.cancel();return result;
}
std::shared_ptr<const imagery_surface_input> imagery_controller::retain_surface(std::uint32_t draw_index) const {
  std::shared_ptr<const imagery_surface_input> result;
  for (const auto& surface : implementation_->surfaces) if (surface.draw_index == draw_index) {
    if (result) return {};
    result = surface.retained_input;
  }
  return result;
}
std::pair<std::size_t, std::size_t> imagery_controller::input_shape(
    const std::shared_ptr<const imagery_surface_input>& input) {
  return input ? std::make_pair(input->data.regions.size(), input->data.hull.size()) :
      std::make_pair(std::size_t(0), std::size_t(0));
}
bool imagery_controller::read_input(const std::shared_ptr<const imagery_surface_input>& input,
    std::size_t first,measurement_region* output,std::size_t capacity,std::size_t& count) {
  count=0U;
  if(!input||input->normalized!=input->data.regions.size()||capacity>256U||(capacity&&!output)||first>input->data.regions.size())return false;
  count=std::min(capacity,input->data.regions.size()-first);
  if(count)std::copy_n(input->data.regions.data()+first,count,output);
  return true;
}
bool imagery_controller::read_input_hull(const std::shared_ptr<const imagery_surface_input>& input,
    std::size_t first,core::vector2d* output,std::size_t capacity,std::size_t& count) {
  count=0U;
  if(!input||input->normalized!=input->data.regions.size()||capacity>256U||(capacity&&!output)||first>input->data.hull.size())return false;
  count=std::min(capacity,input->data.hull.size()-first);
  if(count)std::copy_n(input->data.hull.data()+first,count,output);
  return true;
}
std::size_t imagery_controller::reference_allocated_bytes() const { return memory_->references; }
std::size_t imagery_controller::reference_work_bytes() const { return implementation_->reference_needed; }
std::size_t imagery_controller::output_allocated_bytes() const { return memory_->outputs; }
std::size_t imagery_controller::output_work_bytes() const { return implementation_->output_needed; }
imagery_reclaim_progress imagery_controller::reclaim_references(std::size_t needed,
    std::size_t maximum_visits, bool restart) {
  imagery_memory::scope scope(memory_);
  return implementation_->reclaim_references(needed, maximum_visits, restart);
}
std::size_t imagery_controller::peak_allocated_bytes() const { return memory_->peak; }
bool imagery_controller::begin(std::vector<imagery_surface> surfaces,
                                const imagery_budget& budget) {
  imagery_memory::scope scope(memory_);
  return implementation_->begin(std::move(surfaces), budget);
}
imagery_cut imagery_controller::update_step(std::size_t maximum_changes,
    std::size_t maximum_priorities, double maximum_milliseconds, std::size_t maximum_reference_work_bytes,
    std::size_t maximum_output_work_bytes) {
  imagery_memory::scope scope(memory_);
  return implementation_->step(maximum_changes, maximum_priorities, maximum_milliseconds,
      maximum_reference_work_bytes, maximum_output_work_bytes);
}
bool imagery_controller::accept_cut(const std::vector<imagery::node_key>& tiles,
                                    std::uint64_t admission_revision) {
  imagery_memory::scope scope(memory_);
  return implementation_->accept_cut(tiles, admission_revision);
}

imagery_cut imagery_controller::plan(std::vector<imagery_surface> surfaces,
                                      const imagery_budget& budget) {
  if (!begin(std::move(surfaces), budget)) return imagery_cut();
  return update_step(std::numeric_limits<std::size_t>::max(),
                     std::numeric_limits<std::size_t>::max(), 0.0);
}

}  // namespace frame
}  // namespace terra
