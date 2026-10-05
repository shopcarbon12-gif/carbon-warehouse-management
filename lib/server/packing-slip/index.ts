/**
 * CARBON packing slip — the approved design (package "approved-ink-friendly",
 * code/CARBON_Packing_Slip_FINAL.liquid), filled from the live Shopify order.
 *
 * The markup and CSS below are the approved Liquid template's, rule for rule.
 * Changes are technical only:
 *  - `@page { margin: 0 }` (as approved) leaves the browser no room to print
 *    its own date / title / URL / page-number lines. The top and bottom margins
 *    come from a frame table whose header and footer rows repeat on EVERY
 *    printed page, so a long order keeps its margins on page 2 too; the
 *    sheet's `min-height: 10.4in` (forced a blank extra page) is dropped.
 *  - Logo enlarged on request (2026-10-05): 52 px → 78 px tall.
 *  - Item rows never split across pages; the table header repeats.
 *  - Quantities are the CURRENT quantity (after refunds/removals), so removed
 *    items never print; the item count is their sum.
 *  - The logo is a genuine black copy of the real artwork (see assets.ts).
 *  - Every value from the order is HTML-escaped.
 * No price, discount, tax, shipping charge, total or payment field is fetched,
 * so none can be printed.
 */
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { ShopifyNotConnected } from "@/lib/server/shopify-sales";
import { CARBON_LOGO_BLACK_PNG_BASE64, RETURNS_QR_PNG_BASE64 } from "./assets";

export type PackingSlipLine = {
  title: string;
  variant: string | null;
  sku: string | null;
  quantity: number;
  image: string | null;
  properties: { key: string; value: string }[];
};

export type PackingSlipOrder = {
  name: string;
  createdAt: string;
  timezone: string;
  email: string | null;
  note: string | null;
  address: string[];
  lines: PackingSlipLine[];
  itemCount: number;
};

export async function getPackingSlipOrder(id: string): Promise<PackingSlipOrder | null> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new ShopifyNotConnected("Shopify is not connected (no shop domain or access token).");
  const gid = `gid://shopify/Order/${id.replace(/\D/g, "")}`;
  const query = `query PackingSlip($id: ID!) {
    shop { ianaTimezone }
    order(id: $id) {
      name createdAt email note
      shippingAddress { formatted(withName: true) }
      billingAddress { formatted(withName: true) }
      lineItems(first: 250) {
        nodes {
          title variantTitle sku currentQuantity
          customAttributes { key value }
          image { url(transform: { maxWidth: 144, maxHeight: 186 }) }
          product { featuredImage { url(transform: { maxWidth: 144, maxHeight: 186 }) } }
        }
      }
    }
  }`;
  const r = await runShopifyGraphql<{
    shop: { ianaTimezone: string } | null;
    order: {
      name: string;
      createdAt: string;
      email: string | null;
      note: string | null;
      shippingAddress: { formatted: string[] } | null;
      billingAddress: { formatted: string[] } | null;
      lineItems: {
        nodes: Array<{
          title: string;
          variantTitle: string | null;
          sku: string | null;
          currentQuantity: number;
          customAttributes: { key: string; value: string | null }[];
          image: { url: string } | null;
          product: { featuredImage: { url: string } | null } | null;
        }>;
      };
    } | null;
  }>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables: { id: gid } });
  if (!r.ok) {
    const first = Array.isArray(r.errors) ? (r.errors[0] as { message?: string } | undefined)?.message : undefined;
    throw new Error(first || "Shopify returned an error.");
  }
  const o = r.data?.order;
  if (!o) return null;

  const lines: PackingSlipLine[] = o.lineItems.nodes
    .filter((l) => l.currentQuantity > 0)
    .map((l) => ({
      title: l.title,
      variant: l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : null,
      sku: l.sku?.trim() || null,
      quantity: l.currentQuantity,
      image: l.image?.url ?? l.product?.featuredImage?.url ?? null,
      properties: (l.customAttributes ?? [])
        .filter((a) => a.key && !a.key.startsWith("_") && (a.value ?? "").trim() !== "")
        .map((a) => ({ key: a.key, value: String(a.value) })),
    }));

  const shipping = o.shippingAddress?.formatted ?? [];
  return {
    name: o.name,
    createdAt: o.createdAt,
    timezone: r.data?.shop?.ianaTimezone || "America/New_York",
    email: o.email?.trim() || null,
    note: o.note?.trim() || null,
    address: shipping.length ? shipping : (o.billingAddress?.formatted ?? []),
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtDate(iso: string, tz: string, month: "long" | "short"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month, day: "numeric", year: "numeric" }).format(new Date(iso));
}

const CSS = `
  @page {
    size: Letter;
    margin: 0;
  }

  /* Repeats on every printed page: top and bottom page margins. */
  .page-frame {
    width: 100%;
    border-collapse: collapse;
  }

  .page-frame > thead > tr > td,
  .page-frame > tfoot > tr > td,
  .page-frame > tbody > tr > td {
    padding: 0;
  }

  .frame-top {
    height: 0.42in;
  }

  .frame-bottom {
    height: 0.34in;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    color: #111111;
    background: #ffffff;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .carbon-sheet {
    width: 100%;
    padding: 0 0.50in;
  }

  .carbon-header {
    background: #ffffff;
    color: #111111;
    padding: 16px 0 14px;
    border-top: 4px solid #005BC0;
    border-bottom: 1px solid #dcdcdc;
  }

  .carbon-header-table,
  .info-table,
  .returns-table,
  .footer-table {
    width: 100%;
    border-collapse: collapse;
  }

  .logo-cell {
    width: 58%;
    vertical-align: middle;
  }

  .logo-cell img {
    display: block;
    max-width: 285px;
    max-height: 78px;
    object-fit: contain;
  }

  .header-order {
    width: 42%;
    text-align: right;
    vertical-align: middle;
  }

  .eyebrow {
    margin: 0 0 3px;
    color: #8f8f8f;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1.7px;
    text-transform: uppercase;
  }

  .header-order .eyebrow {
    color: #005BC0;
  }

  .order-number {
    margin: 0;
    font-size: 24px;
    line-height: 1.1;
    font-weight: 800;
    letter-spacing: -0.4px;
  }

  .order-date {
    margin-top: 5px;
    color: #777777;
    font-size: 10px;
  }

  .thank-you {
    padding: 24px 0 17px;
    border-bottom: 1px solid #dedede;
  }

  .thank-you h1 {
    margin: 0;
    font-size: 25px;
    line-height: 1.1;
    font-weight: 800;
    letter-spacing: -0.4px;
  }

  .thank-you p {
    margin: 7px 0 0;
    color: #525252;
    font-size: 11px;
  }

  .blue {
    color: #005BC0;
  }

  .info-table {
    margin: 20px 0 22px;
  }

  .info-table td {
    width: 50%;
    padding: 0;
    vertical-align: top;
  }

  .info-table td:first-child {
    padding-right: 24px;
  }

  .info-table td:last-child {
    padding-left: 24px;
    border-left: 1px solid #e1e1e1;
  }

  .section-label {
    margin-bottom: 8px;
    color: #005BC0;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 1.8px;
    text-transform: uppercase;
  }

  .address {
    color: #161616;
    font-size: 12px;
    line-height: 1.55;
  }

  .meta-row {
    margin-bottom: 7px;
  }

  .meta-key {
    display: inline-block;
    min-width: 92px;
    color: #777777;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }

  .meta-value {
    color: #111111;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .items-title {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.2px;
  }

  .items-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 18px;
  }

  .items-table thead {
    display: table-header-group;
  }

  .items-table tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .items-table thead th {
    padding: 8px 8px;
    background: #f3f3f3;
    border-top: 1px solid #d9d9d9;
    border-bottom: 1px solid #d9d9d9;
    color: #565656;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 1.1px;
    text-transform: uppercase;
  }

  .items-table thead th:first-child {
    text-align: left;
  }

  .items-table thead th:last-child {
    width: 62px;
    text-align: center;
  }

  .items-table tbody td {
    padding: 12px 8px;
    border-bottom: 1px solid #e7e7e7;
    vertical-align: middle;
  }

  .item-cell {
    display: table;
    width: 100%;
    table-layout: fixed;
  }

  .item-image,
  .item-copy {
    display: table-cell;
    vertical-align: middle;
  }

  .item-image {
    width: 60px;
    padding-right: 12px;
  }

  .item-image img {
    width: 48px;
    max-height: 62px;
    object-fit: contain;
  }

  .item-copy {
    overflow-wrap: anywhere;
  }

  .item-name {
    font-size: 12px;
    font-weight: 800;
    line-height: 1.3;
  }

  .item-detail {
    margin-top: 3px;
    color: #6d6d6d;
    font-size: 10px;
  }

  .qty {
    text-align: center;
    font-size: 14px;
    font-weight: 800;
  }

  .order-note {
    margin: 0 0 18px;
    padding: 11px 13px;
    border: 1px solid #dddddd;
    background: #fafafa;
    overflow-wrap: anywhere;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .order-note strong {
    display: block;
    margin-bottom: 3px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .returns-box {
    margin-top: 18px;
    border: 1px solid #d8d8d8;
    border-top: 5px solid #005BC0;
    padding: 16px 17px;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .returns-table td {
    vertical-align: middle;
  }

  .returns-copy {
    padding-right: 20px;
  }

  .returns-copy h2 {
    margin: 0 0 7px;
    font-size: 17px;
    font-weight: 800;
  }

  .returns-copy p {
    margin: 0 0 7px;
    color: #4c4c4c;
    font-size: 10.5px;
    line-height: 1.5;
  }

  .returns-copy .support {
    margin-top: 9px;
    color: #111111;
    font-weight: 700;
  }

  .qr-cell {
    width: 132px;
    text-align: center;
    border-left: 1px solid #e3e3e3;
    padding-left: 16px;
  }

  .qr-cell img {
    display: inline-block;
    width: 106px;
    height: 106px;
    image-rendering: pixelated;
  }

  .qr-caption {
    margin-top: 5px;
    color: #585858;
    font-size: 8px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: 0.7px;
    text-transform: uppercase;
  }

  .footer {
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid #dddddd;
    color: #666666;
    font-size: 8.5px;
    line-height: 1.45;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .footer-left {
    width: 72%;
    vertical-align: top;
  }

  .footer-right {
    width: 28%;
    text-align: right;
    vertical-align: top;
    color: #111111;
    font-weight: 700;
  }

  .footer-brand {
    color: #111111;
    font-weight: 800;
  }

  .no-price-note {
    margin-top: 5px;
    color: #8b8b8b;
    font-size: 8px;
  }

  /* Screen only: show the page as a sheet of paper with a Print button. */
  @media screen {
    html { background: #ececec; }
    body { background: #ececec; }
    .carbon-sheet {
      width: 8.5in;
      max-width: 100%;
      margin: 56px auto 24px;
      padding: 0.42in 0.50in 0.34in;
      background: #ffffff;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.18);
    }
    .frame-top,
    .frame-bottom {
      height: 0;
    }
    .screen-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      gap: 8px;
      justify-content: center;
      padding: 10px;
      background: #ffffff;
      border-bottom: 1px solid #dcdcdc;
      z-index: 1;
    }
    .screen-bar button {
      font: 700 13px Arial, Helvetica, sans-serif;
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid #005BC0;
      background: #005BC0;
      color: #ffffff;
      cursor: pointer;
    }
    .screen-bar button.secondary {
      background: #ffffff;
      color: #005BC0;
    }
  }

  @media print {
    .screen-bar { display: none; }
  }
`;

export function renderPackingSlipHtml(o: PackingSlipOrder, opts: { autoPrint?: boolean } = {}): string {
  const rows = o.lines
    .map((l) => {
      const details = [
        l.variant ? `<div class="item-detail">${esc(l.variant)}</div>` : "",
        l.sku ? `<div class="item-detail">SKU: ${esc(l.sku)}</div>` : "",
        ...l.properties.map((p) => `<div class="item-detail">${esc(p.key)}: ${esc(p.value)}</div>`),
      ].join("");
      return `
          <tr>
            <td>
              <div class="item-cell">
                <div class="item-image">${l.image ? `<img src="${esc(l.image)}" alt="">` : ""}</div>
                <div class="item-copy">
                  <div class="item-name">${esc(l.title)}</div>${details}
                </div>
              </div>
            </td>
            <td class="qty">${l.quantity}</td>
          </tr>`;
    })
    .join("");

  const address = o.address.map(esc).join("<br>");
  const note = o.note
    ? `
  <div class="order-note">
    <strong>Order note</strong>
    ${esc(o.note).replace(/\r?\n/g, "<br>")}
  </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packing slip ${esc(o.name)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="screen-bar">
  <button type="button" onclick="window.print()">Print packing slip</button>
  <button type="button" class="secondary" onclick="window.close()">Close</button>
</div>
<table class="page-frame">
<thead><tr><td class="frame-top"></td></tr></thead>
<tfoot><tr><td class="frame-bottom"></td></tr></tfoot>
<tbody><tr><td>
<div class="carbon-sheet">

  <div class="carbon-header">
    <table class="carbon-header-table">
      <tr>
        <td class="logo-cell">
          <img src="data:image/png;base64,${CARBON_LOGO_BLACK_PNG_BASE64}" alt="CARBON">
        </td>
        <td class="header-order">
          <div class="eyebrow">Packing Slip</div>
          <div class="order-number">${esc(o.name)}</div>
          <div class="order-date">${esc(fmtDate(o.createdAt, o.timezone, "long"))}</div>
        </td>
      </tr>
    </table>
  </div>

  <div class="thank-you">
    <h1>THANK YOU<span class="blue">.</span></h1>
    <p>
      Your CARBON order is packed and ready. We appreciate you choosing us.
    </p>
  </div>

  <table class="info-table">
    <tr>
      <td>
        <div class="section-label">Ship To</div>
        <div class="address">${address}</div>
      </td>
      <td>
        <div class="section-label">Order Details</div>

        <div class="meta-row">
          <span class="meta-key">Order</span>
          <span class="meta-value">${esc(o.name)}</span>
        </div>

        <div class="meta-row">
          <span class="meta-key">Order date</span>
          <span class="meta-value">${esc(fmtDate(o.createdAt, o.timezone, "short"))}</span>
        </div>
${
  o.email
    ? `
        <div class="meta-row">
          <span class="meta-key">Email</span>
          <span class="meta-value">${esc(o.email)}</span>
        </div>
`
    : ""
}
        <div class="meta-row">
          <span class="meta-key">Items</span>
          <span class="meta-value">${o.itemCount}</span>
        </div>
      </td>
    </tr>
  </table>

  <div class="items-title">WHAT'S INSIDE</div>

  <table class="items-table">
    <thead>
      <tr>
        <th>Item</th>
        <th>Qty</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
${note}
  <div class="returns-box">
    <table class="returns-table">
      <tr>
        <td class="returns-copy">
          <h2>RETURNS + EXCHANGES<span class="blue">.</span></h2>
          <p>
            Eligible items may be returned within 14 days of delivery for
            <strong>exchange or store credit only</strong>.
            Items must be unworn, unwashed, unaltered, in original condition,
            and have the original tags attached.
          </p>
          <p>
            Final-sale exclusions apply. Scan the QR code for the full policy,
            return instructions, and current eligibility details.
          </p>
          <div class="support">
            Need help? support@shopcarbon.com
          </div>
        </td>
        <td class="qr-cell">
          <img src="data:image/png;base64,${RETURNS_QR_PNG_BASE64}" alt="QR code: shopcarbon.com/pages/shipping-returns">
          <div class="qr-caption">Scan for returns<br>+ exchanges</div>
        </td>
      </tr>
    </table>
  </div>

  <div class="footer">
    <table class="footer-table">
      <tr>
        <td class="footer-left">
          <span class="footer-brand">CARBON Showroom</span><br>
          6250 Edgewater Drive, Suite 100 · Orlando, FL 32810<br>
          (407) 773-1399 · support@shopcarbon.com
          <div class="no-price-note">This packing slip intentionally does not display item prices.</div>
        </td>
        <td class="footer-right">
          SHOPCARBON.COM<br>
          @SHOPCARBON
        </td>
      </tr>
    </table>
  </div>

</div>
</td></tr></tbody>
</table>
${
  opts.autoPrint
    ? `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 150); });</script>`
    : ""
}
</body>
</html>`;
}
