const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parse } = require('yaml')

const brandText = (text) =>
  text.replace(
    /((?:\bappName\s*:|\b[\w$.]+\.appName\s*(?:===|!==))\s*["'])Cherry Studio(["'])|Cherry Studio/g,
    (_, prefix, suffix) => (prefix ? `${prefix}Cherry Studio${suffix}` : 'Berry Studio')
  )
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file, visit)
    else if (entry.isFile()) visit(file)
  }
}

/** Rebrand generated output only; package identity and source assets stay intact. */
function rebrandDirectory(root, directory) {
  const assets = path.join(root, 'assets/berry-studio')
  const replacements = JSON.parse(fs.readFileSync(path.join(assets, 'replacement-map.json'), 'utf8'))
  const images = new Map(
    Object.entries(replacements).map(([destination, source]) => [
      hash(fs.readFileSync(path.join(root, destination))),
      fs.readFileSync(path.join(assets, source))
    ])
  )
  const rebrand = (file) => {
    const bytes = fs.readFileSync(file)
    const image = images.get(hash(bytes))
    if (image) fs.writeFileSync(file, image)
    else if (/\.(?:js|cjs|mjs|json|html|css|md|txt|svg)$/.test(file)) {
      const original = bytes.toString('utf8')
      const branded = brandText(original)
      if (branded !== original) fs.writeFileSync(file, branded)
    }
  }

  // Retain emitted asset filenames so every compiled import keeps resolving.
  walk(directory, rebrand)
}

function prepareBerryBuild(root) {
  const assets = path.join(root, 'assets/berry-studio')
  const replacements = JSON.parse(fs.readFileSync(path.join(assets, 'replacement-map.json'), 'utf8'))
  const stage = path.join(root, '.context/cherry-electron-dev/berry-build')
  rebrandDirectory(root, path.join(root, 'out'))
  const mainPath = path.join(root, 'out/main/main.js')
  const main = fs.readFileSync(mainPath, 'utf8')
  if (!main.includes('const berryUserDataPath =')) {
    const anchor = /^([\w$.]+)\.initPathRegistry\(\);$/m
    if (!anchor.test(main)) throw new Error('Cannot locate preboot path initialization in the main build.')
    fs.writeFileSync(
      mainPath,
      main.replace(
        anchor,
        (statement, application) => `${statement}
const berryUserDataPath = ${application}.getPath('app.userdata');
require('electron').app.setName('Berry Studio');
require('electron').app.setPath('userData', berryUserDataPath);`
      )
    )
  }
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  fs.cpSync(path.join(root, 'build'), path.join(stage, 'build'), { recursive: true })
  for (const [destination, source] of Object.entries(replacements)) {
    if (destination.startsWith('build/')) {
      fs.copyFileSync(path.join(assets, source), path.join(stage, destination))
    }
  }

  const config = JSON.parse(
    brandText(JSON.stringify(parse(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))))
  )
  config.directories.buildResources = path.join(stage, 'build')
  config.directories.output = path.join(root, 'dist/berry')
  config.mac.icon = path.join(stage, 'build/icon.icns')
  config.win.icon = path.join(stage, 'build/icon.ico')
  config.linux.icon = path.join(stage, 'build/icons')
  config.linux.executableName = 'BerryStudio'
  const beforePack = path.join(stage, 'before-pack.cjs')
  fs.writeFileSync(
    beforePack,
    `exports.default = async (context) => {
  await require(${JSON.stringify(path.join(root, config.beforePack))}).default(context)
  context.packager.config.files[0].filter.push('!assets/berry-studio/**')
}
`
  )
  config.beforePack = beforePack
  const afterPack = path.join(stage, 'after-pack.cjs')
  fs.writeFileSync(
    afterPack,
    `exports.default = async (context) => {
  await require(${JSON.stringify(path.join(root, config.afterPack))}).default(context)
  const app = context.electronPlatformName === 'darwin'
    ? require('node:path').join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents')
    : context.appOutDir
  const resources = require('node:path').join(app, context.electronPlatformName === 'darwin' ? 'Resources' : 'resources', 'app.asar.unpacked', 'resources')
  if (require('node:fs').existsSync(resources)) {
    require(${JSON.stringify(__filename)}).rebrandDirectory(${JSON.stringify(root)}, resources)
  }
}
`
  )
  config.afterPack = afterPack
  const configPath = path.join(stage, 'electron-builder.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  return configPath
}

function run(root, args) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} failed (${result.signal ?? result.status})`)
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..')
  const args = process.argv.slice(2)
  if (args.some((arg) => /^--(?:config|publish)(?:=|$)/.test(arg) || /^-[cp]$/.test(arg))) {
    throw new Error('The Berry build owns its packaging config and does not publish artifacts.')
  }
  run(root, ['build'])
  const configPath = prepareBerryBuild(root)
  run(root, ['exec', 'dotenv', '--', 'electron-builder', '--config', configPath, '--publish', 'never', ...args])
}

exports.prepareBerryBuild = prepareBerryBuild
exports.rebrandDirectory = rebrandDirectory
