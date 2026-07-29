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
  height?: number
}

export interface ViewState {
  schema: 'terra.view-state.v1'
  mode: ViewerMode
  target: GlobeTarget | PlanarTarget
  rangeMeters: number
  headingDegrees: number
  tiltDegrees: number
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

export interface SurfaceSample {
  status: SurfaceStatus
  heightMeters: number
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
    origin?: 'top-left'
    bounds?: [[number, number], [number, number]]
  }
  attribution?: string
  resolveTile(tile: {
    level: number
    matrix: number
    row: number
    column: number
  }): string
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
  serviceOrigin?: string
  manifestPath?: string
  textureId?: string
  onState?(state: object): void
  onDiagnostic?(kind: string, detail: object): void
}

export interface CameraApi {
  getView(): ViewState
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

export class TerraViewer {
  static create(options: ViewerCreateOptions): Promise<TerraViewer>
  readonly camera: CameraApi
  readonly interaction: InteractionApi
  readonly imagery: { setSource(source: ImagerySource): void }
  setPois(values: PoiValue[]): void
  clearPois(): void
  setRoute(value: RouteValue): void
  clearRoute(): void
  getRouteView(options?: { paddingPixels?: number }): ViewState
  sampleSurface(coordinate: [number, number] |
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
