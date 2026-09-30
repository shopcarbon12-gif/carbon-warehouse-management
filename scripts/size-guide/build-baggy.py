#!/usr/bin/env python3
"""
Build the Men's Baggy size guide.

It shares the other four guides' stylesheet, scoped to its own id, and adds only
what the extra measurements need. Two differences from the other four are
deliberate and load-bearing:

  * The supplied figures are garment WIDTHS and are published as given. The other
    four store half-garment measurements and double them in the UI; doing that
    here would turn a 46.5 cm waist into 93 cm.

  * Six measurements do not fit one readable row at this modal width, so the
    chart is split into two four-column tables on desktop and becomes a size
    picker with a detail panel on a phone.

Only the centimetre values are stored. Inches are derived at render time, so
there is one table of numbers rather than two that can drift apart.
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/home/carbondev/dev/carbon-warehouse-management/theme/snippets/carbon-size-guide-baggy.liquid"
ROOT = "carbon-size-guide-baggy"

CSS_BASE = open(os.path.join(HERE, "style.css"), encoding="utf-8").read()

TITLE = "Men&rsquo;s Baggy Fit Jeans"
SUBTITLE = "A relaxed baggy fit with extra room through the seat, thigh and leg."

# Centimetres, exactly as supplied. Front rise at size 33 is a range and stays a
# range. Nothing here is recalculated or interpolated.
MEASURED_REFERENCE = 33
ROWS = [
    # size, waist, hip,  thigh, inseam, front rise, leg opening
    (30, "42.8", "61.3", "34.2", "80", "34.6",  "23"),
    (31, "44.0", "62.5", "34.8", "80", "34.9",  "23.5"),
    (32, "45.3", "63.8", "35.4", "80", "35.2",  "24"),
    (33, "46.5", "65.0", "36.0", "80", "35-36", "24.5"),
    (34, "47.8", "66.3", "36.6", "80", "35.8",  "25"),
    (36, "50.3", "68.8", "37.8", "80", "36.4",  "26"),
    (38, "52.8", "71.3", "39.0", "80", "37.0",  "27"),
]

KEYS = ["waist", "hip", "thigh", "inseam", "rise", "leg"]
LABELS = {"waist": "Waist", "hip": "Hip", "thigh": "Thigh",
          "inseam": "Inseam", "rise": "Front Rise", "leg": "Leg Opening"}

CARDS = [
    ("1", "Waist", "carbon-size-guide-waist.webp", "",
     "Jeans laid flat with a measuring tape straight across the top waistband",
     "Measure straight across the top waistband, from edge to edge."),
    ("2", "Hip", "carbon-size-guide-hip.webp", "",
     "Jeans laid flat with a measuring tape across the widest hip area",
     "Measure across the widest point, about 16&nbsp;cm / 6.3&nbsp;in below the waistband."),
    ("3", "Inseam", "carbon-size-guide-inseam.webp", "",
     "Full pair of jeans laid flat with a measuring tape running from the crotch seam to the bottom hem along the inner leg",
     "Measure from the crotch seam all the way down the inner leg to the hem."),
]

TIPS = ["Use a soft measuring tape", "Keep the tape straight (not angled)",
        "Compare with a pair you already own"]

TICK = ('<svg class="csg-tick" width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" focusable="false">'
        '<circle cx="8.5" cy="8.5" r="8.5" fill="currentColor"/>'
        '<path d="M4.6 8.7l2.6 2.6 5.2-5.2" fill="none" stroke="#fff" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round"/></svg>')

TAPE = ('<svg width="44" height="30" viewBox="0 0 60 40" fill="none" stroke="currentColor" '
        'stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
        '<ellipse cx="15" cy="12.5" rx="12.5" ry="8.5"/>'
        '<path d="M2.5 12.5v9.5c0 4.7 5.6 8.5 12.5 8.5s12.5-3.8 12.5-8.5v-9.5"/>'
        '<ellipse cx="15" cy="12.5" rx="6" ry="4"/>'
        '<path d="M18.6 11.6c-.5-1.1-1.9-1.7-3.4-1.5-1.4.2-2.4 1-2.3 1.9.1.8 1.2 1.3 2.4 1.1"/>'
        '<path d="M27.5 18.4h24c2 0 3.2 1 3.2 2.6v6.6c0 1.6-1.2 2.6-3.2 2.6-3.6 0-6-1.4-9.4-1.6"/>'
        '<path d="M6.5 24v4.2M11 25.4v4.8M15.5 25.8v5M20 25.4v4.8M24.5 24v4.2"/>'
        '<path d="M31 20.8v4.6M36 20.8v5.6M41 20.8v4.6M46 20.8v5.6M51 20.8v4.6"/></svg>')

CHEV = ('<svg class="csg-chev" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true" focusable="false">'
        '<path d="M1 1l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')


def scope(css: str, root: str) -> str:
    """Prefix every selector with the component id. Leading comments are lifted
    out rather than folded into the selector, which would void the rule."""
    def fix(m):
        sel, lead = m.group(1), ""
        while True:
            c = re.match(r"\s*(/\*.*?\*/)", sel, re.S)
            if not c:
                break
            lead += c.group(1) + "\n"
            sel = sel[c.end():]
        parts = []
        for s in sel.split(","):
            s = " ".join(s.split())
            if not s:
                continue
            if s == ":scope":
                parts.append("#" + root)
            elif s.startswith(":scope"):
                parts.append("#" + root + " " + s[len(":scope"):].strip())
            else:
                parts.append("#" + root + " " + s)
        return (lead + ", ".join(parts) + " {") if parts else m.group(0)

    out = []
    for chunk in re.split(r"(@media[^{]+\{)", css):
        out.append(chunk if chunk.startswith("@media") else re.sub(r"([^{}]+)\{", fix, chunk))
    return "".join(out)


EXTRA_CSS = """
/* ── Baggy only ──────────────────────────────────────────────────────────
   Six measurements will not sit in one readable row at this modal width, so
   the chart is two four-column tables — the same table component twice, not a
   new one — and a phone gets a size picker with a detail panel instead. */
.csg-chart2 { margin-top: 22px; }
.csg-sub-h { margin: 0 0 10px; font-family: var(--csg-display); font-weight: 600;
  font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: var(--csg-muted); }
.csg-ref { font-size: 11px; font-weight: 600; color: var(--csg-blue); margin-left: 5px; vertical-align: super; }
.csg-graded { margin: 12px 2px 0; font-size: 12.5px; line-height: 1.5; color: #6b7280; max-width: 62ch; }

/* phone: size picker + detail panel, hidden on desktop */
.csg-picker-b { display: none; }
.csg-sizes { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.csg-size {
  appearance: none; cursor: pointer; background: #fff; color: var(--csg-ink);
  border: 1px solid var(--csg-line); border-radius: 10px; padding: 11px 0; min-width: 58px;
  font-family: var(--csg-display); font-weight: 600; font-size: 17px; flex: 1 0 58px;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.csg-size[aria-pressed="true"] { background: var(--csg-blue); border-color: var(--csg-blue); color: #fff; }
.csg-detail { border: 1px solid var(--csg-line); border-radius: 12px; padding: 14px; }
.csg-detail-h { margin: 0 0 12px; font-family: var(--csg-display); font-weight: 700;
  font-size: 20px; letter-spacing: .04em; text-transform: uppercase; }
.csg-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.csg-detail-grid > div { min-width: 0; }
.csg-detail-k { display: block; font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--csg-muted); }
.csg-detail-v { display: block; font-family: var(--csg-display); font-weight: 600; font-size: 20px; margin-top: 2px; }
"""

PHONE_CSS = """
@media (max-width: 680px) {
  #ROOT .csg-chart, #ROOT .csg-chart2 { display: none; }
  #ROOT .csg-picker-b { display: block; order: 5; grid-column: 1; }
  #ROOT .csg-measure { order: 6; }
  #ROOT .csg-tips { order: 7; }
}
@media (max-width: 380px) {
  /* Two columns of label + value stop fitting; one keeps every figure whole. */
  #ROOT .csg-detail-grid { grid-template-columns: 1fr; }
}
""".replace("#ROOT", "#" + ROOT)


def cells(row, keys):
    return "".join(
        '<td data-csg-cell="%s">%s</td>' % (k, row[KEYS.index(k) + 1].rstrip("0").rstrip(".") if "." in row[KEYS.index(k) + 1] and "-" not in row[KEYS.index(k) + 1] else row[KEYS.index(k) + 1].replace("-", "&ndash;"))
        for k in keys)


def data_attrs(row):
    return " ".join('data-cm-%s="%s"' % (k, row[i + 1]) for i, k in enumerate(KEYS))


def table(keys, caption_keys):
    heads = "".join(
        '<th scope="col"><span>%s</span><span class="csg-th-unit" data-csg-unitlabel>(cm)</span></th>' % LABELS[k]
        for k in keys)
    body = ""
    for row in ROWS:
        size = row[0]
        ref = '<span class="csg-ref" title="Measured reference size">&#9679;</span>' if size == MEASURED_REFERENCE else ""
        body += ('<tr data-csg-row="%d" %s aria-selected="false" tabindex="0">'
                 '<th scope="row">%d%s</th>%s</tr>' % (size, data_attrs(row), size, ref, cells(row, keys)))
    return ('<table class="csg-table"><thead><tr><th scope="col">Size</th>%s</tr></thead>'
            '<tbody>%s</tbody></table>' % (heads, body))


cards = "".join(
    '<article class="csg-card"><p class="csg-card-head"><span class="csg-badge">%s</span>'
    '<span class="csg-card-name">%s</span></p>'
    '<figure class="csg-figure"><img class="csg-photo%s" src="{{ \'%s\' | asset_url }}" alt="%s"'
    ' width="%d" height="%d" loading="lazy" decoding="async"></figure>'
    '<p class="csg-card-text">%s</p></article>'
    % (num, name, extra, asset, alt,
       1024 if "inseam" in asset else 1100, 1536 if "inseam" in asset else 825, text)
    for num, name, asset, extra, alt, text in CARDS)

tips = "".join("<li>%s<span>%s</span></li>" % (TICK, t) for t in TIPS)
size_buttons = "".join(
    '<button type="button" class="csg-size" data-csg-size="%d" aria-pressed="%s">%d</button>'
    % (r[0], "true" if r[0] == MEASURED_REFERENCE else "false", r[0]) for r in ROWS)
detail_cells = "".join(
    '<div><span class="csg-detail-k">%s</span><span class="csg-detail-v" data-csg-detail="%s">&mdash;</span></div>'
    % (LABELS[k], k) for k in KEYS)

css = scope(CSS_BASE + EXTRA_CSS, ROOT).replace("__TITLESIZE__", "clamp(20px, 3.1vw, 44px)") + PHONE_CSS

HTML = """<!-- CARBON interactive size guide: Men's Baggy Fit Jeans (metafield key: baggy) -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap">
<div id="__ROOT__" class="carbon-size-guide" data-fit="baggy">
<style>
__CSS__
</style>

  <div class="csg-top">
    <p class="csg-wordmark">Carbon</p>
    <h2 class="csg-title">
      <span class="csg-title-fit">__TITLE__</span><span class="csg-title-sub">Size Guide</span>
    </h2>
    <span class="csg-rule" aria-hidden="true"></span>
  </div>

  <div class="csg-units" role="group" aria-label="Measurement units">
    <button type="button" class="csg-unit" data-csg-unit="in" aria-pressed="true">In</button>
    <button type="button" class="csg-unit" data-csg-unit="cm" aria-pressed="false">CM</button>
  </div>

  <p class="csg-subtitle">__SUBTITLE__</p>

  <section class="csg-chart" aria-label="Size chart">
    __TABLE1__
    <div class="csg-chart2">
      <h3 class="csg-sub-h">More measurements</h3>
      __TABLE2__
    </div>
    <p class="csg-graded">
      <span class="csg-ref" aria-hidden="true">&#9679;</span> Size&nbsp;33 was measured directly from the garment.
      Other sizes are graded from this reference and may be refined as additional production
      measurements are verified.
    </p>
  </section>

  <div class="csg-picker-b">
    <div class="csg-sizes" role="group" aria-label="Choose a size">__SIZEBUTTONS__</div>
    <div class="csg-detail">
      <p class="csg-detail-h">Size <span data-csg-detail-size>__REF__</span></p>
      <div class="csg-detail-grid">__DETAILCELLS__</div>
    </div>
    <p class="csg-graded">
      <span class="csg-ref" aria-hidden="true">&#9679;</span> Size&nbsp;33 was measured directly from the garment.
      Other sizes are graded from this reference and may be refined as additional production
      measurements are verified.
    </p>
  </div>

  <details class="csg-measure" open>
    <summary><h3 class="csg-h3">How to Measure</h3>__CHEV__</summary>
    <div class="csg-cards">__CARDS__</div>
    <p class="csg-note">
      <span class="csg-note-icon" aria-hidden="true">i</span>
      <span><strong>Helpful note:</strong> Garment measurements can vary slightly from pair to pair
      due to normal production and finishing. Please allow approximately <strong>&plusmn;2&nbsp;cm
      (&plusmn;0.75&nbsp;in)</strong>. If you&rsquo;re between sizes, compare these measurements with
      a pair of jeans you already own and love.</span>
    </p>
  </details>

  <footer class="csg-tips">
    <span class="csg-tips-icon" aria-hidden="true">__TAPE__</span>
    <h3 class="csg-tips-title">Tips for the best fit</h3>
    <ul class="csg-tips-list">__TIPS__</ul>
    <p class="csg-tagline">Built different.<br>Made for everyone.</p>
  </footer>
</div>

<script>
(function () {
  "use strict";
  var root = document.getElementById("__ROOT__");
  if (!root || root.dataset.csgReady) return;
  root.dataset.csgReady = "1";

  var KEYS = ["waist", "hip", "thigh", "inseam", "rise", "leg"];
  var unit = "in";
  var selected = __REF__;
  var rows = [].slice.call(root.querySelectorAll("[data-csg-row]"));
  var buttons = [].slice.call(root.querySelectorAll("[data-csg-size]"));

  /*
   * These are garment widths, published as supplied. Nothing is doubled here —
   * the other four guides store half-garment figures and double them, and
   * carrying that over would turn a 46.5 cm waist into 93 cm.
   *
   * Only centimetres are stored; inches are derived, so there is one set of
   * numbers rather than two that can drift.
   */
  function toIn(cm) {
    return String(Math.round((cm / 2.54) * 10) / 10);
  }

  function show(cmValue) {
    if (cmValue == null) return "\\u2014";
    var parts = String(cmValue).split("-");          /* "35-36" stays a range */
    if (unit === "cm") {
      return parts.map(function (p) { return String(parseFloat(p)); }).join("\\u2013");
    }
    return parts.map(function (p) { return toIn(parseFloat(p)); }).join("\\u2013");
  }

  function paint() {
    root.querySelectorAll("[data-csg-unitlabel]").forEach(function (el) {
      el.textContent = unit === "in" ? "(in)" : "(cm)";
    });
    rows.forEach(function (r) {
      KEYS.forEach(function (k) {
        var cell = r.querySelector('[data-csg-cell="' + k + '"]');
        if (cell) cell.textContent = show(r.getAttribute("data-cm-" + k));
      });
    });
    root.querySelectorAll("[data-csg-unit]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-csg-unit") === unit ? "true" : "false");
    });
    paintDetail();
  }

  function paintDetail() {
    /* One row carries the numbers for every view, so the phone panel and the
       tables can never disagree. */
    var row = rows.filter(function (r) { return String(r.getAttribute("data-csg-row")) === String(selected); })[0];
    var label = root.querySelector("[data-csg-detail-size]");
    if (label) label.textContent = selected == null ? "\\u2014" : selected;
    KEYS.forEach(function (k) {
      var el = root.querySelector('[data-csg-detail="' + k + '"]');
      if (!el) return;
      var cm = row ? row.getAttribute("data-cm-" + k) : null;
      el.textContent = cm ? show(cm) + " " + (unit === "in" ? "in" : "cm") : "\\u2014";
    });
  }

  function select(size) {
    selected = size == null ? null : String(size);
    rows.forEach(function (r) {
      r.setAttribute("aria-selected", String(r.getAttribute("data-csg-row")) === String(selected) ? "true" : "false");
    });
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-csg-size")) === String(selected) ? "true" : "false");
    });
    paintDetail();
  }

  root.querySelectorAll("[data-csg-unit]").forEach(function (b) {
    b.addEventListener("click", function () {
      unit = b.getAttribute("data-csg-unit");
      paint();                       /* the chosen size survives a unit change */
    });
  });

  rows.forEach(function (r) {
    r.addEventListener("click", function () { select(r.getAttribute("data-csg-row")); });
    r.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(r.getAttribute("data-csg-row")); }
    });
  });
  buttons.forEach(function (b) {
    b.addEventListener("click", function () { select(b.getAttribute("data-csg-size")); });
  });

  paint();
  select(__REF__);
})();
</script>
"""

html = (HTML.replace("__ROOT__", ROOT)
            .replace("__CSS__", css)
            .replace("__TITLE__", TITLE)
            .replace("__SUBTITLE__", SUBTITLE)
            .replace("__TABLE1__", table(["waist", "hip", "inseam"], None))
            .replace("__TABLE2__", table(["thigh", "rise", "leg"], None))
            .replace("__SIZEBUTTONS__", size_buttons)
            .replace("__DETAILCELLS__", detail_cells)
            .replace("__REF__", str(MEASURED_REFERENCE))
            .replace("__CARDS__", cards)
            .replace("__TIPS__", tips)
            .replace("__TAPE__", TAPE)
            .replace("__CHEV__", CHEV))

open(OUT, "w", encoding="utf-8").write(html)

style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
nc = re.sub(r"/\*.*?\*/", "", style, flags=re.S)
bad = []
for m in re.finditer(r"([^{}]+)\{", nc):
    blk = m.group(1)
    if "@media" in blk:
        blk = blk.split("{")[-1]
    for s in blk.split(","):
        s = " ".join(s.split())
        if s and not s.startswith("@") and not s.startswith("#" + ROOT):
            bad.append(s)
print("wrote %s  (%d bytes)" % (OUT, len(html)))
print("  rows: %d   unscoped selectors: %d %s" % (len(ROWS), len(bad), bad[:3]))
