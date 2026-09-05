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
const localizedPages = [
  'index.html',
  'demo/globe/index.html',
  'demo/planar/index.html',
  'services/index.html',
  'docs/quickstart/index.html',
  'license/index.html',
  'downloads/index.html'
]
const siteScript = fs.readFileSync(path.join(output, 'site.js'), 'utf8')
const catalogKeys = new Set(Array.from(
  siteScript.matchAll(/^    '([^']+)': \[/gm), (match) => match[1]))
if (!siteScript.includes("const storageKey = 'terra.siteLanguage'") ||
    !siteScript.includes("value === 'en' ? 'en' : 'zh-CN'")) {
  throw new Error('Product site language state does not default to Chinese')
}
const localizedRevisions = []
for (const relativePath of localizedPages) {
  const html = fs.readFileSync(path.join(output, relativePath), 'utf8')
  if (!html.includes('<html lang="zh-CN"') ||
      !html.includes('src="/site.js')) {
    throw new Error(`${relativePath} is missing Chinese-first localization`)
  }
  const referencedKeys = Array.from(html.matchAll(
    /data-i18n(?:-(?:title|aria-label|content))?="([^"]+)"/g),
  (match) => match[1])
  for (const key of referencedKeys) {
    if (!catalogKeys.has(key)) {
      throw new Error(`${relativePath} references unknown i18n key ${key}`)
    }
  }
  const siteMatch = /src="\/site\.js\?rev=([0-9a-f]{12})"/.exec(html)
  const styleMatch = /href="\/(?:demo\/)?styles\.css\?rev=([0-9a-f]{12})"/.exec(html)
  if (!siteMatch || !styleMatch || siteMatch[1] !== styleMatch[1]) {
    throw new Error(`${relativePath} is missing versioned site assets`)
  }
  localizedRevisions.push(siteMatch[1])
}
if (new Set(localizedRevisions).size !== 1) {
  throw new Error('Localized pages use different site asset revisions')
}
const services = fs.readFileSync(
  path.join(output, 'services/index.html'), 'utf8')
if (!services.includes(
  'href="/demo/globe/?imagery=tianditu-img-c"')) {
  throw new Error('Services page is missing its Tianditu demo entry point')
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
if (!demo.includes("url.searchParams.set('imagery', name)") ||
    !demo.includes("window.history.replaceState(null, '', url)")) {
  throw new Error('Product demo does not preserve the selected imagery profile')
}
if (!demo.includes("const resetLabel = text(isGlobe ? 'demo.globe' : 'demo.reset')")) {
  throw new Error('Product demo does not localize its dynamic reset control')
}
const revisions = []
for (const mode of ['globe', 'planar']) {
  const html = fs.readFileSync(
    path.join(output, 'demo', mode, 'index.html'), 'utf8')
  const bundleMatch =
    /src="\/assets\/terra_browser_bundle\.js\?rev=([0-9a-f]{12})"/.exec(html)
  const appMatch =
    /src="\/demo\/app\.js\?rev=([0-9a-f]{12})"/.exec(html)
  const siteMatch =
    /src="\/site\.js\?rev=([0-9a-f]{12})"/.exec(html)
  const styleMatch =
    /href="\/demo\/styles\.css\?rev=([0-9a-f]{12})"/.exec(html)
  if (!bundleMatch || !appMatch || !siteMatch || !styleMatch) {
    throw new Error(`${mode} demo is missing versioned runtime assets`)
  }
  if (bundleMatch[1] !== appMatch[1] ||
      bundleMatch[1] !== siteMatch[1] ||
      bundleMatch[1] !== styleMatch[1]) {
    throw new Error(`${mode} demo runtime asset revisions do not match`)
  }
  revisions.push(bundleMatch[1])
}
if (new Set(revisions).size !== 1) {
  throw new Error('Globe and planar demos use different runtime revisions')
}

console.log(`Terra SDK product site verified for ${release.tag}.`)
