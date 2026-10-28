# Shrink — icon studies

Candidate icons for a future tool that shrinks videos and photos in the browser.
They exist here so the icon can sit next to Scano's in one row without the two
looking like different products.

The family is a rule, not a shape:

- a near-black plate with the same subtle vignette as `public/icon.svg`;
- one white object (paper, photo, file) as the thing being worked on;
- amber `#ffc061` used **only** for the action;
- thick, rounded, flat geometry — no text, no letterforms, no photographic detail.

Scano frames the sheet ("capture it"). Shrink squeezes it ("make it smaller").

## The two finalists

| file | reading | why |
|---|---|---|
| `shrink-concentric.svg` | two amber frames with a white core | calmest; still three separate rings at 48 px; sits best next to Scano |
| `shrink-arrows.svg` | sheet surrounded by four inward arrows | says the function without a word; better for store listings and social |

Both are hand-written SVG (not traced from a render), so they stay sharp at every
size and can be recoloured by editing one gradient. Renders at 512, 192 (manifest),
180 (Apple touch), 96, 64 and 48 px ship next to them.

## The ten studies

`overview.jpg` is the contact sheet of all ten; the individual files are
`shrink-01-arrows.jpg` … `shrink-10-stack.jpg`. They come from a text-to-image
model, so they are ideas, not assets: 04 and 06 have light blooms that would have
to be redrawn, and the geometry is approximate. `concepts-at-96-64-48.png` shows
five of them at real home-screen size — that is the test most icon sketches fail.

Scores at 48 px, from that sheet: 01, 05 and 09 hold; 03 and 10 smear into one
blob; 02 turns its glow into mush.

## Not in here

No maskable variant yet (Android crops a circle out of the icon, so the artwork
needs an 80% safe zone). Add `icon-maskable.svg` at the same time as the app's own
manifest.
