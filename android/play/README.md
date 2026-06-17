# Play Store assets

Listing assets for the Google Play Console. These are uploaded by hand in the
Console (Store listing → Main store listing); they are not part of the Gradle
build.

| File | Use | Spec |
|------|-----|------|
| `icon.svg` | Source for the high-res icon (editable). | 512×512 viewBox, full-bleed. |
| `icon-512.png` | **App icon** — upload this to the Console. | 512×512, 32-bit PNG. |
| `feature-graphic.svg` | Source for the feature graphic (editable). | 1024×500 viewBox. |
| `feature-graphic-1024x500.png` | **Feature graphic** — upload this to the Console. | 1024×500 PNG. |

Both match the app launcher icon and the web favicon
(`src/client/public/favicon.svg`): a red gradient tile (`#F0506E` → `#B8294B`)
with a white rocket knockout. Unlike the favicon, the icon is **full-bleed** — no
margin and no rounded corners — because Play applies its own rounding, shadow,
and masking to the listing icon.

## Regenerating the PNGs

Edit the `.svg`, then rasterize (`pip install cairosvg`, or use
`rsvg-convert` / Inkscape if you have them):

```bash
cd android/play
python3 -c "import cairosvg; cairosvg.svg2png(url='icon.svg', write_to='icon-512.png', output_width=512, output_height=512)"
python3 -c "import cairosvg; cairosvg.svg2png(url='feature-graphic.svg', write_to='feature-graphic-1024x500.png', output_width=1024, output_height=500)"
```

## Privacy policy

The privacy policy lives at [`../PRIVACY.md`](../PRIVACY.md) and is served
publicly via its GitHub URL — paste that URL into the Console's "Privacy policy"
field. See the main `android/README.md`.

## Still needed for the listing

The Console also requires **≥2 phone screenshots**. These are best captured from
a real device/emulator running the app, so they are not committed here.
