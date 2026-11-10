/**
 * CarbonWMS Email — the campaign calendar (owner's CARBON pack, 2026-11-10: "compute the next date
 * for each rule (floating holidays like Thanksgiving = 4th Thu Nov), show upcoming campaigns, and
 * remind the owner ~14 days before each send to swap in photos and products").
 *
 * Every date is a calendar day in Orlando time. Pure: the Calendar tab and the server's reminder use it.
 */

export type CalEntry = {
  /** The pack template (starter id "pack-<template>"). */
  template: string;
  name: string;
  /** The day it is about (the holiday). */
  day: (year: number) => Date;
  /** Extra send days before it (Valentine's: a week and three days before). */
  sendBefore?: number[];
  rule: string;
};

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day, 12));
/** The n-th weekday (0 = Sunday) of a month; n = -1 is the last one. */
export function nthWeekday(y: number, m: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = d(y, m, 1);
    const shift = (weekday - first.getUTCDay() + 7) % 7;
    return d(y, m, 1 + shift + (n - 1) * 7);
  }
  const last = d(y, m + 1, 0);
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return d(y, m, last.getUTCDate() - shift);
}
const thanksgiving = (y: number) => nthWeekday(y, 11, 4, 4);
const plus = (x: Date, days: number) => new Date(x.getTime() + days * 86_400_000);

export const CALENDAR: CalEntry[] = [
  { template: "11-new-year", name: "New Year — New Drop", day: (y) => d(y, 1, 1), rule: "Jan 1" },
  { template: "12-valentines", name: "Valentine's Day", day: (y) => d(y, 2, 14), sendBefore: [7, 3], rule: "Feb 14 (send Feb 7 and Feb 11)" },
  { template: "13-presidents-day", name: "Presidents' Day Sale", day: (y) => nthWeekday(y, 2, 1, 3), rule: "3rd Monday of February" },
  { template: "58-spring-break", name: "Spring Break", day: (y) => d(y, 3, 10), rule: "around Mar 10" },
  { template: "14-spring-drop", name: "Spring Drop", day: (y) => d(y, 3, 20), rule: "around Mar 20" },
  { template: "15-mothers-day", name: "Mother's Day", day: (y) => nthWeekday(y, 5, 0, 2), sendBefore: [5], rule: "2nd Sunday of May (send 5 days before)" },
  { template: "59-summer-drop", name: "Summer Drop", day: (y) => d(y, 5, 25), rule: "around May 25" },
  { template: "16-memorial-day", name: "Memorial Day Sale", day: (y) => nthWeekday(y, 5, 1, -1), rule: "last Monday of May" },
  { template: "17-fathers-day", name: "Father's Day", day: (y) => nthWeekday(y, 6, 0, 3), sendBefore: [5], rule: "3rd Sunday of June (send 5 days before)" },
  { template: "18-summer-sale", name: "Summer Sale", day: (y) => d(y, 6, 21), rule: "around Jun 21" },
  { template: "19-fourth-of-july", name: "4th of July", day: (y) => d(y, 7, 4), sendBefore: [3], rule: "Jul 4 (send Jul 1)" },
  { template: "20-midyear-clearance", name: "Mid-Year Clearance", day: (y) => d(y, 7, 15), rule: "mid-July" },
  { template: "21-back-to-school", name: "Back to School", day: (y) => d(y, 8, 1), rule: "Aug 1" },
  { template: "22-labor-day", name: "Labor Day — Workwear", day: (y) => nthWeekday(y, 9, 1, 1), rule: "1st Monday of September" },
  { template: "23-halloween", name: "Halloween", day: (y) => d(y, 10, 31), sendBefore: [4], rule: "Oct 31 (send Oct 27)" },
  { template: "24-singles-day", name: "Singles' Day 11.11", day: (y) => d(y, 11, 11), rule: "Nov 11" },
  { template: "25-black-friday", name: "Black Friday", day: (y) => plus(thanksgiving(y), 1), rule: "the day after Thanksgiving" },
  { template: "26-small-business-saturday", name: "Small Business Saturday", day: (y) => plus(thanksgiving(y), 2), rule: "the Saturday after Thanksgiving" },
  { template: "27-cyber-monday", name: "Cyber Monday", day: (y) => plus(thanksgiving(y), 4), rule: "the Monday after Thanksgiving" },
  { template: "28-gift-guide", name: "Holiday Gift Guide", day: (y) => d(y, 12, 1), rule: "Dec 1" },
  { template: "29-last-ship-day", name: "Last Shipping Day", day: (y) => d(y, 12, 16), rule: "around Dec 16" },
];

export type Upcoming = { template: string; name: string; rule: string; sendOn: string; day: string; daysLeft: number };

/** "YYYY-MM-DD" of a moment in Orlando time. */
export const orlandoDay = (t: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
const iso = (x: Date) => x.toISOString().slice(0, 10);

/** Every send in the next `days` days (a holiday with extra sends appears once per send). */
export function upcoming(now: Date, days = 400): Upcoming[] {
  const today = orlandoDay(now);
  const t0 = new Date(`${today}T12:00:00Z`).getTime();
  const y = Number(today.slice(0, 4));
  const out: Upcoming[] = [];
  for (const e of CALENDAR)
    for (const year of [y, y + 1]) {
      const day = e.day(year);
      for (const before of e.sendBefore ?? [0]) {
        const send = plus(day, -before);
        const left = Math.round((send.getTime() - t0) / 86_400_000);
        if (left >= 0 && left <= days) out.push({ template: e.template, name: e.name, rule: e.rule, sendOn: iso(send), day: iso(day), daysLeft: left });
      }
    }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}
