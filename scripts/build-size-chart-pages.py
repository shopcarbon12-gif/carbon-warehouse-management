#!/usr/bin/env python3
"""
Build one standalone size-chart page per fit.

One template, four data sets: the charts are the same object seen four times, so
they are generated rather than hand-copied — a wording or rounding change lands
in all four or in none.

Source values are centimetres, half the garment, laid flat, exactly as they
appear on the measurement sheet. Doubling and inch conversion happen in the page
at render time so every published figure can be traced back to the sheet.
"""

import json
import os

OUT_DIR = "/home/carbondev/CARBON JEANS COMPANY Dropbox/elior perez"

SIZES = [27, 28, 29, 30, 31, 32, 33, 34, 36, 38]

FITS = [
    {
        "file": "Slim Fit Jeans.html",
        "name": "Slim Fit Jeans",
        "min": 27,
        "max": 38,
        "blurb": "The roomiest of the four — the fullest thigh and the widest leg opening.",
        "waist":  [36.3, 37.5, 38.7, 40, 41.2, 42.5, 43.8, 45, 47.5, 50],
        "hip":    [45.1, 46.3, 47.5, 48.8, 50, 51.3, 52.6, 53.8, 56.3, 58.8],
        "length": [73.5, 76, 76, 76, 76, 81, 81, 81, 81, 81],
    },
    {
        "file": "Skinny Fit Jeans.html",
        "name": "Skinny Fit Jeans",
        "min": 29,
        "max": 38,
        "blurb": "Closer through the thigh and knee than Slim, finishing at a narrower ankle.",
        "waist":  [35.5, 35.7, 38, 39.2, 40.5, 41.7, 43, 44.2, 46.8, 49.2],
        "hip":    [43.3, 44.5, 45.8, 47, 48.3, 49.5, 50.8, 52, 54.6, 57],
        "length": [72.5, 75, 75, 75, 75, 77.5, 77.5, 77.5, 77.5, 80],
    },
    {
        "file": "Super Skinny Long Fit Jeans.html",
        "name": "Super Skinny Long Fit Jeans",
        "min": 29,
        "max": 38,
        "blurb": "The narrowest leg we cut, in the longer inseam.",
        "waist":  [33, 34.2, 35.5, 36.7, 38, 39.2, 40.5, 41.7, 44.3, 49.2],
        "hip":    [43.3, 44.5, 45.8, 47, 48.3, 49.5, 50.8, 52, 54.6, 57],
        "length": [71, 71, 71, 71, 71, 71, 71, 71, 71, 77],
    },
    {
        "file": "Super Skinny Zipper Fit Jeans.html",
        "name": "Super Skinny Zipper Fit Jeans",
        "min": 29,
        "max": 38,
        "blurb": "The same narrow leg as Super Skinny Long, cut to the shortest inseam of the four.",
        "waist":  [33, 34.2, 35.5, 36.7, 38, 39.2, 40.5, 41.7, 44.3, 49.2],
        "hip":    [43.3, 44.5, 45.8, 47, 48.3, 49.5, 50.6, 52, 54.6, 57],
        "length": [68, 68, 68, 68, 68, 68, 68, 68, 68, 74],
    },
]

TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__NAME__ — Carbon Size Guide</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;450;600&display=swap">
<style>
  :root {
    /* Cool, blue-biased neutrals — the greys of raw denim rather than a default grey. */
    --ground: #eef0f4;
    --surface: #ffffff;
    --surface-2: #f5f7fa;
    --ink: #14171d;
    --muted: #5b6472;
    --line: #d9dee7;
    --line-soft: #e7ebf1;
    --indigo: #25395e;
    --indigo-ink: #25395e;
    --indigo-wash: #e9eef7;
    /* Topstitch gold — the thread every pair of jeans is sewn with. One accent, spent once. */
    --stitch: #b8873a;
    --stitch-wash: #fbf3e3;

    --font-label: "Archivo Narrow", "Arial Narrow", Helvetica, sans-serif;
    --font-body: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --font-num: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0e1116;
      --surface: #161a21;
      --surface-2: #1b212a;
      --ink: #e9ecf2;
      --muted: #98a2b3;
      --line: #2b323d;
      --line-soft: #232932;
      --indigo: #8fb0e0;
      --indigo-ink: #a9c3e9;
      --indigo-wash: #1b2536;
      --stitch: #d8a74e;
      --stitch-wash: #2a2213;
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .page {
    max-width: 880px;
    margin: 0 auto;
    padding-inline: 16px;
    padding-block: 32px 56px;
  }

  :focus-visible {
    outline: 2px solid var(--indigo);
    outline-offset: 2px;
    border-radius: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  .guide {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 4px;
  }

  .guide__head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px 20px;
    flex-wrap: wrap;
    padding: 22px 22px 18px;
  }

  .eyebrow {
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 2px;
  }

  .guide__title {
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 27px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    margin: 0;
    text-wrap: balance;
  }

  .units {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .units button {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-family: var(--font-label);
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 8px 18px;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .units button + button { border-left: 1px solid var(--line); }
  .units button[aria-pressed="true"] { background: var(--indigo); color: var(--surface); }

  /* The one flourish: a run of topstitch under the header. */
  .stitch {
    height: 0;
    border-top: 1.5px dashed var(--stitch);
    opacity: 0.75;
    margin: 0 22px;
  }

  .fit-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
    padding: 18px 22px 0;
  }
  .fit-meta p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
    max-width: 62ch;
  }
  .range {
    font-family: var(--font-num);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--indigo-ink);
    background: var(--indigo-wash);
    border-radius: 2px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .table-wrap {
    overflow-x: auto;
    padding: 18px 22px 0;
    -webkit-overflow-scrolling: touch;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-variant-numeric: tabular-nums;
  }
  thead th {
    text-align: left;
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 14px 10px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  thead th:first-child { padding-left: 0; }
  tbody th, tbody td {
    text-align: left;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line-soft);
    white-space: nowrap;
  }
  tbody th:first-child, tbody td:first-child { padding-left: 0; }
  tbody th[scope="row"] {
    font-family: var(--font-num);
    font-weight: 600;
    font-size: 15px;
    color: var(--ink);
    width: 30%;
  }
  tbody td {
    font-family: var(--font-num);
    font-size: 14.5px;
    color: var(--muted);
  }
  tbody tr:nth-child(odd) th, tbody tr:nth-child(odd) td { background: var(--surface-2); }
  tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
  tbody tr { cursor: pointer; }
  tbody tr:hover th, tbody tr:hover td { background: var(--indigo-wash); }
  /* Tap a size to keep it marked while you read across. */
  tbody tr.row-on th, tbody tr.row-on td {
    background: var(--stitch-wash);
    color: var(--ink);
  }
  tbody tr.row-on th[scope="row"] { box-shadow: inset 3px 0 0 var(--stitch); padding-left: 10px; }

  .basis {
    margin: 0;
    padding: 14px 22px 0;
    font-size: 13px;
    color: var(--muted);
    max-width: 68ch;
  }

  .guide__foot {
    margin-top: 20px;
    border-top: 1px solid var(--line-soft);
    padding: 20px 22px 24px;
  }
  .guide__foot h2 {
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 16px;
  }
  .tips {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 22px 26px;
  }
  .tip { display: flex; flex-direction: column; gap: 10px; }
  .tip figure {
    margin: 0;
    background: var(--surface-2);
    border: 1px solid var(--line-soft);
    border-radius: 3px;
    padding: 12px;
    display: flex;
    justify-content: center;
  }
  .tip svg { width: 100%; max-width: 128px; height: auto; display: block; }
  .tip h3 {
    font-family: var(--font-label);
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0;
    color: var(--ink);
  }
  .tip p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--muted); }

  @media (max-width: 560px) {
    .guide__title { font-size: 21px; }
    .guide__head { padding: 18px 16px 15px; }
    .stitch { margin: 0 16px; }
    .fit-meta, .table-wrap, .guide__foot, .basis { padding-left: 16px; padding-right: 16px; }
    tbody th, tbody td { padding: 11px 10px; }
  }
</style>
</head>
<body>

<div class="page">
  <section class="guide" aria-labelledby="guide-title">

    <div class="guide__head">
      <div>
        <p class="eyebrow">Carbon — Size Guide</p>
        <h1 class="guide__title" id="guide-title">__NAME__</h1>
      </div>
      <div class="units" role="group" aria-label="Measurement units">
        <button type="button" data-unit="in" aria-pressed="true">In</button>
        <button type="button" data-unit="cm" aria-pressed="false">CM</button>
      </div>
    </div>

    <div class="stitch" aria-hidden="true"></div>

    <div class="fit-meta">
      <span class="range">Sizes __MIN__&ndash;__MAX__</span>
      <p>__BLURB__</p>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Numerical Size</th>
            <th scope="col">Waist</th>
            <th scope="col">Hip</th>
            <th scope="col">Length</th>
          </tr>
        </thead>
        <tbody id="chart-body"></tbody>
      </table>
    </div>

    <p class="basis" id="basis"></p>

    <div class="guide__foot">
      <h2>Measuring Tips</h2>
      <div class="tips">

        <div class="tip">
          <figure>
            <svg viewBox="0 0 128 176" role="img" aria-label="Waist measured straight across the top of the waistband">
              <path d="M24 12 L104 12 L108 62 L100 168 L78 168 L64 90 L50 168 L28 168 L20 62 Z"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity="0.32"/>
              <path d="M24 26 L104 26 M64 26 L64 44" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.32"/>
              <path d="M28 19 L100 19" fill="none" stroke="#b8873a" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M34 14 L28 19 L34 24 M94 14 L100 19 L94 24" fill="none" stroke="#b8873a" stroke-width="2.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </figure>
          <h3>Waist</h3>
          <p>Straight across the top of the waistband, from edge to edge, then doubled.</p>
        </div>

        <div class="tip">
          <figure>
            <svg viewBox="0 0 128 176" role="img" aria-label="Hip measured 16 centimetres below the waistband">
              <path d="M24 12 L104 12 L108 62 L100 168 L78 168 L64 90 L50 168 L28 168 L20 62 Z"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity="0.32"/>
              <path d="M24 26 L104 26" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.32"/>
              <path d="M64 26 L64 56" fill="none" stroke="#b8873a" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>
              <path d="M23 58 L105 58" fill="none" stroke="#b8873a" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M29 53 L23 58 L29 63 M99 53 L105 58 L99 63" fill="none" stroke="#b8873a" stroke-width="2.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </figure>
          <h3>Hip</h3>
          <p>Across the widest point, 16&nbsp;cm below the waistband, then doubled.</p>
        </div>

        <div class="tip">
          <figure>
            <svg viewBox="0 0 128 176" role="img" aria-label="Length measured from the crotch seam to the hem">
              <path d="M24 12 L104 12 L108 62 L100 168 L78 168 L64 90 L50 168 L28 168 L20 62 Z"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity="0.32"/>
              <path d="M24 26 L104 26 M64 26 L64 44" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.32"/>
              <path d="M58 90 L45 166" fill="none" stroke="#b8873a" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M53 93 L58 90 L61 96 M50 160 L45 166 L40 161" fill="none" stroke="#b8873a" stroke-width="2.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </figure>
          <h3>Length</h3>
          <p>The inseam &mdash; from the crotch seam straight down the inner leg to the hem.</p>
        </div>

      </div>
    </div>

  </section>
</div>

<script>
  /* Centimetres, half the garment, laid flat — exactly as on the measurement
     sheet. Doubling and inch conversion happen below, so every figure on the
     page can be traced back to the sheet. */
  var SIZES = __SIZES__;
  var FIT = __FIT__;

  var unit = "in";
  var activeSize = null;
  var bodyEl = document.getElementById("chart-body");
  var basisEl = document.getElementById("basis");

  /* Retail rounding: half-inches and whole centimetres. A trailing ".0" makes a
     size chart look like a spreadsheet export, so it goes. */
  function show(cm) {
    var n = unit === "cm" ? Math.round(cm) : Math.round((cm / 2.54) * 2) / 2;
    return String(n).replace(/\.0$/, "");
  }

  function render() {
    basisEl.textContent =
      "Waist and hip are measured across the jean laid flat and doubled, in " +
      (unit === "in" ? "inches" : "centimetres") +
      ". These describe the garment, not your body.";

    bodyEl.innerHTML = "";
    SIZES.forEach(function (size, i) {
      if (size < FIT.min || size > FIT.max) return;

      var tr = document.createElement("tr");
      if (activeSize === size) tr.className = "row-on";

      var th = document.createElement("th");
      th.scope = "row";
      th.textContent = size;
      tr.appendChild(th);

      [show(FIT.waist[i] * 2), show(FIT.hip[i] * 2), show(FIT.length[i])].forEach(function (v) {
        var td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      });

      tr.addEventListener("click", function () {
        activeSize = activeSize === size ? null : size;
        render();
      });
      bodyEl.appendChild(tr);
    });
  }

  document.querySelectorAll(".units button").forEach(function (b) {
    b.addEventListener("click", function () {
      unit = b.getAttribute("data-unit");
      document.querySelectorAll(".units button").forEach(function (o) {
        o.setAttribute("aria-pressed", o === b ? "true" : "false");
      });
      render();
    });
  });

  render();
</script>

</body>
</html>
"""

os.makedirs(OUT_DIR, exist_ok=True)

for fit in FITS:
    payload = {
        "min": fit["min"],
        "max": fit["max"],
        "waist": fit["waist"],
        "hip": fit["hip"],
        "length": fit["length"],
    }
    html = (
        TEMPLATE.replace("__NAME__", fit["name"])
        .replace("__MIN__", str(fit["min"]))
        .replace("__MAX__", str(fit["max"]))
        .replace("__BLURB__", fit["blurb"])
        .replace("__SIZES__", json.dumps(SIZES))
        .replace("__FIT__", json.dumps(payload))
    )
    path = os.path.join(OUT_DIR, fit["file"])
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote %-36s %6d bytes" % (fit["file"], len(html)))
