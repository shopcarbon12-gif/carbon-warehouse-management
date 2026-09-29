#!/usr/bin/env python3
"""
Build the four size-guide snippets to the approved comp.

The measurement rows are read back out of the live snippets rather than retyped,
so a visual rebuild cannot quietly move a number. Everything the router depends
on — the element id, the data attributes, the asset filenames — is unchanged.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/home/carbondev/dev/carbon-warehouse-management/theme/snippets"

DATA = json.load(open(os.path.join(HERE, "fitdata.json"), encoding="utf-8"))
CSS = open(os.path.join(HERE, "style.css"), encoding="utf-8").read()

CARDS = [
    ("1", "Waist", "carbon-size-guide-waist.webp", "",
     "Jeans laid flat with a measuring tape straight across the top waistband",
     "Measure straight across the top waistband from edge to edge, then double it."),
    ("2", "Hip", "carbon-size-guide-hip.webp", "",
     "Jeans laid flat with a measuring tape across the widest hip area",
     "Measure across the widest point, about 16&nbsp;cm / 6.3&nbsp;in below the waistband, then double it."),
    ("3", "Inseam", "carbon-size-guide-inseam.webp", " csg-photo-inseam",
     "Full pair of jeans laid flat with a measuring tape running from the crotch seam to the bottom hem along the inner leg",
     "Measure from the crotch seam all the way down the inner leg to the hem."),
]

TIPS = ["Use a soft measuring tape", "Keep the tape straight (not angled)",
        "Compare with a pair you already own"]

TICK = ('<svg class="csg-tick" width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" focusable="false">'
        '<circle cx="8.5" cy="8.5" r="8.5" fill="currentColor"/>'
        '<path d="M4.6 8.7l2.6 2.6 5.2-5.2" fill="none" stroke="#fff" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round"/></svg>')

TAPE = ('<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true" focusable="false">'
        '<path d="M11 28.5a7.5 7.5 0 1 1 0-15h12a5 5 0 0 0 0-10" fill="none" stroke="currentColor" '
        'stroke-width="1.9" stroke-linecap="round"/>'
        '<circle cx="11" cy="21" r="3.2" fill="none" stroke="currentColor" stroke-width="1.9"/>'
        '<path d="M23 3.5a5 5 0 0 0-5 5v3" fill="none" stroke="currentColor" stroke-width="1.9" '
        'stroke-linecap="round"/></svg>')

CHEV = ('<svg class="csg-chev" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true" focusable="false">'
        '<path d="M1 1l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')


def scope(css: str, root: str) -> str:
    """
    Prefix every selector with the component id so nothing can leak.

    A comment sitting above a rule is part of the text before the brace, so a
    naive prefix folds it INTO the selector and the browser discards the whole
    rule — which is exactly how the :scope block carrying every custom property
    was silently dropped. Leading comments are lifted out and re-emitted above
    the rule instead.
    """
    def fix(m):
        sel = m.group(1)
        lead = ""
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
        if not parts:
            return m.group(0)
        return lead + ", ".join(parts) + " {"

    out = []
    for chunk in re.split(r"(@media[^{]+\{)", css):
        if chunk.startswith("@media"):
            out.append(chunk)
            continue
        out.append(re.sub(r"([^{}]+)\{", fix, chunk))
    return "".join(out)


def build(key: str, fit: dict) -> str:
    root = "carbon-size-guide-" + key
    css = scope(CSS, root)

    sizes = [r["size"] for r in fit["rows"]]
    options = "".join(
        '<option value="%d">%d</option>' % (s, s) for s in sizes)

    heads = "".join(
        '<th scope="col"><span class="csg-th-main">%s</span>'
        '<span class="csg-th-unit" data-csg-unitlabel>(in)</span></th>' % n
        for n in ("Waist", "Hip", "Inseam"))

    rows = "".join(
        '<tr data-csg-row="%d" data-in-waist="%s" data-in-hip="%s" data-in-inseam="%s"'
        ' data-cm-waist="%s" data-cm-hip="%s" data-cm-inseam="%s" aria-selected="false" tabindex="0">'
        '<th scope="row">%d</th>'
        '<td data-csg-cell="waist">%s</td><td data-csg-cell="hip">%s</td><td data-csg-cell="inseam">%s</td></tr>'
        % (r["size"], r["in"][0], r["in"][1], r["in"][2], r["cm"][0], r["cm"][1], r["cm"][2],
           r["size"], r["in"][0], r["in"][1], r["in"][2])
        for r in fit["rows"])

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

    return TEMPLATE.replace("__ROOT__", root) \
                   .replace("__KEY__", key) \
                   .replace("__CSS__", css) \
                   .replace("__FIT__", fit["title"]) \
                   .replace("__SUB__", fit["subtitle"]) \
                   .replace("__OPTIONS__", options) \
                   .replace("__HEADS__", heads) \
                   .replace("__ROWS__", rows) \
                   .replace("__CARDS__", cards) \
                   .replace("__TIPS__", tips) \
                   .replace("__TAPE__", TAPE) \
                   .replace("__CHEV__", CHEV)


TEMPLATE = r"""<!-- CARBON interactive size guide: __FIT__ (metafield key: __KEY__) -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap">
<div id="__ROOT__" class="carbon-size-guide" data-fit="__KEY__">
<style>
__CSS__
</style>

  <div class="csg-top">
    <p class="csg-wordmark">Carbon</p>
    <h2 class="csg-title">
      <span class="csg-title-fit">__FIT__</span><span class="csg-title-sub">Size Guide</span>
    </h2>
    <span class="csg-rule" aria-hidden="true"></span>
  </div>

  <div class="csg-units" role="group" aria-label="Measurement units">
    <button type="button" class="csg-unit" data-csg-unit="in" aria-pressed="true">In</button>
    <button type="button" class="csg-unit" data-csg-unit="cm" aria-pressed="false">CM</button>
  </div>

  <p class="csg-subtitle">__SUB__</p>

  <div class="csg-picker">
    <label class="csg-picker-label" for="__ROOT__-select">Select a size to highlight</label>
    <select class="csg-select" id="__ROOT__-select" data-csg-select>
      <option value="">Choose a size</option>
      __OPTIONS__
    </select>
  </div>

  <section class="csg-chart" aria-label="Size chart">
      <table class="csg-table">
        <thead><tr><th scope="col">Size</th>__HEADS__</tr></thead>
        <tbody data-csg-body>__ROWS__</tbody>
      </table>
      <p class="csg-table-foot">Garment measurements. Waist and hip are measured flat and doubled.</p>
  </section>

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

  var unit = "in";
  var selected = null;
  var rows = [].slice.call(root.querySelectorAll("[data-csg-row]"));
  var picker = root.querySelector("[data-csg-select]");

  function paintUnits() {
    root.querySelectorAll("[data-csg-unitlabel]").forEach(function (el) {
      el.textContent = unit === "in" ? "(in)" : "(cm)";
    });
    rows.forEach(function (r) {
      ["waist", "hip", "inseam"].forEach(function (k) {
        r.querySelector('[data-csg-cell="' + k + '"]').textContent = r.getAttribute("data-" + unit + "-" + k);
      });
    });
    root.querySelectorAll("[data-csg-unit]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-csg-unit") === unit ? "true" : "false");
    });
  }

  /* One source of truth for the selection: the table row. The dropdown is a
     second way to reach it, never a second copy of it. */
  function select(size) {
    selected = (selected === size) ? null : size;
    rows.forEach(function (r) {
      r.setAttribute("aria-selected", String(r.getAttribute("data-csg-row")) === String(selected) ? "true" : "false");
    });
    if (picker) picker.value = selected == null ? "" : String(selected);
  }

  root.querySelectorAll("[data-csg-unit]").forEach(function (b) {
    b.addEventListener("click", function () { unit = b.getAttribute("data-csg-unit"); paintUnits(); });
  });

  rows.forEach(function (r) {
    r.addEventListener("click", function () { select(r.getAttribute("data-csg-row")); });
    r.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(r.getAttribute("data-csg-row")); }
    });
  });

  if (picker) picker.addEventListener("change", function () {
    /* select() toggles, so clear first to make the dropdown authoritative. */
    selected = null;
    if (picker.value) select(picker.value); else select(null);
  });

  paintUnits();
})();
</script>
"""

os.makedirs(OUT, exist_ok=True)
for key in ["slim", "skinny", "super-skinny-long", "super-skinny-zipper"]:
    html = build(key, DATA[key])
    path = os.path.join(OUT, "carbon-size-guide-%s.liquid" % key)
    open(path, "w", encoding="utf-8").write(html)
    style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    leaked = []
    for m in re.finditer(r"([^{}]+)\{", style):
        block = m.group(1)
        if "@media" in block:
            block = block.split("{")[-1]
        for sel in block.split(","):
            sel = " ".join(sel.split())
            if not sel or sel.startswith("@"):
                continue
            # a comment left inside a selector invalidates the rule silently
            if "/*" in sel or not sel.startswith("#carbon-size-guide-"):
                leaked.append(sel)
    print("%-22s %6d bytes  rows=%d  unscoped-selectors=%d"
          % (key, len(html), len(DATA[key]["rows"]), len(leaked)))
    for s in leaked[:4]:
        print("      LEAK: " + " ".join(s.split())[:90])
