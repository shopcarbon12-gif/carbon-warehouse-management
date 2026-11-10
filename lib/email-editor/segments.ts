/**
 * CarbonWMS Email — segments (phase 5): who an email goes to, by what people did.
 * Like Klaviyo's segment builder, cut to what CARBON has data for: orders (shopcarbon.com and the
 * Carbon POS store), money spent, email opens/clicks, Rewards membership, birthdays.
 * Every rule must match (AND). Pure: the builder and the server's SQL both use it.
 */

export type SegRule =
  | { k: "ordered"; min: number; days: number | null } // placed at least `min` orders (in the last `days`)
  | { k: "no_order"; days: number } // no order in the last `days` (but ordered before)
  | { k: "never_ordered" } // on the list, never ordered
  | { k: "spent"; min: number; days: number | null } // spent at least $min
  | { k: "engaged"; what: "opened" | "clicked"; days: number } // opened / clicked any email in the last `days`
  | { k: "not_engaged"; days: number } // got emails in the last `days` but opened none
  | { k: "rewards"; yes: boolean } // a Rewards (store) member or not
  | { k: "birthday"; month: number | "this" | "next" }; // birthday month

export const RULE_KINDS: { k: SegRule["k"]; label: string; make: () => SegRule }[] = [
  { k: "ordered", label: "Placed orders", make: () => ({ k: "ordered", min: 1, days: 365 }) },
  { k: "no_order", label: "Has not ordered for a while", make: () => ({ k: "no_order", days: 90 }) },
  { k: "never_ordered", label: "Never ordered", make: () => ({ k: "never_ordered" }) },
  { k: "spent", label: "Spent at least", make: () => ({ k: "spent", min: 200, days: 365 }) },
  { k: "engaged", label: "Opened or clicked an email", make: () => ({ k: "engaged", what: "opened", days: 30 }) },
  { k: "not_engaged", label: "Got emails but opened none", make: () => ({ k: "not_engaged", days: 60 }) },
  { k: "rewards", label: "Rewards member", make: () => ({ k: "rewards", yes: true }) },
  { k: "birthday", label: "Birthday month", make: () => ({ k: "birthday", month: "this" }) },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const period = (days: number | null) => (days == null ? "ever" : days % 365 === 0 ? `in the last ${days / 365 === 1 ? "year" : `${days / 365} years`}` : `in the last ${days} days`);

export function ruleText(r: SegRule): string {
  switch (r.k) {
    case "ordered":
      return `Placed ${r.min === 1 ? "an order" : `${r.min}+ orders`} ${period(r.days)}`;
    case "no_order":
      return `Ordered before, but not in the last ${r.days} days`;
    case "never_ordered":
      return "Never ordered (online or in the store)";
    case "spent":
      return `Spent $${r.min}+ ${period(r.days)}`;
    case "engaged":
      return `${r.what === "opened" ? "Opened" : "Clicked"} an email in the last ${r.days} days`;
    case "not_engaged":
      return `Got emails in the last ${r.days} days but opened none`;
    case "rewards":
      return r.yes ? "Is a Rewards member" : "Is not a Rewards member";
    case "birthday":
      return `Birthday ${r.month === "this" ? "this month" : r.month === "next" ? "next month" : `in ${MONTHS[r.month - 1]}`}`;
  }
}

const int = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const days = (x: unknown) => int(x, 1, 3650);

export function isRule(x: unknown): x is SegRule {
  const r = x as SegRule;
  if (!r || typeof r !== "object") return false;
  switch (r.k) {
    case "ordered":
      return int(r.min, 1, 1000) && (r.days === null || days(r.days));
    case "no_order":
      return days(r.days);
    case "never_ordered":
      return true;
    case "spent":
      return int(r.min, 1, 1_000_000) && (r.days === null || days(r.days));
    case "engaged":
      return (r.what === "opened" || r.what === "clicked") && days(r.days);
    case "not_engaged":
      return days(r.days);
    case "rewards":
      return typeof r.yes === "boolean";
    case "birthday":
      return r.month === "this" || r.month === "next" || int(r.month, 1, 12);
    default:
      return false;
  }
}

export const isRules = (x: unknown): x is SegRule[] => Array.isArray(x) && x.length <= 12 && x.every(isRule);

/** Ready-made segments (one click in the builder). */
export const SEGMENT_IDEAS: { name: string; rules: SegRule[] }[] = [
  { name: "Best customers (3+ orders in a year)", rules: [{ k: "ordered", min: 3, days: 365 }] },
  { name: "Big spenders ($300+ in a year)", rules: [{ k: "spent", min: 300, days: 365 }] },
  { name: "Engaged (opened in the last 30 days)", rules: [{ k: "engaged", what: "opened", days: 30 }] },
  { name: "Lapsed (no order for 6 months)", rules: [{ k: "no_order", days: 180 }] },
  { name: "Never bought", rules: [{ k: "never_ordered" }] },
  { name: "Birthdays this month", rules: [{ k: "birthday", month: "this" }] },
  { name: "Sleeping (no opens in 90 days)", rules: [{ k: "not_engaged", days: 90 }] },
];
