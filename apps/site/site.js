(function () {
  'use strict'

  function assignRelease(release) {
    document.querySelectorAll('[data-release-version]').forEach((element) => {
      element.textContent = release.version
    })
    document.querySelectorAll('[data-release-url]').forEach((element) => {
      element.href = release.releaseUrl
    })
    document.querySelectorAll('[data-release-asset]').forEach((element) => {
      const kind = element.dataset.releaseAsset
      const filename = kind === 'native' ? release.native : release.miniprogram
      element.href = `${release.downloadRoot}/${filename}`
    })
    document.querySelectorAll('[data-checksum]').forEach((element) => {
      const checksum = element.dataset.checksum === 'native'
        ? release.nativeSha256 : release.miniprogramSha256
      element.textContent = checksum || 'Checksum is published with the release.'
    })
  }

  fetch('/assets/release.json', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`)
      return response.json()
    })
    .then(assignRelease)
    .catch(() => {
      document.documentElement.dataset.releaseStatus = 'unavailable'
    })
})()
