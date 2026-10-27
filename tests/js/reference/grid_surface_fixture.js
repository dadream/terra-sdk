module.exports = function (n) {
  const positions = [], uv = [], strip = []
  for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x) {
    positions.push(x / n, y / n, Math.sin(x / 7) * Math.cos(y / 11)); uv.push(x / n, y / n)
  }
  for (let y = 0; y < n; ++y) {
    if (strip.length) strip.push(strip[strip.length - 1], y * (n + 1))
    for (let x = 0; x <= n; ++x) strip.push(y * (n + 1) + x, (y + 1) * (n + 1) + x)
  }
  return {positions: new Float32Array(positions), uv: new Float32Array(uv), indices: new Uint16Array(strip)}
}
