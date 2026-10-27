'use strict'
const {prepare}=require('../static_view/prepare')
const options=JSON.parse(process.argv[2])
const cases={oblique:'testdata/benchmarks/beijing-oblique-flight-v1.json',
  zoom:'testdata/benchmarks/taian-rapid-zoom-v1.json'}
if(!cases[options.navigationCase||'oblique'])throw Error('Unknown fixed navigation case')
prepare(options, {
  caseFile:cases[options.navigationCase||'oblique'],
  browserFile:'tests/benchmarks/navigation/browser.js',
  scripts:{acceptance:'tests/benchmarks/navigation/acceptance.js'}
})
