#!/usr/bin/env node
/**
 * Tiny TCP relay so the Carbon CDM agent VM (which has broken outbound
 * IPv4 to the public Internet via its bridged adapter) can reach
 * wms.shopcarbon.com via this dev laptop.
 *
 * The relay shuttles raw bytes — TLS is end-to-end between the agent and
 * the real prod server. SNI (wms.shopcarbon.com) passes through unchanged,
 * so the cert validates normally on the agent side.
 *
 * VM-side setup:
 *   echo "192.168.1.214 wms.shopcarbon.com" | sudo tee -a /etc/hosts
 *   .env: CARBON_WMS_URL=https://wms.shopcarbon.com:8443
 */
import net from "node:net";

const LISTEN_PORT = Number(process.env.RELAY_PORT ?? 8443);
const TARGET_HOST = process.env.RELAY_TARGET_HOST ?? "wms.shopcarbon.com";
const TARGET_PORT = Number(process.env.RELAY_TARGET_PORT ?? 443);

const server = net.createServer((client) => {
  const ts = () => new Date().toISOString();
  const tag = `${client.remoteAddress}:${client.remotePort}`;
  console.log(`${ts()} [open] ${tag}`);

  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });

  const cleanup = (which) => () => {
    try { client.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
    console.log(`${ts()} [close ${which}] ${tag}`);
  };
  client.on("end", cleanup("client-end"));
  client.on("error", (e) => { console.log(`${ts()} [client-err] ${tag}: ${e.message}`); cleanup("client-err")(); });
  upstream.on("end", cleanup("upstream-end"));
  upstream.on("error", (e) => { console.log(`${ts()} [upstream-err] ${tag}: ${e.message}`); cleanup("upstream-err")(); });
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`relay listening on 0.0.0.0:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT}`);
});
