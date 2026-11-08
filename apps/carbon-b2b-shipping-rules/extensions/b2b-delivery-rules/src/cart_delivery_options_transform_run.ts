import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
  Operation,
} from "../generated/api";

/**
 * B2B delivery rules.
 *
 * For a B2B buyer (the cart is bought for a company), shipping options are
 * reduced to the merchant's "keep" list (default: "Standard") and the kept
 * option can be renamed (e.g. "Shipping — billed after packing"), so carrier
 * options such as UPS / FedEx / DHL / USPS never appear for wholesale orders.
 *
 * Safety rules:
 * - Retail carts (no purchasing company) are never changed.
 * - Only SHIPPING options are touched; pickup, local delivery and pickup
 *   points stay as they are.
 * - A delivery group is never left without a shipping option: if none of the
 *   keep names is offered, the cheapest shipping option is kept instead.
 */

export type Configuration = {
  /** Turn the rule on/off without removing the customization. */
  enabled?: boolean;
  /** Shipping option titles kept for B2B buyers (case-insensitive, exact). */
  keepTitles?: string[];
  /** New title for the kept option(s); empty = keep the original title. */
  renameTo?: string;
};

export const DEFAULT_CONFIGURATION: Required<Configuration> = {
  enabled: true,
  keepTitles: ["Standard"],
  renameTo: "",
};

const NO_CHANGES: CartDeliveryOptionsTransformRunResult = {
  operations: [],
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function readConfiguration(raw: unknown): Required<Configuration> {
  const c = (raw && typeof raw === "object" ? raw : {}) as Configuration;
  const keepTitles = Array.isArray(c.keepTitles)
    ? c.keepTitles.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : DEFAULT_CONFIGURATION.keepTitles;
  return {
    enabled: c.enabled !== false,
    keepTitles: keepTitles.length ? keepTitles : DEFAULT_CONFIGURATION.keepTitles,
    renameTo: typeof c.renameTo === "string" ? c.renameTo.trim() : DEFAULT_CONFIGURATION.renameTo,
  };
}

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput,
): CartDeliveryOptionsTransformRunResult {
  const config = readConfiguration(input?.deliveryCustomization?.metafield?.jsonValue);
  if (!config.enabled) return NO_CHANGES;

  // Retail buyers: never change anything.
  if (!input?.cart?.buyerIdentity?.purchasingCompany) return NO_CHANGES;

  const keep = new Set(config.keepTitles.map(norm));
  const operations: Operation[] = [];

  for (const group of input.cart.deliveryGroups ?? []) {
    const shipping = (group.deliveryOptions ?? []).filter(
      (o) => o.deliveryMethodType === "SHIPPING",
    );
    if (shipping.length === 0) continue;

    let kept = shipping.filter((o) => keep.has(norm(o.title)));
    if (kept.length === 0) {
      // Never leave a B2B buyer without a way to ship: keep the cheapest.
      const cheapest = [...shipping].sort(
        (a, b) => Number(a.cost?.amount ?? 0) - Number(b.cost?.amount ?? 0),
      )[0];
      kept = [cheapest];
    }
    const keptHandles = new Set(kept.map((o) => o.handle));

    for (const option of shipping) {
      if (!keptHandles.has(option.handle)) {
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
      } else if (config.renameTo && option.title !== config.renameTo) {
        operations.push({
          deliveryOptionRename: { deliveryOptionHandle: option.handle, title: config.renameTo },
        });
      }
    }
  }

  return operations.length ? { operations } : NO_CHANGES;
}
