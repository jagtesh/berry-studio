# Berry Studio assets

A staged branding set inspired by the supplied glossy purple blackberry. Existing application assets and references have not been replaced.

## Contents

- `build/`: matching filenames for every current branded build asset, including `icon.png`, `logo.png`, Windows `icon.ico`, macOS `icon.icns`, and the three tray images.
- `build/icons/`: 16, 24, 32, 48, 64, 128, 256, 512, and 1024 pixel PNGs, matching the current Linux icon set.
- `build/icon.iconset/`: macOS source images at 1x and 2x resolutions.
- `renderer/`: 1024 pixel `logo.png` and `berry-text-logo.svg` for the current renderer logo slots.
- `tray/`: color, black, and white icons at 16, 20, 22, 24, 32, 40, 44, 48, 64, and 66 pixels. Black is for light backgrounds; white is for dark backgrounds. The existing macOS service marks these as template images.
- `wordmarks/`: light and dark Berry Studio wordmarks in SVG and transparent PNG at 1200 × 400 and 600 × 200.
- `web/`: favicon ICO and PNGs at 16, 32, 48, 180, 192, and 512 pixels for future web uses.
- `masters/`: untouched generated artwork and the supplied inspiration image.
- `replacement-map.json`: future destination paths mapped to files in this folder; it does not perform replacements.
- `preview.png`: full-color, wordmark, actual-size icon, and tray previews.
- `generation-prompts.txt`: prompts used with the built-in image generation tool.

## Format notes

Every exported PNG has an alpha channel. The color mark uses 4 percent total canvas padding (2 percent per side). The staged tray build assets match the existing dimensions: 66 × 66 for color, 63 × 66 for black and white. ICO contains 16, 24, 32, 48, 64, 128, and 256 pixel images; ICNS contains images through 1024 pixels.

The wordmark SVGs embed the raster berry and retain editable text using Arial with Helvetica and sans-serif fallbacks. They are not fully vector artwork. PNG wordmarks have the lettering rendered into the image.

The replacement scope is application branding. Provider logos, service logos, model avatars, and general UI symbols retain their own identities. The repository has no custom DMG background or NSIS sidebar/header artwork to replace.

The image files and original-asset hashes were verified locally. These assets have not been integrated or tested in an installed application.
