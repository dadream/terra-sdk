const fs = require('fs')
const https = require('https')
const path = require('path')

const AMAP_ORIGIN = 'https://restapi.amap.com'
const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

const POI_QUERIES = [
  { id: 'huqiu', sourceId: 'B020001DMQ', query: '虎丘山风景名胜区' },
  { id: 'hanshan-temple', sourceId: 'B020001C0E', query: '寒山寺' },
  { id: 'humble-administrators-garden', sourceId: 'B020001R2Q', query: '拙政园' },
  { id: 'lion-grove-garden', sourceId: 'B020001B0C', query: '狮子林' }
]

function requestJson(pathname, parameters) {
  const url = new URL(pathname, AMAP_ORIGIN)
  Object.keys(parameters).forEach((name) =>
    url.searchParams.set(name, parameters[name]))
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000 }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Amap returned HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`Amap returned invalid JSON: ${error.message}`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('Amap timed out')))
    request.on('error', reject)
  })
}

function requireSuccess(response, operation) {
  if (!response || response.status !== '1') {
    const code = response && response.infocode ? response.infocode : 'unknown'
    const info = response && response.info ? response.info : 'unknown error'
    throw new Error(`${operation} failed: ${info} (${code})`)
  }
  return response
}

function parseCoordinate(value, label) {
  const parts = String(value || '').split(',').map(Number)
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    throw new Error(`${label} returned an invalid coordinate`)
  }
  return parts
}

function outsideChina(longitude, latitude) {
  return longitude < 72.004 || longitude > 137.8347 ||
    latitude < 0.8293 || latitude > 55.8271
}

function transformLatitude(longitude, latitude) {
  let result = -100 + 2 * longitude + 3 * latitude +
    0.2 * latitude * latitude + 0.1 * longitude * latitude +
    0.2 * Math.sqrt(Math.abs(longitude))
  result += (20 * Math.sin(6 * longitude * Math.PI) +
    20 * Math.sin(2 * longitude * Math.PI)) * 2 / 3
  result += (20 * Math.sin(latitude * Math.PI) +
    40 * Math.sin(latitude / 3 * Math.PI)) * 2 / 3
  result += (160 * Math.sin(latitude / 12 * Math.PI) +
    320 * Math.sin(latitude * Math.PI / 30)) * 2 / 3
  return result
}

function transformLongitude(longitude, latitude) {
  let result = 300 + longitude + 2 * latitude +
    0.1 * longitude * longitude + 0.1 * longitude * latitude +
    0.1 * Math.sqrt(Math.abs(longitude))
  result += (20 * Math.sin(6 * longitude * Math.PI) +
    20 * Math.sin(2 * longitude * Math.PI)) * 2 / 3
  result += (20 * Math.sin(longitude * Math.PI) +
    40 * Math.sin(longitude / 3 * Math.PI)) * 2 / 3
  result += (150 * Math.sin(longitude / 12 * Math.PI) +
    300 * Math.sin(longitude / 30 * Math.PI)) * 2 / 3
  return result
}

function wgs84ToGcj02(value) {
  const longitude = value[0]
  const latitude = value[1]
  if (outsideChina(longitude, latitude)) return [longitude, latitude]
  let latitudeDelta = transformLatitude(longitude - 105, latitude - 35)
  let longitudeDelta = transformLongitude(longitude - 105, latitude - 35)
  const latitudeRadians = latitude / 180 * Math.PI
  const sine = Math.sin(latitudeRadians)
  const magic = 1 - GCJ_EE * sine * sine
  const squareRoot = Math.sqrt(magic)
  latitudeDelta = latitudeDelta * 180 /
    ((GCJ_A * (1 - GCJ_EE)) / (magic * squareRoot) * Math.PI)
  longitudeDelta = longitudeDelta * 180 /
    (GCJ_A / squareRoot * Math.cos(latitudeRadians) * Math.PI)
  return [longitude + longitudeDelta, latitude + latitudeDelta]
}

function gcj02ToWgs84(value) {
  let longitude = value[0]
  let latitude = value[1]
  if (outsideChina(longitude, latitude)) return [longitude, latitude]
  for (let iteration = 0; iteration < 12; ++iteration) {
    const projected = wgs84ToGcj02([longitude, latitude])
    const longitudeError = projected[0] - value[0]
    const latitudeError = projected[1] - value[1]
    longitude -= longitudeError
    latitude -= latitudeError
    if (Math.max(Math.abs(longitudeError), Math.abs(latitudeError)) < 1e-9) {
      break
    }
  }
  return [longitude, latitude]
}

function roundedCoordinate(value) {
  return value.map((component) => Number(component.toFixed(7)))
}

async function queryPoi(definition, key) {
  const response = requireSuccess(await requestJson('/v3/place/text', {
    key,
    keywords: definition.query,
    city: '苏州市',
    citylimit: 'true',
    offset: '10',
    page: '1',
    extensions: 'base',
    output: 'JSON'
  }), `POI query ${definition.query}`)
  const source = (response.pois || []).find((poi) =>
    poi.id === definition.sourceId)
  if (!source) {
    throw new Error(`Expected Amap POI ${definition.sourceId} was not returned`)
  }
  const gcj02 = parseCoordinate(source.location, definition.query)
  return {
    id: definition.id,
    sourceId: source.id,
    name: source.name,
    address: Array.isArray(source.address) ? '' : source.address,
    district: source.adname,
    sourceCoordinateGcj02: roundedCoordinate(gcj02.concat(0)),
    coordinate: roundedCoordinate(gcj02ToWgs84(gcj02).concat(0)),
    altitudeMode: 'surface',
    priority: POI_QUERIES.length - POI_QUERIES.indexOf(definition)
  }
}

function routePoints(pathValue) {
  const result = []
  ;(pathValue.steps || []).forEach((step) => {
    String(step.polyline || '').split(';').forEach((value) => {
      if (!value) return
      const coordinate = parseCoordinate(value, 'Bicycling route')
      const previous = result[result.length - 1]
      if (!previous || previous[0] !== coordinate[0] ||
        previous[1] !== coordinate[1]) result.push(coordinate)
    })
  })
  if (result.length < 2) throw new Error('Amap route returned too few points')
  return result
}

async function queryLeg(from, to, key) {
  const response = requireSuccess(await requestJson(
    '/v5/direction/bicycling', {
      key,
      origin: from.sourceCoordinateGcj02.slice(0, 2).join(','),
      destination: to.sourceCoordinateGcj02.slice(0, 2).join(','),
      show_fields: 'cost,navi,polyline',
      alternative_route: '1',
      output: 'JSON'
    }), `Bicycling route ${from.name} to ${to.name}`)
  const pathValue = response.route && response.route.paths &&
    response.route.paths[0]
  if (!pathValue) throw new Error('Amap route returned no path')
  const sourceCoordinates = routePoints(pathValue)
  return {
    id: `${from.id}-to-${to.id}`,
    from: from.id,
    to: to.id,
    distanceMeters: Number(pathValue.distance),
    durationSeconds: Number(pathValue.duration),
    sourceCoordinatesGcj02: sourceCoordinates.map((value) =>
      roundedCoordinate(value.concat(0))),
    coordinates: sourceCoordinates.map((value) =>
      roundedCoordinate(gcj02ToWgs84(value).concat(0)))
  }
}

function combinedRoute(legs) {
  const coordinates = []
  legs.forEach((leg) => leg.coordinates.forEach((coordinate) => {
    const previous = coordinates[coordinates.length - 1]
    if (!previous || previous[0] !== coordinate[0] ||
      previous[1] !== coordinate[1]) coordinates.push(coordinate)
  }))
  return coordinates
}

async function buildFixture(key) {
  if (!key) throw new Error('AMAP_WEB_SERVICE_KEY is required')
  const pois = []
  for (const definition of POI_QUERIES) {
    pois.push(await queryPoi(definition, key))
  }
  const legs = []
  for (let index = 0; index < pois.length - 1; ++index) {
    legs.push(await queryLeg(pois[index], pois[index + 1], key))
  }
  const coordinates = combinedRoute(legs)
  return {
    schema: 'terra.tour-fixture.v1',
    id: 'suzhou-gardens-bicycle',
    title: '苏州园林骑行验证路线',
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'amap',
      coordinateSystem: 'GCJ-02',
      displayCoordinateSystem: 'WGS84',
      routeMode: 'bicycling-v5'
    },
    pois,
    legs,
    route: {
      id: 'suzhou-gardens-bicycle',
      altitudeMode: 'surface',
      color: '#35c78a',
      widthPixels: 4,
      opacity: 0.92,
      coordinates
    },
    summary: {
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
      routePointCount: coordinates.length
    }
  }
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const output = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(root, 'testdata', 'tours',
      'suzhou-gardens-bicycle.v1.json')
  const fixture = await buildFixture(process.env.AMAP_WEB_SERVICE_KEY)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`Suzhou tour fixture written: ${output}`)
  console.log(`POIs=${fixture.pois.length} legs=${fixture.legs.length} ` +
    `points=${fixture.summary.routePointCount}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = {
  buildFixture,
  gcj02ToWgs84,
  wgs84ToGcj02
}
