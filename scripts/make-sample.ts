/**
 * Build the sample photos: `public/samples/letter.jpg` (the demo the app loads)
 * and a larger one under `.tmp/` that only the README pictures are made from.
 *
 * Why this exists
 * ---------------
 * The demo photo used to be a 1200px snapshot of an invoice, which put the page
 * at 597px across. At that size a line of body text is about six pixels tall:
 * every Optimize pass on it looks ragged no matter how good the pipeline is, and
 * a README "after" picture built from it was a 2× blow-up of a 1-bit-looking
 * bitmap. The complaint was fair — the picture at the top of the README was
 * showing the *source*, not the scan.
 *
 * So the sample is now rendered at a size a modern phone camera actually
 * produces (a 2400×1800 photo, the sheet ~1750px across), photographed at a
 * slight angle on a warm desk, with a lamp gradient, a soft shadow under the
 * paper and a little sensor noise. Then the real pipeline runs on it exactly as
 * the app does — see `scripts/make-demo.ts`, which writes the README pictures
 * from this file.
 *
 *   npm run sample:image     # needs the devDependency @napi-rs/canvas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/* ------------------------------------------------------------------ fonts */

const FONTS: { file: string; family: string }[] = [
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "Doc" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", family: "Doc Bold" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", family: "Doc Mono" },
];
for (const font of FONTS) {
  try {
    GlobalFonts.registerFromPath(font.file, font.family);
  } catch {
    /* a machine without DejaVu: the built-ins still draw something readable */
  }
}
const has = (family: string) => GlobalFonts.families.some((f) => f.family === family);
const BODY = has("Doc") ? "Doc" : "sans-serif";
const BOLD = has("Doc Bold") ? "Doc Bold" : BODY;
const MONO = has("Doc Mono") ? "Doc Mono" : BODY;

/* ------------------------------------------------------------------- paper */

/** A4 at 200 DPI: the sheet as it would be printed. */
const PAPER_W = 1654;
const PAPER_H = 2339;
const MARGIN = 150;

/**
 * The node canvas context.
 *
 * @napi-rs/canvas implements the same 2D API with its own TypeScript types, and
 * they are stricter about `fillStyle` than the DOM lib. Everything here is typed
 * from the library, so a version bump cannot quietly disagree with us.
 */
type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  size: number,
  opts: { font?: string; align?: "left" | "right" | "center"; colour?: string } = {}
): void {
  ctx.font = `${size}px ${opts.font ?? BODY}`;
  ctx.fillStyle = opts.colour ?? "#15171b";
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
}

function rule(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, width = 2): void {
  ctx.strokeStyle = "#1b1e23";
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function drawPaper() {
  const canvas = createCanvas(PAPER_W, PAPER_H);
  const ctx = canvas.getContext("2d");
  // paper, not pure white: a page has a tone, and that is what the ink mapping
  // is built to find
  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, PAPER_W, PAPER_H);

  const left = MARGIN;
  const right = PAPER_W - MARGIN;

  // masthead
  text(ctx, "ACME SOLUTIONS LTD.", left, 260, 52, { font: BOLD });
  text(ctx, "Unit 7, Kingsway Business Park, Bristol BS1 9PG", left, 310, 25, { colour: "#3a3f46" });
  text(ctx, "VAT  GB 418 552 907  ·  hello@acme.example", left, 350, 25, { colour: "#3a3f46" });
  text(ctx, "INVOICE", right, 270, 64, { font: BOLD, align: "right" });
  text(ctx, "240801", right, 320, 34, { font: MONO, align: "right" });
  rule(ctx, left, 400, right, 400, 3);

  // bill to / dates
  text(ctx, "BILL TO", left, 470, 22, { font: BOLD, colour: "#555b63" });
  const billTo = ["Sarah Johnson", "32 High Street", "Bristol", "BS1 2AB"];
  billTo.forEach((line, i) => text(ctx, line, left, 516 + i * 40, 30));
  text(ctx, "DATE ISSUED", right, 470, 22, { font: BOLD, colour: "#555b63", align: "right" });
  text(ctx, "01 Aug 2024", right, 508, 30, { align: "right" });
  text(ctx, "PAYMENT DUE", right, 570, 22, { font: BOLD, colour: "#555b63", align: "right" });
  text(ctx, "15 Aug 2024", right, 608, 30, { align: "right" });

  // table
  const top = 700;
  const rows: [string, string, string, string, string][] = [
    ["ITEMS AND SERVICES", "DESCRIPTION", "QTY", "UNIT PRICE", "AMOUNT"],
    ["Website rebuild", "Web Development (Annual)", "1", "£1,200.00", "£1,200.00"],
    ["Hosting", "Website Hosting", "1", "£150.00", "£150.00"],
    ["Care plan", "Monthly support retainer", "1", "£270.00", "£270.00"],
  ];
  // four columns with room between them: a header that touches its neighbour is
  // the kind of thing that makes a demo page look broken before anyone reads it
  const cols = [left, left + 320, left + 760, right - 250, right];
  const rightAligned = [false, false, false, true, true];
  ctx.fillStyle = "#eceef1";
  ctx.fillRect(left, top, right - left, 70);
  ctx.textBaseline = "alphabetic";
  rows[0].forEach((label, i) =>
    text(ctx, label, cols[i], top + 46, 22, {
      font: BOLD,
      align: rightAligned[i] ? "right" : "left",
      colour: "#2a2f36",
    })
  );
  let y = top + 70;
  for (const row of rows.slice(1)) {
    rule(ctx, left, y, right, y, 2);
    row.forEach((cell, i) =>
      text(ctx, cell, cols[i], y + 52, 28, {
        font: i >= 3 ? MONO : BODY,
        align: rightAligned[i] ? "right" : "left",
      })
    );
    y += 78;
  }
  rule(ctx, left, y, right, y, 2);

  // totals
  const totalX = left + 700;
  const totalRows: [string, string, boolean][] = [
    ["Subtotal", "£1,620.00", false],
    ["VAT (20%)", "£324.00", false],
    ["TOTAL DUE", "£1,944.00", true],
  ];
  let ty = y + 70;
  for (const [label, value, strong] of totalRows) {
    const size = strong ? 32 : 28;
    // the amount column starts at the same place on every row, so the numbers
    // line up the way they would on a real invoice
    if (strong) rule(ctx, totalX, ty - 46, right, ty - 46, 3);
    text(ctx, label, totalX, ty, size, { font: strong ? BOLD : BODY });
    text(ctx, value, right, ty, size, { font: MONO, align: "right" });
    ty += strong ? 58 : 52;
  }

  // footer
  const footY = PAPER_H - 420;
  rule(ctx, left, footY, right, footY, 1);
  text(ctx, "PAYMENT", left, footY + 60, 22, { font: BOLD, colour: "#555b63" });
  const payLines = [
    "Acme Solutions Ltd · Barclays Bank",
    "Sort code 20-11-43 · Account 6045 8891",
    "Reference INV240801",
  ];
  payLines.forEach((line, i) => text(ctx, line, left, footY + 104 + i * 38, 26, { colour: "#2f343b" }));
  // Kept clear of the bottom edge: a bold line 5% from the paper's edge is a
  // strong gradient right next to the one the detector is looking for, and a
  // demo photo that is a trap for the detector is a bad demo.
  text(ctx, "Thank you for your business.", left, footY + 240, 30, { font: BOLD });
  text(
    ctx,
    "Payment is due within 14 days of the invoice date. Late payment may incur interest.",
    left,
    footY + 286,
    24,
    { colour: "#4a5058" }
  );
  return canvas;
}

/* -------------------------------------------------------------------- photo */

/** How much of the paper's 200 DPI raster the photo gives back, per pixel. */
type Shot = { w: number; h: number; fill: number };

/** How far the sheet is turned in the frame, in degrees. */
const TWIST_DEG = -1.6;

function buildPhoto({ w: PHOTO_W, h: PHOTO_H, fill }: Shot): ImageData {
  const canvas = createCanvas(PHOTO_W, PHOTO_H);
  const ctx = canvas.getContext("2d");

  // desk: warm wood, lit from the upper left
  const desk = ctx.createLinearGradient(0, 0, PHOTO_W, PHOTO_H);
  desk.addColorStop(0, "#6b5340");
  desk.addColorStop(0.45, "#5a4534");
  desk.addColorStop(1, "#3f3026");
  ctx.fillStyle = desk;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  // grain
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * PHOTO_W;
    const y = Math.random() * PHOTO_H;
    ctx.strokeStyle = `rgba(${Math.random() > 0.5 ? 255 : 0}, 220, 190, ${0.012 + Math.random() * 0.02})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 40 + Math.random() * 260, y + (Math.random() - 0.5) * 14);
    ctx.stroke();
  }

  // the sheet, as an affine mapping from paper pixels into the photo: a rotation
  // and a small shear, which is what a photo taken while standing over a desk
  // looks like
  const paper = drawPaper();
  // the sheet fills most of the frame, the way people actually shoot a document:
  // a page that occupies a quarter of the photo is a page with no resolution
  const twist = (TWIST_DEG * Math.PI) / 180;
  const scale = (PHOTO_H * fill) / PAPER_H;
  const mid = { x: PHOTO_W * 0.5, y: PHOTO_H * 0.52 };
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // the sheet's own shadow, from the canvas: one soft edge instead of the bands
  // that shift-copies of a polygon leave behind
  ctx.shadowColor = "rgba(10, 7, 3, 0.5)";
  ctx.shadowBlur = 26;
  ctx.shadowOffsetX = 12;
  ctx.shadowOffsetY = 16;
  ctx.translate(mid.x, mid.y);
  ctx.rotate(twist);
  ctx.transform(1, 0.028, 0.012, 1, 0, 0);
  ctx.scale(scale, scale);
  ctx.drawImage(paper, -PAPER_W / 2, -PAPER_H / 2);
  ctx.restore();

  const frame = ctx.getImageData(0, 0, PHOTO_W, PHOTO_H);
  const data = frame.data;

  // lamp: bright near the top left of the sheet, falling off to the right
  // A lamp, not a vignette: the fall-off is gentle on purpose. A page whose
  // bottom edge is 40% darker than its top is not a hard case for the scanner, it
  // is an underexposed photo — and a demo nobody can detect is a bad demo.
  const lamp = (x: number, y: number) => {
    const nx = x / PHOTO_W;
    const ny = y / PHOTO_H;
    return 1.06 - 0.16 * nx - 0.05 * ny + 0.03 * Math.sin(nx * 5.2 + ny * 3.1);
  };
  // deterministic grain, so rebuilding twice gives the same file
  const grain = (x: number, y: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * 9;
  };

  for (let y = 0; y < PHOTO_H; y++) {
    for (let x = 0; x < PHOTO_W; x++) {
      const i = (y * PHOTO_W + x) * 4;
      const g = lamp(x, y);
      const n = grain(x, y);
      data[i] = Math.max(0, Math.min(255, data[i] * g + n));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] * g + n));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] * g + n * 0.8));
      data[i + 3] = 255;
    }
  }
  return frame as unknown as ImageData;
}

function shoot(shot: Shot, quality: number): Buffer {
  const photo = buildPhoto(shot);
  return jpeg.encode(
    { data: Buffer.from(photo.data), width: photo.width, height: photo.height },
    quality
  ).data;
}

mkdirSync("public/samples", { recursive: true });
mkdirSync(".tmp", { recursive: true });

/**
 * The demo the app loads.
 *
 * 2400×1800 is what a "12 MP" phone photo looks like after the app's own import
 * cap, and it is precached for offline use, so it must not grow much: 5 MP at
 * quality 82 lands around 600 kB. The sheet fills 0.86 of the frame, which puts
 * the page at ~1750 px on its long side — 210 DPI, the way a hand-held photo of
 * an A4 sheet comes out.
 */
const demo = shoot({ w: 2400, h: 1800, fill: 0.86 }, 82);
writeFileSync("public/samples/letter.jpg", demo);

/**
 * The one the README pictures are made from — not shipped, not precached.
 *
 * A phone with a 12 MP camera hands the app a 3600 px photo, and that is the
 * resolution the README is *supposed* to show: at 2400 the page would be 1750 px
 * and the crop in a README column would be an enlargement, which is exactly the
 * softness that made the old pictures useless as evidence.
 */
const hires = shoot({ w: 3400, h: 2550, fill: 0.9 }, 88);
writeFileSync(".tmp/letter-hi.jpg", hires);

/**
 * The corners the demo photo was composed with, in photo pixels.
 *
 * Printed, not hard-coded somewhere else: `scripts/test-cv.ts` asserts the
 * detector against these numbers, and a detector that is "within 25px" of an
 * eyeballed guess is not a test at all.
 */
const truth = (shot: Shot) => {
  const scale = (shot.h * shot.fill) / PAPER_H;
  const mid = { x: shot.w * 0.5, y: shot.h * 0.52 };
  // the same transforms buildPhoto applies: translate → rotate → shear → scale
  const t = (TWIST_DEG * Math.PI) / 180;
  const rot = [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t)]; // a, b, c, d
  const shear = [1, 0.028, 0.012, 1];
  const [ra, rb, rc, rd] = rot;
  const [sa, sb, sc, sd] = shear;
  const m = [sa * ra + sc * rb, sb * ra + sd * rb, sa * rc + sc * rd, sb * rc + sd * rd];
  const map = (x: number, y: number) => {
    const px = x * scale;
    const py = y * scale;
    return { x: m[0] * px + m[2] * py + mid.x, y: m[1] * px + m[3] * py + mid.y };
  };
  return [
    [-PAPER_W / 2, -PAPER_H / 2],
    [PAPER_W / 2, -PAPER_H / 2],
    [PAPER_W / 2, PAPER_H / 2],
    [-PAPER_W / 2, PAPER_H / 2],
  ].map(([x, y]) => {
    const p = map(x, y);
    return `{ x: ${p.x.toFixed(1)}, y: ${p.y.toFixed(1)} }`;
  });
};

console.log(
  `public/samples/letter.jpg ${2400}×${1800} (${Math.round(demo.length / 1024)} kB)\n` +
    `.tmp/letter-hi.jpg       ${3400}×${2550} (${Math.round(hires.length / 1024)} kB)\n` +
    `corners: ${truth({ w: 2400, h: 1800, fill: 0.86 }).join(", ")}`
);
