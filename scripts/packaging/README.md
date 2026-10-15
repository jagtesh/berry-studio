# Electron packaging hooks

`electron-builder.yml` registers the hooks in this directory:

- `before-pack.js`: prepares target native dependencies and bundled binaries, then filters foreign platform files.
- `after-pack.js`: installs the target Computer Use runtime from the SDK's matching npm platform package outside ASAR before signing, adjusts packaged license files and installs the pinned Linux SQLite artifact. Missing helpers or mismatched SDK/runtime versions fail the build; `.context` is only for development.
- `notarize.js`: notarizes the signed macOS application when credentials are configured.
- `mac-sign.js`: preserves the Electron signing policy and assigns empty entitlements to the system speech helper.
- `win-sign.js`: validates and signs Windows artifacts.
- `artifact-build-completed.js`: normalizes public release artifact names.

Native source compilation belongs alongside its platform code in `native/<platform>/`.
Shared binary download and Linux compatibility tooling remain in `scripts/download-binaries.js`
and `scripts/linux-native/`, since development and standalone validation also use them.

## Local Berry Studio builds

Run `node scripts/packaging/build-berry.js --mac --arm64 --dir` for an unpacked
macOS Apple Silicon app. Add `--config.mac.identity=-` for local ad-hoc signing,
or pass the normal electron-builder target flags (for
example `--mac --arm64` for DMG/ZIP, or `--win --x64`). Artifacts go to `dist/berry`.

The script runs the normal build, then replaces the display name and matching
app/logo/tray images in compiled output using `assets/berry-studio/replacement-map.json`.
It stages platform icons and a packaging config under
`.context/cherry-electron-dev/berry-build`, preserving the existing packaging hooks.
Packaged runtime resources are renamed after copying, before signing. It does not
publish or install the app.

Source files, source icons, `package.json` name, `com.*` app IDs, the URL scheme,
and data paths remain unchanged. Berry shares Cherry's settings and single-instance
lock. The normal build regenerates Cherry output; only this script produces Berry
branding. Do not run normal and Berry builds concurrently in the same checkout.

Backup metadata retains its Cherry Studio format identifier so existing backups
remain compatible; user-visible backup messages use the Berry Studio name.
