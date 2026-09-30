#!/usr/bin/env python3
"""
Build the Men's Swim Shorts size guide.

Shares the other guides' stylesheet, scoped to its own id. Three things are
specific to this one and deliberate:

  * The figures are published exactly as supplied. Nothing is doubled — the
    denim guides store half-garment measurements and double them in the UI, and
    carrying that over would turn a 35 cm waist into 70 cm.

  * "E — Trotter" keeps its source label. Its value behaves like a leg opening
    (28 cm at S against a 32 cm thigh, +1 cm per size) but nothing in the
    supplied material states that, and renaming a measurement on a customer-
    facing chart on the strength of a guess is not a small error.

  * There are no swim measurement photographs in the theme, and the denim photos
    show jeans. The right-hand column carries the remaining measurements for the
    selected size instead of the How-to-Measure cards.

Only centimetres are stored; inches are derived at render, so there is one set of
numbers rather than two that can drift apart.
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/home/carbondev/dev/carbon-warehouse-management/theme/snippets/carbon-size-guide-mens-swim-shorts.liquid"
ROOT = "carbon-size-guide-mens-swim-shorts"

CSS_BASE = open(os.path.join(HERE, "style.css"), encoding="utf-8").read()

TITLE = "Men&rsquo;s Swim Shorts"
SUBTITLE = "Garment measurements for our men&rsquo;s swim shorts."

# Centimetres, exactly as supplied. Source labels kept in the comment so the
# mapping back to the specification stays readable.
#        A       B      C     D       F          G         H       E          L         M
#        waist   belt   hip   thigh   frontRise  backRise  inseam  trotter    pocket    side
ROWS = [
    ("S",   "35", "4", "54", "32", "27", "35.5", "12", "28", "14.5", "36"),
    ("M",   "37", "4", "56", "33", "28", "36.5", "12", "29", "14.5", "37"),
    ("L",   "39", "4", "58", "34", "29", "37.5", "12", "30", "15.5", "38"),
    ("XL",  "41", "4", "60", "35", "30", "38.5", "13", "31", "15.5", "39"),
    ("XXL", "43", "4", "62", "36", "31", "39.5", "13", "32", "15.5", "40"),
]

KEYS = ["waist", "belt", "hip", "thigh", "frontrise", "backrise", "inseam", "trotter", "pocket", "side"]
LABELS = {
    "waist": "Waist", "belt": "Waistband Height", "hip": "Hip", "thigh": "Thigh",
    "frontrise": "Front Rise", "backrise": "Back Rise", "inseam": "Inseam",
    "trotter": "E &mdash; Trotter", "pocket": "Front Pocket", "side": "Side Length",
}
PRIMARY = ["waist", "hip", "thigh", "inseam", "side"]
SECONDARY = ["belt", "frontrise", "backrise", "trotter", "pocket"]

TIPS = ["Use a soft measuring tape",
        "Compare with swim shorts that already fit you",
        "Between sizes? Size up for a looser fit"]

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


def scope(css: str, root: str) -> str:
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
/* ── Swim shorts only ────────────────────────────────────────────────────
   Ten measurements will not fit one readable row, so the five people compare
   most often stay in the table and the rest appear for the selected size. With
   no swim measurement photographs in the theme, that panel takes the column the
   How-to-Measure cards occupy in the denim guides. */
.csg-more { border: 1px solid var(--csg-line); border-radius: 12px; padding: 16px 18px; }
.csg-more-h { margin: 0 0 4px; font-family: var(--csg-display); font-weight: 600;
  font-size: clamp(17px, 1.5vw, 21px); letter-spacing: .04em; text-transform: uppercase; }
.csg-more-sub { margin: 0 0 14px; font-size: 13px; color: var(--csg-muted); }
.csg-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 13px 18px; }
.csg-kv > div { min-width: 0; }
.csg-k { display: block; font-size: 11.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--csg-muted); }
.csg-v { display: block; font-family: var(--csg-display); font-weight: 600; font-size: 20px; margin-top: 2px; }
.csg-basis { margin: 14px 2px 0; font-size: 12.5px; line-height: 1.5; color: #6b7280; max-width: 64ch; }

/* phone: size buttons then every measurement, hidden on desktop */
.csg-mob { display: none; }
.csg-sizes { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.csg-size {
  appearance: none; cursor: pointer; background: #fff; color: var(--csg-ink);
  border: 1px solid var(--csg-line); border-radius: 10px; padding: 12px 0; min-width: 60px;
  font-family: var(--csg-display); font-weight: 600; font-size: 17px; flex: 1 0 60px;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.csg-size[aria-pressed="true"] { background: var(--csg-blue); border-color: var(--csg-blue); color: #fff; }
.csg-mob-h { margin: 0 0 12px; font-family: var(--csg-display); font-weight: 700;
  font-size: 20px; letter-spacing: .04em; text-transform: uppercase; }
"""

PHONE_CSS = """
@media (max-width: 680px) {
  #ROOT .csg-chart, #ROOT .csg-more { display: none; }
  #ROOT .csg-mob { display: block; order: 5; grid-column: 1; }
  #ROOT .csg-note-wrap { order: 6; grid-column: 1; }
  #ROOT .csg-tips { order: 7; }
}
@media (max-width: 380px) {
  /* Two columns of label + value stop fitting; one keeps every figure whole. */
  #ROOT .csg-kv { grid-template-columns: 1fr; }
}
""".replace("#ROOT", "#" + ROOT)


def head(keys):
    return "".join('<th scope="col"><span>%s</span>'
                   '<span class="csg-th-unit" data-csg-unitlabel>(cm)</span></th>' % LABELS[k]
                   for k in keys)


def body(keys):
    out = ""
    for row in ROWS:
        size = row[0]
        attrs = " ".join('data-cm-%s="%s"' % (k, row[i + 1]) for i, k in enumerate(KEYS))
        cells = "".join('<td data-csg-cell="%s">%s</td>' % (k, row[KEYS.index(k) + 1]) for k in keys)
        out += ('<tr data-csg-row="%s" %s aria-selected="false" tabindex="0">'
                '<th scope="row">%s</th>%s</tr>' % (size, attrs, size, cells))
    return out


tips = "".join("<li>%s<span>%s</span></li>" % (TICK, t) for t in TIPS)
size_buttons = "".join(
    '<button type="button" class="csg-size" data-csg-size="%s" aria-pressed="%s">%s</button>'
    % (r[0], "true" if r[0] == "M" else "false", r[0]) for r in ROWS)
more_cells = "".join(
    '<div><span class="csg-k">%s</span><span class="csg-v" data-csg-more="%s">&mdash;</span></div>'
    % (LABELS[k], k) for k in SECONDARY)
all_cells = "".join(
    '<div><span class="csg-k">%s</span><span class="csg-v" data-csg-all="%s">&mdash;</span></div>'
    % (LABELS[k], k) for k in KEYS)

css = scope(CSS_BASE + EXTRA_CSS, ROOT).replace("__TITLESIZE__", "clamp(26px, 4.2vw, 56px)") + PHONE_CSS

HTML = """<!-- CARBON interactive size guide: Men's Swim Shorts (custom.size_guide_type = mens-swim-shorts) -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap">
<div id="__ROOT__" class="carbon-size-guide" data-fit="mens-swim-shorts">
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
    <table class="csg-table">
      <thead><tr><th scope="col">Size</th>__HEAD1__</tr></thead>
      <tbody>__BODY1__</tbody>
    </table>
    <p class="csg-basis">
      These are measurements of the garment, not body measurements. Select a size to see the
      remaining measurements for it.
    </p>
  </section>

  <div class="csg-more">
    <h3 class="csg-more-h">Additional garment measurements</h3>
    <p class="csg-more-sub">Size <span data-csg-more-size>M</span></p>
    <div class="csg-kv">__MORECELLS__</div>
  </div>

  <div class="csg-mob">
    <div class="csg-sizes" role="group" aria-label="Choose a size">__SIZEBUTTONS__</div>
    <h3 class="csg-mob-h">Size <span data-csg-all-size>M</span></h3>
    <div class="csg-kv">__ALLCELLS__</div>
    <p class="csg-basis">These are measurements of the garment, not body measurements.</p>
  </div>

  <div class="csg-note-wrap">
    <p class="csg-note">
      <span class="csg-note-icon" aria-hidden="true">i</span>
      <span><strong>Helpful note:</strong> Garment measurements can vary slightly from pair to pair
      due to normal production and finishing. Please allow approximately <strong>&plusmn;2&nbsp;cm
      (&plusmn;0.75&nbsp;in)</strong>. If you&rsquo;re between sizes, compare these measurements with
      a pair of swim shorts you already own and love.</span>
    </p>
  </div>

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

  var KEYS = __KEYSJSON__;
  var unit = "in";
  var selected = "M";
  var rows = [].slice.call(root.querySelectorAll("[data-csg-row]"));
  var buttons = [].slice.call(root.querySelectorAll("[data-csg-size]"));

  /*
   * Published exactly as supplied — nothing is doubled. The denim guides hold
   * half-garment figures and double them; doing that here would turn a 35 cm
   * waist into 70 cm. Centimetres are the only stored values and inches are
   * derived, so there is one set of numbers, not two that can drift.
   */
  function show(cm) {
    if (cm == null) return "\\u2014";
    var n = parseFloat(cm);
    /* Inches keep one decimal even when it is a zero: 22.0 reads as a
       measurement, 22 reads as a rounded-off guess. */
    return unit === "cm" ? String(n) : (n / 2.54).toFixed(1);
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
    /* Both panels read the same row, so the desktop column and the phone list
       cannot disagree. */
    var row = rows.filter(function (r) { return r.getAttribute("data-csg-row") === selected; })[0];
    var suffix = unit === "in" ? " in" : " cm";
    root.querySelectorAll("[data-csg-more-size], [data-csg-all-size]").forEach(function (el) {
      el.textContent = selected || "\\u2014";
    });
    ["more", "all"].forEach(function (scope) {
      root.querySelectorAll("[data-csg-" + scope + "]").forEach(function (el) {
        var k = el.getAttribute("data-csg-" + scope);
        var cm = row ? row.getAttribute("data-cm-" + k) : null;
        el.textContent = cm ? show(cm) + suffix : "\\u2014";
      });
    });
  }

  function select(size) {
    selected = size;
    rows.forEach(function (r) {
      r.setAttribute("aria-selected", r.getAttribute("data-csg-row") === selected ? "true" : "false");
    });
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-csg-size") === selected ? "true" : "false");
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
  select("M");
})();
</script>
"""

html = (HTML.replace("__ROOT__", ROOT)
            .replace("__CSS__", css)
            .replace("__TITLE__", TITLE)
            .replace("__SUBTITLE__", SUBTITLE)
            .replace("__HEAD1__", head(PRIMARY))
            .replace("__BODY1__", body(PRIMARY))
            .replace("__MORECELLS__", more_cells)
            .replace("__ALLCELLS__", all_cells)
            .replace("__SIZEBUTTONS__", size_buttons)
            .replace("__KEYSJSON__", "[" + ",".join('"%s"' % k for k in KEYS) + "]")
            .replace("__TIPS__", tips)
            .replace("__TAPE__", TAPE))

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
print("wrote %s (%d bytes)" % (OUT, len(html)))
print("  sizes: %d   unscoped selectors: %d %s" % (len(ROWS), len(bad), bad[:3]))
print("  jeans photos referenced: %d (must be 0)" % len(re.findall(r"carbon-size-guide-(waist|hip|inseam)\.webp", html)))
