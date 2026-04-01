Light theme evidence (web only)
================================

Folders
-------
before/   PNG full-page captures (gitignored — regenerate locally).
after/    PNG full-page captures (gitignored — regenerate locally).

Committed artifact
------------------
light-theme-report.html — single file with embedded (base64) images so every
before/after pair is visible without opening separate PNG paths. Open this file
in a browser from the repo (double-click or file://).

Regenerate
----------
1. Start the app (e.g. npm run dev on 3040, or next start -p 3050 after build).
2. Set WMS_SCREENSHOT_EMAIL / WMS_SCREENSHOT_PASSWORD or SEED_ADMIN_PASSWORD in
   .env.local so Playwright can sign in.
3. npm run evidence:theme:before   # optional baseline from current code
4. npm run evidence:theme:after    # after UI changes
5. npm run evidence:theme:report   # rebuild light-theme-report.html

Scripts live under scripts/capture-theme-evidence.mjs and
scripts/generate-light-theme-report.mjs. Codemod: scripts/light-theme-slate-to-wms.mjs

Color approval reference: docs/design-review-carbonwms-light-theme.html
