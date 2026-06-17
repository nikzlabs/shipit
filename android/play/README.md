# Play Store assets

Listing assets for the Google Play Console. These are uploaded by hand in the
Console (Store listing → Main store listing); they are not part of the Gradle
build.

| File | Use | Spec |
|------|-----|------|
| `icon.svg` | Source for the high-res icon (editable). | 512×512 viewBox, full-bleed. |
| `icon-512.png` | **App icon** — upload this to the Console. | 512×512, 32-bit PNG. |

The icon matches the app launcher icon and the web favicon
(`src/client/public/favicon.svg`): a red gradient tile (`#F0506E` → `#B8294B`)
with a white rocket knockout. Unlike the favicon, it is **full-bleed** — no
margin and no rounded corners — because Play applies its own rounding, shadow,
and masking to the listing icon.

## Regenerating the PNG

Edit `icon.svg`, then rasterize:

```bash
cd android/play
python3 -c "import cairosvg; cairosvg.svg2png(url='icon.svg', write_to='icon-512.png', output_width=512, output_height=512)"
# (pip install cairosvg — or use rsvg-convert / Inkscape if you have them)
```

## Still needed for the listing

The Console also requires a **feature graphic** (1024×500), **≥2 phone
screenshots**, and a **privacy policy URL**. Screenshots are best captured from
a real device/emulator running the app; they are not committed here.
