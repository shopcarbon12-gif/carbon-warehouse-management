Screenshots for routes updated in the “button visibility / theme” pass (pics 1–3, 6)
and Print/commission (teal status bar).

PNG files (gitignored)
----------------------
Run on your machine (app + Postgres + valid user):

  npm run dev
  npm run evidence:button-theme-pages

Or set PLAYWRIGHT_BASE_URL=http://127.0.0.1:3050 if you use `next start -p 3050`.

Requires SEED_ADMIN_PASSWORD or WMS_SCREENSHOT_PASSWORD (+ email) in .env / .env.local.

Gallery
-------
After PNGs exist, open index.html in this folder (double-click) to view all images.

Expected files:
  infrastructure__devices.png
  infrastructure__lightspeed-sales.png
  infrastructure__settings.png
  inventory__sync.png
  inventory__bulk-status.png
  inventory__catalog.png
  rfid__commissioning.png
