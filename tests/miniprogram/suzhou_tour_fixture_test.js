const assert = require('assert')
const path = require('path')

const fixture = require(path.resolve(__dirname, '..', '..', 'testdata',
  'tours', 'suzhou-gardens-bicycle.v1.json'))
const {
  wgs84ToGcj02
} = require('../../scripts/generate_suzhou_tour_fixture')

function coordinateError(left, right) {
  return Math.max(Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]))
}

function main() {
  assert.strictEqual(fixture.schema, 'terra.tour-fixture.v1')
  assert.strictEqual(fixture.id, 'suzhou-gardens-bicycle')
  assert.strictEqual(fixture.source.coordinateSystem, 'GCJ-02')
  assert.strictEqual(fixture.source.displayCoordinateSystem, 'WGS84')
  assert.deepStrictEqual(fixture.pois.map((poi) => poi.id), [
    'huqiu',
    'hanshan-temple',
    'humble-administrators-garden',
    'lion-grove-garden'
  ])
  assert.strictEqual(fixture.legs.length, 3)
  assert.strictEqual(fixture.summary.distanceMeters,
    fixture.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0))
  assert.strictEqual(fixture.summary.durationSeconds,
    fixture.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0))
  assert(fixture.summary.distanceMeters >= 14000)
  assert(fixture.summary.distanceMeters <= 17000)
  assert(fixture.summary.durationSeconds >= 4500)
  assert(fixture.summary.durationSeconds <= 5700)
  assert(fixture.summary.routePointCount >= 400)
  assert(fixture.summary.routePointCount <= 600)
  assert.strictEqual(fixture.summary.routePointCount,
    fixture.route.coordinates.length)
  assert.strictEqual(fixture.route.coordinates.length,
    fixture.legs.reduce((sum, leg) => sum + leg.coordinates.length, 0))
  assert(fixture.route.coordinates.length <= 2048)

  fixture.pois.forEach((poi) => {
    assert(poi.address)
    const roundTrip = wgs84ToGcj02(poi.coordinate)
    assert(coordinateError(roundTrip, poi.sourceCoordinateGcj02) < 1e-7)
  })
  fixture.legs.forEach((leg, index) => {
    assert.strictEqual(leg.from, fixture.pois[index].id)
    assert.strictEqual(leg.to, fixture.pois[index + 1].id)
    assert(leg.distanceMeters > 0)
    assert(leg.durationSeconds > 0)
    assert(leg.coordinates.length >= 2)
    assert.strictEqual(leg.coordinates.length,
      leg.sourceCoordinatesGcj02.length)
  })
  console.log('Suzhou tour fixture tests passed.')
}

main()
