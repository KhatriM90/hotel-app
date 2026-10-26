# YeaStay logo pack — Doorway mark

YeaStay — hotel, restaurant & bar platform by Yeasoft Solutions.
All text is converted to outlines, so no font needs to be installed to use these files.

## Files

| Folder | File | Use |
|---|---|---|
| svg/ | yeastay-logo.svg | Main logo on white or light backgrounds |
| svg/ | yeastay-logo-white.svg | On dark backgrounds (Night #0B2E31, photos) |
| svg/ | yeastay-logo-black.svg | One-colour: thermal receipts, stamps, fax/photocopy |
| svg/ | yeastay-logo-tagline(-white).svg | Marketing, proposals, login screen |
| svg/ | yeastay-mark(-white/-black).svg | Mark only: app header, small spaces |
| svg/ | yeastay-app-icon.svg | Source for app icons |
| png/ | *-120h / -160h / -480h / -512h.png | Transparent PNGs at those heights |
| app-icons/ | favicon.ico, icon-32.png | Browser tab |
| app-icons/ | icon-192.png, icon-512.png, icon-maskable-512.png | PWA manifest (waiter tablets, housekeeping phones) |
| app-icons/ | apple-touch-icon.png | iPhone/iPad home screen |

## Colours

| Name | Hex | Use |
|---|---|---|
| Ocean teal | #0E4D52 | Primary: logo, buttons, headers |
| Night | #0B2E31 | Dark backgrounds, body text |
| Sunset amber | #E8A33D | Accent: the sun in the mark, highlights (not for text on white) |
| Slate grey | #4F6264 | Secondary text, tagline |
| Mist | #A9C4C6 | Tagline/secondary text on dark backgrounds |

## Typeface

Outfit (Google Fonts, SIL Open Font License) — "Yea" Regular 400, "Stay" Bold 700. Use Outfit for app headings; any clean sans (Inter, system UI) works for body text.

## Usage rules

- Keep clear space around the logo of at least the width of the sun dot ×2 on every side.
- Minimum size: mark 16 px tall on screen; full logo 24 px tall on screen, 10 mm wide in print.
- Don't recolour the sun dot except in the one-colour version, stretch, rotate, add shadows or outline the logo.
- On hotel guest documents (folios, receipts, invoices) the property's own name leads; use a small "Powered by YeaStay" with the black mark in the footer.

## Web manifest snippet

```json
{
  "name": "YeaStay",
  "short_name": "YeaStay",
  "theme_color": "#0E4D52",
  "background_color": "#FFFFFF",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
