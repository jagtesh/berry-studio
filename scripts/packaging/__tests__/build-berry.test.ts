import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMockApplication } from '@test-mocks/main/application'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prepareBerryBuild } = require('../build-berry.js')
const roots: string[] = []
const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8')
function write(root: string, file: string, value: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), value)
}

// Catches source branding/identity changes, missed hashed images, and packaging hooks losing Berry overrides.
describe('output-only Berry branding', () => {
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

  it('brands compiled assets and packaged resources while preserving source bytes and settings identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'berry-build-'))
    roots.push(root)
    const config = {
      appId: 'com.kangfenmao.CherryStudio',
      productName: 'Cherry Studio',
      directories: { buildResources: 'build' },
      protocols: [{ name: 'Cherry Studio', schemes: ['cherrystudio'] }],
      extraMetadata: { cherryEdition: 'global' },
      mac: {},
      win: { executableName: 'Cherry Studio' },
      linux: { executableName: 'CherryStudio' },
      beforePack: 'scripts/packaging/before-pack.js',
      afterPack: 'scripts/packaging/after-pack.js',
      files: ['**/*']
    }
    write(root, 'electron-builder.yml', JSON.stringify(config))
    write(root, 'package.json', '{"name":"CherryStudio"}')
    const replacements = {
      'build/icon.png': 'build/icon.png',
      'src/renderer/assets/images/logo.png': 'renderer/logo.png',
      'src/renderer/assets/images/cherry-text-logo.svg': 'renderer/berry-text-logo.svg'
    }
    write(root, 'assets/berry-studio/replacement-map.json', JSON.stringify(replacements))
    for (const [destination, source] of Object.entries(replacements)) {
      write(root, destination, `original ${destination}`)
      write(root, `assets/berry-studio/${source}`, `berry ${source}`)
      write(root, `out/${path.basename(destination)}-hash`, `original ${destination}`)
    }
    write(root, 'build/entitlements.mac.plist', 'original entitlement')
    write(
      root,
      'out/main/main.js',
      'application.initPathRegistry();\nconst name="Cherry Studio"; const db="CherryStudio"; const id="com.kangfenmao.CherryStudio"; const metadata = { appName: "Cherry Studio" }; function restore(raw) { if (raw.appName !== "Cherry Studio") throw new Error("This backup file is not from Cherry Studio"); return raw; }'
    )
    write(root, 'out/renderer/index.html', '<title>Cherry Studio</title>')
    write(root, 'out/provider.png', 'provider image')
    write(
      root,
      'scripts/packaging/before-pack.js',
      "exports.default = async c => { c.packager.config.files[0].filter = ['**/*']; c.before = true }"
    )
    write(root, 'scripts/packaging/after-pack.js', 'exports.default = async c => { c.after = true }')
    const generated = JSON.parse(readFileSync(prepareBerryBuild(root), 'utf8'))
    expect(generated).toMatchObject({
      appId: config.appId,
      productName: 'Berry Studio',
      extraMetadata: config.extraMetadata,
      protocols: [{ name: 'Berry Studio', schemes: ['cherrystudio'] }],
      win: { executableName: 'Berry Studio' }
    })
    expect(read(root, 'out/main/main.js')).toContain(
      'const name="Berry Studio"; const db="CherryStudio"; const id="com.kangfenmao.CherryStudio"'
    )
    const captured: string[] = []
    let runtimeName = 'CherryStudio'
    let userData = '/profile/CherryStudio'
    const application = createMockApplication()
    application.initPathRegistry.mockImplementation(() => {
      captured.push(userData)
    })
    application.getPath.mockImplementation((key: string) => {
      if (key !== 'app.userdata') throw new Error('Unexpected path key')
      return captured[0]
    })
    const runtime = {
      application,
      require: () => ({
        app: {
          setName: (name: string) => {
            runtimeName = name
            userData = `/profile/${name}`
          },
          setPath: (key: string, value: string) => {
            if (key === 'userData') userData = value
          }
        }
      })
    }
    new Function('application', 'require', read(root, 'out/main/main.js'))(runtime.application, runtime.require)
    expect(runtimeName).toBe('Berry Studio')
    expect(userData).toBe('/profile/CherryStudio')
    const backup = new Function(
      'application',
      'require',
      read(root, 'out/main/main.js') + '; return { metadata, restore };'
    )(runtime.application, runtime.require)
    expect(backup.metadata.appName).toBe('Cherry Studio')
    expect(backup.restore({ appName: 'Cherry Studio' })).toEqual({ appName: 'Cherry Studio' })
    expect(() => backup.restore({ appName: 'unrelated' })).toThrow('This backup file is not from Berry Studio')
    expect(read(root, 'out/renderer/index.html')).toBe('<title>Berry Studio</title>')
    expect(read(root, 'out/provider.png')).toBe('provider image')
    for (const [destination, source] of Object.entries(replacements)) {
      expect(read(root, destination)).toBe(`original ${destination}`)
      expect(read(root, `out/${path.basename(destination)}-hash`)).toBe(`berry ${source}`)
    }
    expect(read(root, 'electron-builder.yml')).toBe(JSON.stringify(config))
    expect(read(root, 'package.json')).toBe('{"name":"CherryStudio"}')
    expect(readFileSync(path.join(generated.directories.buildResources, 'entitlements.mac.plist'), 'utf8')).toBe(
      'original entitlement'
    )
    expect(readFileSync(path.join(generated.directories.buildResources, 'icon.png'), 'utf8')).toBe(
      'berry build/icon.png'
    )
    const context = {
      packager: { config: { files: [{ filter: [] }] }, appInfo: { productFilename: 'Berry Studio' } },
      electronPlatformName: 'darwin',
      appOutDir: path.join(root, 'dist'),
      before: false,
      after: false
    }
    await require(generated.beforePack).default(context)
    expect(context.before).toBe(true)
    expect(context.packager.config.files[0].filter).toContain('!assets/berry-studio/**')
    const resource = 'dist/Berry Studio.app/Contents/Resources/app.asar.unpacked/resources/guide.md'
    write(root, resource, 'Welcome to Cherry Studio. Storage: .cherrystudio')
    await require(generated.afterPack).default(context)
    expect(context.after).toBe(true)
    expect(read(root, resource)).toBe('Welcome to Berry Studio. Storage: .cherrystudio')
    prepareBerryBuild(root)
    expect(read(root, 'out/icon.png-hash')).toBe('berry build/icon.png')
  })
})
