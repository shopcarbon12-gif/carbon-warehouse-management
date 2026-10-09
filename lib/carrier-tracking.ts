/**
 * A tracking link for a shipment. Shopify gives one for most labels; when it
 * doesn't (a number typed in by hand, or a carrier Shopify doesn't recognise),
 * fall back to the carrier's public tracking page, guessing the carrier from
 * the number's shape when the company name is missing.
 */
export function carrierTrackingUrl(company: string | null, number: string | null, url: string | null): string | null {
  if (url) return url;
  if (!number) return null;
  const n = encodeURIComponent(number.trim());
  const c = (company ?? "").toLowerCase();
  if (c.includes("ups") || /^1Z[0-9A-Z]{16}$/i.test(number)) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes("usps") || /^(9[234]\d{18,20}|[A-Z]{2}\d{9}US)$/i.test(number)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes("fedex") || /^\d{12}$|^\d{15}$/.test(number)) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${company ?? ""} tracking ${number}`.trim())}`;
}
