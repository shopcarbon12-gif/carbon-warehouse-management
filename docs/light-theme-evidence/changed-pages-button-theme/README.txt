Screenshots for routes updated in the “button visibility / theme” pass (pics 1–3, 6)
and Print/commission (teal status bar).

PNG files (gitignored)
----------------------
Run on your machine (app + Postgres + valid user), from repo root or D:\cwm:

  npm run dev
  npm run evidence:button-theme-pages

Google Chrome (installed) instead of bundled Chromium (Windows):

  PowerShell:  $env:PLAYWRIGHT_CHANNEL="chrome"; npm run evidence:button-theme-pages

Optional: PLAYWRIGHT_HEADED=1 opens a visible Chrome window.
Optional: WMS_SCREENSHOT_SETTLE_MS=6000 if pages are still loading in captures.

Or set PLAYWRIGHT_BASE_URL=http://127.0.0.1:3050 if you use `next start -p 3050`.

Requires SEED_ADMIN_PASSWORD or WMS_SCREENSHOT_PASSWORD (+ email) in .env / .env.local.

Gallery
-------
After PNGs exist, open index.html in this folder (double-click) to view all images.

Expected files:
  root.png  (dashboard — command center)
  settings__handheld.png
  infrastructure__devices.png
  infrastructure__lightspeed-sales.png
  infrastructure__settings.png
  inventory__sync.png
  inventory__bulk-status.png
  inventory__catalog.png
  rfid__commissioning.png
