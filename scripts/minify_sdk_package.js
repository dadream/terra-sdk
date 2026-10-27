const fs = require('fs')
const path = require('path')
const terser = require('terser')

async function main() {
  const directory = process.argv[2]
  if (!directory) throw new Error('SDK utilities directory is required')
  function files(dir) {
    return fs.readdirSync(dir).sort().reduce((result, name) => {
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) result.push(...files(file))
      else if (name.endsWith('.js')) result.push(file)
      return result
    }, [])
  }
  for (const file of files(directory)) {
    // Keep public properties, facade class names and explicit error identities.
    // Internal constructor/function names are not an API contract. Use safe
    // transforms; exact distributed modules also run the source contracts.
    const result = await terser.minify(fs.readFileSync(file, 'utf8'), {
      compress: {passes: 2, toplevel: true, unsafe: false}, mangle: {toplevel: true},
      keep_fnames: false, keep_classnames: /^TerraViewer(?:Error)?$/, ecma: 2018,
      output: { comments: /^!|@preserve|@license|@cc_on/ }
    })
    if (result.error) throw result.error
    if (!result.code) throw new Error(`Empty SDK module: ${file}`)
    fs.writeFileSync(file, result.code + '\n')
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
