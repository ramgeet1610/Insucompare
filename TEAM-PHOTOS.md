# Team photos (this file is not published — it lives outside /public on purpose)

Drop the three team photos in this folder, then point each `photo` field in the
`TEAM` array at the top of the About section in `src/FEHBComparison.jsx` at them.

    photo: '/team/jane-doe.jpg'

The leading slash matters — it resolves from the site root, not from this folder.

Specs:
- Square (1:1). The card crops to a circle, so anything off-square gets cut.
- At least 320x320px. 640x640 is better for high-DPI screens.
- JPG or WebP. Keep each file under ~150KB so the About page stays fast.

If a `photo` is left as `null`, or the file is missing, the card falls back to the
person's initials on a navy circle. The layout does not break either way, so it is
safe to ship with photos for only some of the three.
