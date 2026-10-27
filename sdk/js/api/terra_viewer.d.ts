export type ViewerMode = 'globe' | 'planar'
export type AltitudeMode = 'absolute' | 'surface'
export type SurfaceStatus = 'unavailable' | 'approximate' | 'ready'

export interface GlobeTarget {
  longitudeDegrees: number
  latitudeDegrees: number
  heightMeters?: number
}

export interface PlanarTarget {
  x: number
  y: number
  heightMeters?: number
}

export interface OrbitViewState {
  schema: 'terra.view-state.v2'
  mode: ViewerMode
  target: GlobeTarget | PlanarTarget
  /** Eye-to-target distance in metres; excludes body radius and target height. */
  rangeMeters: number
  headingDegrees: number
  tiltDegrees: number
}

/** Position is the eye itself. Looking never orbits a hidden target. */
export interface EyeViewState {
  schema: 'terra.eye-view.v1'
  mode: 'globe'
  position: {longitudeDegrees: number; latitudeDegrees: number; heightMeters: number}
  headingDegrees: number
  /** Positive above the local horizon; -89.5..89.5 degrees. */
  pitchDegrees: number
}
export type ViewState = OrbitViewState | EyeViewState

export interface WalkState {
  state: 'idle' | 'walking' | 'terrain-wait' | 'stopped' | 'complete'
  pending: boolean
  distanceMeters?: number
  requestedDistanceMeters?: number
  terrainStatus?: 'ready' | 'limited'
  sampleSpacingMeters?: number
  verticalAccuracyMeters?: null
  reason?: string
}

export interface PointerValue {
  id: string | number
  x: number
  y: number
}

export interface PointerPacket {
  pointers: PointerValue[]
  timeMs: number
}

export interface PoiValue {
  id: string
  coordinate: [number, number] | [number, number, number]
  altitudeMode?: AltitudeMode
  icon?: string
  priority?: number
}

export interface RouteValue {
  id: string
  coordinates: Array<[number, number] | [number, number, number]>
  altitudeMode?: AltitudeMode
  color?: string
  widthPixels?: number
  opacity?: number
}

export interface TerrainSample {
  status: 'available' | 'unavailable'
  source: 'cbdam-cache'
  heightMeters: number | null
  /** Conservative horizontal spacing of real data, not vertical accuracy. */
  sampleSpacingMeters: number | null
  level: number | null
  dataLevel: number | null
  revision: number
}

export interface TerrainQueryOptions {
  /** Conservative horizontal spacing requested in metres; defaults to 30. */
  sampleSpacingMeters?: number
  /** CBDAM level ceiling, 0..39; defaults to 39. */
  maximumLevel?: number
  /** Decoded records/heights and refinement workspace; defaults to at least
   * 2 MiB, scaled up for larger CBDAM patches. */
  maximumBytes?: number
  /** Cancellation deadline including queue time; defaults to 30 seconds,
   * maximum 120 seconds. Settlement waits for owned producers to exit. */
  timeoutMs?: number
  signal?: { readonly aborted: boolean
    addEventListener(type: 'abort', listener: () => void, options?: {once?: boolean}): void
    removeEventListener(type: 'abort', listener: () => void): void }
}
export interface TerrainQueryResult {
  status: 'ready' | 'limited' | 'unavailable'
  source: 'cbdam-query'
  available: boolean
  heightMeters: number | null
  sampleSpacingMeters: number | null
  requestedSampleSpacingMeters: number
  /** Source vertical accuracy is unknown; never inferred from screen error. */
  verticalAccuracyMeters: null
  level: number | null
  dataLevel: number | null
  revision: number
  reasons: Array<'no-data' | 'request-failed' | 'source-level' | 'resource-budget' | 'invalid-data'>
  peakBytes: number
  /** Reused an admitted reconstructed region; no query reconstruction or GET. */
  cacheHit: boolean
}

export interface SurfaceSample {
  status: SurfaceStatus
  heightMeters: number | null
  revision: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface Projection extends ScreenPoint {
  depth: number
  visible: boolean
}

export interface PickedPoi {
  featureId: string
  coordinate: [number, number, number]
  screenPoint: ScreenPoint
}

export interface InteractionOptions {
  mode?: 'move' | 'look'
  rotateEnabled?: boolean
  tiltEnabled?: boolean
  inertiaEnabled?: boolean
}

export interface ImagerySource {
  id: string
  tileScheme?: string
  minimumLevel?: 0
  maximumLevel?: number
  matrixLevelOffset?: number
  texture?: {
    id: string
    kind: 'global-geodetic' | 'planar-tms' | 'planar-single'
    url_template: string
    minimum_level?: 0
    maximum_level: number
    matrix_level_offset: number
    tile_size?: number
    level_zero_columns?: number
    level_zero_rows?: number
    origin?: 'top-left' | 'bottom-left'
    crs?: 'EPSG:4326' | 'EPSG:4490' | 'CRS:84'
    matrix_ids?: Array<string | number>
    bounds?: [[number, number], [number, number]]
  }
  attribution?: string
  resolveTile(tile: {
    level: number
    matrix: string | number
    row: number
    column: number
  }): string
}

export interface AtmosphereOptions {
  enabled?: boolean
  sunEnabled?: boolean
  fogEnabled?: boolean
  fogDensityMultiplier?: number
  sunAzimuthDegrees?: number
  sunZenithDegrees?: number
  turbidity?: number
  exposure?: number
}

export interface TerrainNavigationOptions {
  /** Enabled by default for globe views. No first-person movement controller is implied. */
  enabled?: boolean
  /** Horizontal CBDAM sample spacing; default 30 m, not vertical accuracy. */
  sampleSpacingMeters?: number
  /** Projected viewing direction on the globe; default 50 m. */
  lookAheadMeters?: number
  /** Query only below this absolute eye altitude; default 20,000 m. */
  activationHeightMeters?: number
}

export interface GroundDemandPoint {
  longitudeDegrees: number
  latitudeDegrees: number
  status: 'pending' | 'ready' | 'limited' | 'unavailable'
  heightMeters: number | null
  sampleSpacingMeters: number | null
  verticalAccuracyMeters: null
  reasons: string[]
}

export interface CameraTerrainState {
  active: boolean
  /** Includes an aborted producer until its cleanup receipt. */
  pending: boolean
  revision: number
  eye: GroundDemandPoint | null
  front: GroundDemandPoint | null
}

export interface TerrainRequestOptions {
  url: string
  method: 'GET'
  responseType?: 'arraybuffer'
  timeout: number
  /** Maximum decoded HTTP body bytes. Enforce while receiving; Content-Length
   * alone is insufficient. SDK verification after receipt cannot bound a
   * custom transport's own buffers. */
  maximumResponseBytes: number
}

export interface TerrainRequestTask {
  /** Settle only after the physical producer exits, including after abort.
   * The SDK separately cancels individual consumers of a shared GET. */
  promise: Promise<{statusCode: number; data: unknown; header?: Record<string, string>}>
  abort(): void
}

export interface ViewerCreateOptions {
  canvas: unknown
  mode: ViewerMode
  dataset?: object
  manifest?: object
  imagery?: ImagerySource
  viewport: {
    width: number
    height: number
    devicePixelRatio?: number
  }
  initialView?: ViewState
  initialTarget?: GlobeTarget | PlanarTarget
  interaction?: InteractionOptions
  atmosphere?: AtmosphereOptions
  terrainNavigation?: TerrainNavigationOptions
  minimumTerrainClearanceMeters?: number
  /** Concurrent imagery requests, clamped to 1..8; defaults to 8. Independent
   * of terrain request concurrency and viewport size. The browser encoded-body
   * workspace scales with this count, but each allocation still requires
   * admission inside maximumResourceBytes. Does not change GPU upload timing. */
  maximumTextureRequests?: number
  /** Shared managed-payload limit in bytes; a positive safe integer. Defaults
   * to 768 MiB for every initial viewport. Fixed at creation;
   * resizing and cache share changes do not enlarge it. Not a process/GPU-driver
   * memory ceiling. Enabled globe terrain navigation reserves one reusable
   * default query workspace inside this total. Insufficient capacity is
   * reported as limited quality. */
  maximumResourceBytes?: number
  /** Positive safe integer ceiling for the imagery target share, in bytes;
   * defaults to maximumResourceBytes. Starts with an initial-viewport preferred
   * share (unchanged on resize), then may obtain credit inside the fixed global envelope. Temporary
   * replacement overlap also requires global admission. Lowering the target
   * share never refunds displayed images before their replacement receipts. */
  maximumImageryBytes?: number
  /** Positive safe integer limit for selected terrain positions and unique UV
   * layouts. Defaults to 64 MiB for every initial viewport;
   * at most 2147483647 bytes. Must hold the manifest's root coverage. Fixed at
   * creation. Also sets the native decoded-record ceiling; the height and
   * retained geometry ceilings are twice this amount; the native publication
   * ceiling is four times this amount, capped at uint32. These are local ceilings,
   * not reservations or an increase of maximumResourceBytes. A handoff can
   * temporarily retain its exact outgoing display beyond that local quota;
   * all old and new native/host/GPU allocations remain charged inside
   * maximumResourceBytes until their ownership receipts release them.
   * Raising this limit does not guarantee terrain precision or convergence. */
  maximumTerrainMeshBytes?: number
  /** Positive safe integer capacity for terrain/imagery partition payloads.
   * Defaults to 16 MiB, or 32 MiB above 700,000 initial CSS pixels. Fixed at
   * creation; actual allocations still require shared global admission. */
  maximumPartitionBytes?: number
  serviceOrigin?: string
  manifestPath?: string
  request?(options: TerrainRequestOptions): TerrainRequestTask
  textureId?: string
  onState?(state: object): void
  onDiagnostic?(kind: string, detail: object): void
}

export interface CameraApi {
  getView(): ViewState
  getTerrainState(): CameraTerrainState
  retryTerrain(): void
  /** Ground-following command, at most 100m; missing terrain parks movement.
   * This samples CBDAM heights and does not perform a swept collision test. */
  walkBy(change: {forwardMeters?: number; rightMeters?: number; speedMetersPerSecond?: number;
    eyeHeightMeters?: number}): Promise<{distanceMeters: number; view: EyeViewState; terrain: WalkState}>
  stopWalking(): boolean
  getWalkState(): WalkState
  setView(view: ViewState, options?: {
    animate?: boolean
    durationMs?: number
  }): ViewState
  panBy(change: { xPixels: number; yPixels: number }): void
  zoomBy(scale: number, options?: { anchor?: ScreenPoint }): void
  orbitBy(change: {
    headingDegrees?: number
    tiltDegrees?: number
  }): void
  setTilt(tiltDegrees: number): void
  topDown(): void
  northUp(): void
  reset(): void
  cancelAnimation(): boolean
}

export class TerraViewerError extends Error {
  readonly code: string
}

export interface InteractionApi {
  begin(packet: PointerPacket): void
  update(packet: PointerPacket): void
  end(packet: PointerPacket): void
  cancel(): void
  setOptions(options: InteractionOptions): void
}

/** Recent percentiles use at most 240 samples; lifetime counters retain stalls. */
export interface TimingStatistics {
  count: number
  lastMs: number
  averageMs: number
  maximumMs: number
  over50Ms: number
  windowCount: number
  windowEndingCount: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  windowMaxMs: number
}

export interface FrameStatistics {
  pendingAnimations: number
  pendingInputs: number
  pendingWork: number
  pendingRender: boolean
  animation: TimingStatistics
  input: TimingStatistics
  queue: TimingStatistics
  /** Host display request to callback, including normal vsync and host delay. */
  frameWait: TimingStatistics
  submit: TimingStatistics
  notify: TimingStatistics
  frame: TimingStatistics
  continuousInterval: TimingStatistics
  cameraToSubmit: TimingStatistics
  workQueue: TimingStatistics
}

export interface PerformanceSnapshot {
  schema: 'terra.performance.v3'
  runtime: {
    frameCoordinator: FrameStatistics
    wasmMemoryBytes: number
    /** Native planner payload and live Wasm packing; not all of this is budgeted. */
    nativeImageryBytes: number
    /** Funded input/packing subset; do not add it to nativeImageryBytes again. */
    imageryInput: null | { residentBytes: number; creditedBytes: number; waiting: number }
    /** Funded index subset; independent from input and output. */
    imageryReferences: null | { residentBytes: number; creditedBytes: number; waiting: number }
    /** Funded immutable draws/range scratch; a subset of nativeImageryBytes. */
    imageryOutput: null | { residentBytes: number; creditedBytes: number; waiting: number }
    imageryInputCapacity: boolean
    /** Worker planning observation; age includes cooperative scheduling waits. */
    workerImageryPlanning: null | {
      viewRevision: number
      modelRevision: number
      ageMs: number
      settledRebases: number
      stage: 'coverage' | 'measurement' | 'input' | 'partition-budget' | 'planning' | 'complete'
    }
    fullUpdate: TimingStatistics
    modelAdvance: TimingStatistics
    lodUpdate: TimingStatistics
    frameRead: TimingStatistics
    rendererSetFrame: TimingStatistics
    cameraPreview: TimingStatistics
  }
  renderer: null | {
    render: TimingStatistics
    allocationValidation: TimingStatistics
    /** Completion observation of submissions containing draws (possibly also uploads).
     * Includes host scheduling; neither this nor resourceSubmissionWait is GPU execution time. */
    drawSubmissionWait: TimingStatistics
    /** Completion observation of uploads and retained-depth queries without a display redraw. */
    resourceSubmissionWait: TimingStatistics
    geometryPrepare: TimingStatistics
    imageryRebuild: TimingStatistics
    partitionQueueWait: TimingStatistics
    partitionTask: TimingStatistics
    geometryCapacityBytes: number
    textureCapacityBytes: number
    partitionCapacityBytes: number
  }
}

export class TerraViewer {
  static create(options: ViewerCreateOptions): Promise<TerraViewer>
  readonly diagnostics: {
    snapshot(): PerformanceSnapshot
    reset(): void
  }
  readonly debug: {
    /** Synchronous per-frame WebGL validation is diagnostic-only; default false. */
    setRendering(options: {textureState?: boolean; webglErrors?: boolean}): void
  }
  readonly camera: CameraApi
  readonly interaction: InteractionApi
  readonly imagery: { setSource(source: ImagerySource): void }
  readonly environment: {
    getAtmosphere(): Required<AtmosphereOptions>
    setAtmosphere(options: AtmosphereOptions): Required<AtmosphereOptions>
  }
  setPois(values: PoiValue[]): void
  clearPois(): void
  setRoute(value: RouteValue): void
  clearRoute(): void
  getRouteView(options?: { paddingPixels?: number }): ViewState
  /** Read resident CBDAM heights; no fetch or display-cut dependency. */
  sampleTerrain(coordinate: [number, number] |
    [number, number, number]): Promise<TerrainSample>
  /** Fetch independent CBDAM height data, including outside the view. Pause,
   * destroy, Worker replacement and AbortSignal cancel the query. */
  queryTerrain(coordinate: [number, number] | [number, number, number],
    options?: TerrainQueryOptions): Promise<TerrainQueryResult>
  /** Exact rendered-triangle intersection; terrain precision remains approximate. */
  sampleRenderedSurface(coordinate: [number, number] |
    [number, number, number]): SurfaceSample
  pickPoi(point: ScreenPoint): PickedPoi | null
  project(coordinate: [number, number] |
    [number, number, number]): Projection
  getState(): object
  on(type: string, listener: (event: any) => void): Function
  off(type: string, listener: Function): boolean
  resize(viewport: ViewerCreateOptions['viewport']): void
  pause(): void
  resume(): void
  destroy(): void
}

export interface ImagerySourceOptions {
  id: string
  url: string
  attribution?: string
  texture?: Partial<NonNullable<ImagerySource['texture']>>
}

export function createTmsImagerySource(options: ImagerySourceOptions): ImagerySource
export function createWmtsImagerySource(options: ImagerySourceOptions & {
  layer: string
  matrixSet: string
  style?: string
  format?: string
  parameters?: Record<string, string | number>
}): ImagerySource
