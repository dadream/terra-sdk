const fs = require('fs')
const path = require('path')

const output = process.argv[2] && path.resolve(process.argv[2])
if (!output) throw new Error('Missing product site output directory')

const required = [
  'index.html',
  'styles.css',
  'site.js',
  'assets/terra_browser_bundle.js',
  'assets/terra_sdk.wasm',
  'assets/release.json',
  'demo/globe/index.html',
  'demo/planar/index.html',
  'demo/styles.css',
  'demo/app.js',
  'services/index.html',
  'docs/quickstart/index.html',
  'license/index.html',
  'downloads/index.html'
]

for (const relativePath of required) {
  const file = path.join(output, relativePath)
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Missing product site artifact: ${relativePath}`)
  }
  const content = /\.(?:html|js|css|json)$/.test(relativePath)
    ? fs.readFileSync(file, 'utf8') : ''
  if (content.includes('__TERRA_')) {
    throw new Error(`Unresolved template marker in ${relativePath}`)
  }
}

const release = JSON.parse(fs.readFileSync(
  path.join(output, 'assets/release.json'), 'utf8'))
if (release.schema !== 'terra.product-site-release.v1' ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.tag !== `v${release.version}`) {
  throw new Error('Product site release metadata is invalid')
}
const home = fs.readFileSync(path.join(output, 'index.html'), 'utf8')
for (const href of ['/demo/globe/', '/demo/planar/', '/docs/quickstart/',
  '/services/', '/license/']) {
  if (!home.includes(`href="${href}"`)) {
    throw new Error(`Home page is missing ${href}`)
  }
}
const bundle = fs.readFileSync(
  path.join(output, 'assets/terra_browser_bundle.js'), 'utf8')
if (!bundle.includes('global.TerraWebSdk') || bundle.length < 100000) {
  throw new Error('Terra browser bundle is incomplete')
}
if (fs.statSync(path.join(output, 'assets/terra_sdk.wasm')).size < 10000) {
  throw new Error('Terra Wasm artifact is incomplete')
}
const demo = fs.readFileSync(path.join(output, 'demo/app.js'), 'utf8')
if (!demo.includes('Object.getOwnPropertyDescriptor') ||
    !demo.includes('descriptor.set.call(image, rewriteLoopbackUrl(value))')) {
  throw new Error('Product demo is missing its public HTTP image URL adapter')
}
if (demo.includes('makeSameOrigin')) {
  throw new Error('Product demo rewrites imagery URLs before SDK validation')
}
const revisions = []
for (const mode of ['globe', 'planar']) {
  const html = fs.readFileSync(
    path.join(output, 'demo', mode, 'index.html'), 'utf8')
  const bundleMatch =
    /src="\/assets\/terra_browser_bundle\.js\?rev=([0-9a-f]{12})"/.exec(html)
  const appMatch =
    /src="\/demo\/app\.js\?rev=([0-9a-f]{12})"/.exec(html)
  if (!bundleMatch || !appMatch) {
    throw new Error(`${mode} demo is missing versioned runtime assets`)
  }
  if (bundleMatch[1] !== appMatch[1]) {
    throw new Error(`${mode} demo runtime asset revisions do not match`)
  }
  revisions.push(bundleMatch[1])
}
if (new Set(revisions).size !== 1) {
  throw new Error('Globe and planar demos use different runtime revisions')
}

console.log(`Terra SDK product site verified for ${release.tag}.`)
