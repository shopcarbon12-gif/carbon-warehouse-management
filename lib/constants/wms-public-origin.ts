/**
 * Local Next dev server (`npm run dev`) — single source of truth with `package.json` `dev` script.
 * Production uses the same env keys with `https://wms.shopcarbon.com` (see `.env.example`).
 */
export const WMS_LOCAL_DEV_PORT = 3040;
export const WMS_LOCAL_DEV_ORIGIN = `http://localhost:${WMS_LOCAL_DEV_PORT}`;
