/**
 * Email Popup — pure helpers (no I/O), unit-tested in
 * scripts/test-welcome-popup.ts: email checks, the code format, the bot
 * screen, languages and dates.
 */
import { randomInt } from "node:crypto";

export const WELCOME_TAG = "welcome-popup";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I

/** Per IP: signups allowed in 24 h. Shared Wi-Fi (a store, a campus) needs a few. */
export const MAX_SIGNUPS_PER_IP_PER_DAY = 3;
/** Whole store: a flood guard far above real traffic (a busy day is ~20). */
export const MAX_SIGNUPS_PER_HOUR = 100;
/** A person needs at least this long between the popup opening and pressing the button. */
export const MIN_OPEN_MS = 1200;

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lower-cased, trimmed email, or null when it can't be a real address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  if (!EMAIL_RE.test(e)) return null;
  const [local, domain] = e.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  return e;
}

export function emailDomain(email: string): string {
  return email.slice(email.indexOf("@") + 1);
}

export function welcomeCode(percent: number, pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return `WELCOME${percent}-${s}`;
}

/** Bot signals on the request itself. null = looks like a person. */
export function screenRequest(input: { honeypot: unknown; openMs: unknown; ua: string }): string | null {
  if (typeof input.honeypot === "string" && input.honeypot.trim() !== "") return "honeypot";
  const ms = Number(input.openMs);
  if (!Number.isFinite(ms) || ms < MIN_OPEN_MS) return "too_quick";
  if (!input.ua.trim()) return "no_user_agent";
  return null;
}

/** Which signup form on the store: the popup or the footer newsletter. */
export type WelcomeForm = "popup" | "footer";
export function formOf(raw: unknown): WelcomeForm {
  return raw === "footer" ? "footer" : "popup";
}

export type WelcomeLang = "en" | "es" | "pt";

/** Shopify locale ("es", "pt-BR", "en-US", …) → the popup / email language. */
export function langOf(raw: unknown): WelcomeLang {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("pt")) return "pt";
  return "en";
}

const DATE_LOCALE: Record<WelcomeLang, string> = { en: "en-US", es: "es-US", pt: "pt-BR" };

/** "November 19, 2026" in the shopper's language (store time, Eastern). */
export function longDate(iso: string | Date, lang: WelcomeLang): string {
  return new Date(iso).toLocaleDateString(DATE_LOCALE[lang], {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The welcome email, in three languages. Brand is "Carbon". */
export const EMAIL_COPY: Record<
  WelcomeLang,
  {
    subject: (p: number) => string;
    preheader: (p: number) => string;
    hello: string;
    intro: (p: number) => string;
    button: string;
    valid: (date: string) => string;
    useEmail: string;
    terms: string;
    why: string;
    unsubscribe: string;
  }
> = {
  en: {
    subject: (p) => `Your ${p}% code for Carbon`,
    preheader: (p) => `${p}% off your first order — your code is inside.`,
    hello: "Welcome to Carbon.",
    intro: (p) => `Here is your code for ${p}% off your first order:`,
    button: "Shop now",
    valid: (d) => `Valid until ${d}. One use.`,
    useEmail: "Use this email address at checkout — the code is linked to it.",
    terms: "Can't be combined with other discounts: at checkout you always get whichever saves you more. Shipping not included.",
    why: "You're getting this email because you signed up at shopcarbon.com.",
    unsubscribe: "Unsubscribe",
  },
  es: {
    subject: (p) => `Tu código de ${p}% para Carbon`,
    preheader: (p) => `${p}% de descuento en tu primera compra — aquí está tu código.`,
    hello: "Bienvenido a Carbon.",
    intro: (p) => `Este es tu código de ${p}% de descuento en tu primera compra:`,
    button: "Comprar ahora",
    valid: (d) => `Válido hasta el ${d}. Un solo uso.`,
    useEmail: "Usa este email al pagar: el código está vinculado a él.",
    terms: "No se combina con otros descuentos: al pagar siempre recibes el que más te ahorra. No incluye el envío.",
    why: "Recibes este email porque te suscribiste en shopcarbon.com.",
    unsubscribe: "Darme de baja",
  },
  pt: {
    subject: (p) => `Seu código de ${p}% da Carbon`,
    preheader: (p) => `${p}% de desconto na sua primeira compra — seu código está aqui.`,
    hello: "Bem-vindo à Carbon.",
    intro: (p) => `Aqui está seu código de ${p}% de desconto na sua primeira compra:`,
    button: "Comprar agora",
    valid: (d) => `Válido até ${d}. Uso único.`,
    useEmail: "Use este email na finalização da compra — o código está vinculado a ele.",
    terms: "Não é cumulativo com outros descontos: na finalização você sempre recebe o que mais economiza. Frete não incluso.",
    why: "Você recebeu este email porque se cadastrou em shopcarbon.com.",
    unsubscribe: "Cancelar inscrição",
  },
};
