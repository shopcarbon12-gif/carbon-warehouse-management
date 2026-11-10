/**
 * CarbonWMS Email — Flows (phase 4): automatic emails, built like Klaviyo's flow builder but as a
 * simple top-to-bottom list (Klaviyo's canvas is a vertical list too; we leave out branching):
 *
 *   Trigger  →  Wait 1 hour  →  Email  →  Stop if they ordered  →  Wait 2 days  →  Email …
 *
 * Pure (no server or browser APIs): the flow editor and the server both use it.
 */

export type TriggerType = "signup" | "order" | "abandoned_checkout" | "winback" | "birthday" | "shipped";
export type Trigger = { type: "signup" } | { type: "order"; first: boolean; where: "online" | "store" | "both" } | { type: "abandoned_checkout" } | { type: "winback"; days: number } | { type: "birthday" } | { type: "shipped" };

export type WaitStep = {
  id: string;
  type: "wait";
  amount: number;
  unit: "minutes" | "hours" | "days";
};
export type FlowOffer = {
  kind: "amount" | "percent";
  amount: number;
  days: number;
  minSubtotal: number | null;
};
export type EmailStep = {
  id: string;
  type: "email";
  name: string;
  designId: string | null;
  subject: string;
  preheader: string;
  offer: FlowOffer | null;
  live: boolean;
};
export type StopIf = "ordered" | "clicked";
export type StopStep = { id: string; type: "stop"; if: StopIf };
export type FlowStep = WaitStep | EmailStep | StopStep;

export type FlowSettings = {
  /** all = every mailable person; subscribed = only people who said yes to marketing emails. */
  /** transactional: about the person's own order (thank you, shipped) — also to people who unsubscribed from marketing; never to bounced, spam-reporting or left-out addresses. */
  who: "all" | "subscribed" | "transactional";
  /** Skip an email when the person got any email from us in the last N hours (0 = never skip). */
  skipRecentHours: number;
  /** Send only between these hours, Orlando time (an email due at night waits for the morning). */
  sendFrom: number;
  sendTo: number;
  /** The same person can go through the flow again after N days (null = only once, ever). */
  reentryDays: number | null;
};

export type FlowKind = "welcome" | "abandoned" | "thanks" | "winback" | "birthday" | "shipped" | "custom";
export type FlowDraft = {
  name: string;
  kind: FlowKind;
  trigger: Trigger;
  steps: FlowStep[];
  settings: FlowSettings;
};

export const fid = () => Math.random().toString(36).slice(2, 10);

export const DEFAULT_SETTINGS: FlowSettings = {
  who: "all",
  skipRecentHours: 16,
  sendFrom: 9,
  sendTo: 21,
  reentryDays: null,
};

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  signup: "Signs up for emails",
  order: "Places an order",
  abandoned_checkout: "Leaves a checkout without paying",
  winback: "Has not ordered for a while",
  birthday: "Has a birthday",
  shipped: "Has an order shipped",
};

export function triggerText(t: Trigger): string {
  switch (t.type) {
    case "signup":
      return "When someone signs up (the website pop-up or the footer form)";
    case "order":
      return `When someone places ${t.first ? "their FIRST" : "an"} order ${t.where === "online" ? "online" : t.where === "store" ? "in the store" : "online or in the store"}`;
    case "abandoned_checkout":
      return "When someone starts a checkout on shopcarbon.com and does not pay";
    case "winback":
      return `When someone's last order was ${t.days} days ago`;
    case "birthday":
      return "On each person's birthday (from Rewards; once a year)";
    case "shipped":
      return "When an online order is shipped (fulfilled in Shopify)";
  }
}

export const STOP_LABEL: Record<StopIf, string> = {
  ordered: "Stop if they placed an order since they entered this flow",
  clicked: "Stop if they clicked an email from this flow",
};

export function waitText(w: WaitStep): string {
  const unit = w.amount === 1 ? w.unit.replace(/s$/, "") : w.unit;
  return `Wait ${w.amount} ${unit}`;
}

export function waitMs(w: WaitStep): number {
  const n = Math.max(0, Math.min(w.amount, w.unit === "minutes" ? 60 * 24 * 60 : w.unit === "hours" ? 24 * 365 : 365));
  return n * (w.unit === "minutes" ? 60_000 : w.unit === "hours" ? 3_600_000 : 86_400_000);
}

const wait = (amount: number, unit: WaitStep["unit"]): WaitStep => ({
  id: fid(),
  type: "wait",
  amount,
  unit,
});
const email = (name: string, subject: string, preheader: string, offer: FlowOffer | null = null): EmailStep => ({
  id: fid(),
  type: "email",
  name,
  designId: null,
  subject,
  preheader,
  offer,
  live: true,
});
const stop = (s: StopIf): StopStep => ({ id: fid(), type: "stop", if: s });

/** The ready-made flows (the "Browse ideas" of Klaviyo), each with the starter email it uses. */
export type FlowIdea = {
  kind: Exclude<FlowKind, "custom">;
  name: string;
  description: string;
  starters: string[];
  make: () => FlowDraft;
};

export const FLOW_IDEAS: FlowIdea[] = [
  {
    kind: "welcome",
    name: "Welcome series",
    description: "After someone signs up (they already get their welcome code at once): our story and the store a day later, then a reminder before their code runs out.",
    starters: ["pack-42-our-story", "pack-43-first-order"],
    make: () => ({
      name: "Welcome series",
      kind: "welcome",
      trigger: { type: "signup" },
      settings: { ...DEFAULT_SETTINGS, skipRecentHours: 0 },
      steps: [
        wait(1, "days"),
        stop("ordered"),
        email("Welcome 1: who we are", "Welcome to CARBON, {{first_name|there}}", "The Orlando showroom, new arrivals every week and your welcome code"),
        wait(3, "days"),
        stop("ordered"),
        email("Welcome 2: your code is waiting", "Your welcome code is still waiting", "A few picks to use it on before it runs out"),
      ],
    }),
  },
  {
    kind: "abandoned",
    name: "Abandoned checkout",
    description: "Someone filled in their email at checkout and left. One hour later: their cart with a button back. A day later, a second nudge. Stops as soon as they order.",
    starters: ["pack-44-abandoned-cart"],
    make: () => ({
      name: "Abandoned checkout",
      kind: "abandoned",
      trigger: { type: "abandoned_checkout" },
      settings: { ...DEFAULT_SETTINGS, skipRecentHours: 0, reentryDays: 7 },
      steps: [
        wait(1, "hours"),
        stop("ordered"),
        email("Cart 1: you left something", "You left something behind", "Your cart is saved. Pick up where you left off"),
        wait(1, "days"),
        stop("ordered"),
        email("Cart 2: still thinking?", "Still thinking it over, {{first_name|there}}?", "Your pieces are still in your cart, while sizes last"),
      ],
    }),
  },
  {
    kind: "thanks",
    name: "Thank you for your order",
    description: "A personal thank-you two hours after an order, online or in the store, with what they bought and how to style it. Not a receipt: Shopify still sends that.",
    starters: ["pack-49-thank-you"],
    make: () => ({
      name: "Thank you for your order",
      kind: "thanks",
      trigger: { type: "order", first: false, where: "both" },
      settings: { ...DEFAULT_SETTINGS, who: "transactional", skipRecentHours: 0, reentryDays: 30 },
      steps: [wait(2, "hours"), email("Thank you", "Thank you, {{first_name|there}}", "From all of us at CARBON in Orlando")],
    }),
  },
  {
    kind: "winback",
    name: "We miss you (win-back)",
    description: "Someone's last order was 90 days ago: what is new since then, and a week later their own code. Stops when they order.",
    starters: ["pack-56-new-arrivals", "pack-55-win-back"],
    make: () => ({
      name: "We miss you",
      kind: "winback",
      trigger: { type: "winback", days: 90 },
      settings: { ...DEFAULT_SETTINGS, reentryDays: 180 },
      steps: [
        email("Win-back 1: what's new", "It's been a while, {{first_name|there}}", "Here is what's new at CARBON since your last visit"),
        wait(7, "days"),
        stop("ordered"),
        email("Win-back 2: your own code", "{{offer_amount}} off, just for you", "Your own code, good until {{offer_ends}}", { kind: "amount", amount: 20, days: 10, minSubtotal: 80 }),
      ],
    }),
  },
];

FLOW_IDEAS.push({
  kind: "birthday",
  name: "Happy birthday",
  description: "On each Rewards member's birthday: the pack's HBD email with their own birthday code, good for two weeks.",
  starters: ["pack-30-birthday"],
  make: () => ({
    name: "Happy birthday",
    kind: "birthday",
    trigger: { type: "birthday" },
    settings: { ...DEFAULT_SETTINGS, skipRecentHours: 0, reentryDays: 300 },
    steps: [email("Birthday", "Happy birthday, {{first_name|friend}}", "A birthday gift from CARBON, just for you", { kind: "percent", amount: 15, days: 14, minSubtotal: null })],
  }),
});

FLOW_IDEAS.push({
  kind: "shipped",
  name: "Shipped, then a review",
  description: "When an online order ships: its tracking link right away (sent even to people who opted out of marketing). Two weeks later, a quick “rate the fit”.",
  starters: ["pack-50-shipped", "pack-51-review"],
  make: () => ({
    name: "Shipped, then a review",
    kind: "shipped",
    trigger: { type: "shipped" },
    settings: { ...DEFAULT_SETTINGS, who: "transactional", skipRecentHours: 0, reentryDays: null },
    steps: [email("Shipped", "Your order {{order_name}} is on its way", "Track it here. From Orlando, with love"), wait(14, "days"), email("Review: rate the fit", "How does it fit, {{first_name|there}}?", "Tell us in one tap")],
  }),
});

export function blankFlow(): FlowDraft {
  return {
    name: "New flow",
    kind: "custom",
    trigger: { type: "signup" },
    settings: { ...DEFAULT_SETTINGS },
    steps: [],
  };
}

/* ---------------------------------------------------------------- checks */

const num = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;

export function isTrigger(x: unknown): x is Trigger {
  const t = x as Trigger;
  if (!t || typeof t !== "object") return false;
  if (t.type === "signup" || t.type === "abandoned_checkout" || t.type === "birthday" || t.type === "shipped") return true;
  if (t.type === "order") return typeof t.first === "boolean" && ["online", "store", "both"].includes(t.where);
  if (t.type === "winback") return num(t.days, 14, 730);
  return false;
}

export function isStep(x: unknown): x is FlowStep {
  const s = x as FlowStep;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id) return false;
  if (s.type === "wait") return num(s.amount, 0, 525_600) && ["minutes", "hours", "days"].includes(s.unit);
  if (s.type === "stop") return s.if === "ordered" || s.if === "clicked";
  if (s.type === "email")
    return (
      typeof s.name === "string" &&
      (s.designId === null || typeof s.designId === "string") &&
      typeof s.subject === "string" &&
      s.subject.length <= 200 &&
      typeof s.preheader === "string" &&
      s.preheader.length <= 300 &&
      typeof s.live === "boolean" &&
      (s.offer === null ||
        (["amount", "percent"].includes(s.offer.kind) && num(s.offer.amount, 1, s.offer.kind === "percent" ? 90 : 500) && num(s.offer.days, 1, 90) && (s.offer.minSubtotal === null || num(s.offer.minSubtotal, 0, 5000))))
    );
  return false;
}

export function isSettings(x: unknown): x is FlowSettings {
  const s = x as FlowSettings;
  return (
    !!s &&
    (s.who === "all" || s.who === "subscribed" || s.who === "transactional") &&
    num(s.skipRecentHours, 0, 168) &&
    num(s.sendFrom, 0, 23) &&
    num(s.sendTo, 1, 24) &&
    s.sendFrom < s.sendTo &&
    (s.reentryDays === null || num(s.reentryDays, 1, 3650))
  );
}

/** What stops a flow from being turned on (shown on "Turn on"). */
export function flowProblems(f: { trigger: Trigger; steps: FlowStep[] }): string[] {
  const out: string[] = [];
  const emails = f.steps.filter((s): s is EmailStep => s.type === "email");
  if (!emails.length) out.push("Add at least one email.");
  for (const e of emails) {
    if (!e.live) continue;
    if (!e.designId) out.push(`"${e.name}" has no email picked yet.`);
    if (!e.subject.trim()) out.push(`"${e.name}" has no subject line.`);
  }
  if (f.trigger.type === "winback" && !f.steps.some((s) => s.type === "email" && s.live)) out.push("The win-back flow has no live email.");
  return out;
}

/** When an email that is due at `at` may go out, given the send window (Orlando time). */
export function inWindow(at: Date, s: Pick<FlowSettings, "sendFrom" | "sendTo">): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  if (h >= s.sendFrom && h < s.sendTo) return at;
  // Hours until sendFrom (today if before it, tomorrow if after the window).
  const hoursAhead = h < s.sendFrom ? s.sendFrom - h : 24 - h + s.sendFrom;
  return new Date(at.getTime() + hoursAhead * 3_600_000 - m * 60_000 - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds());
}
