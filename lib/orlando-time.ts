/**
 * Store time zone. Everything Carbon shows is in Orlando time, whatever
 * time zone the viewer's computer is set to.
 */
export const STORE_TZ = "America/New_York";

/**
 * Makes Orlando the DEFAULT time zone for every date/time display in the
 * browser: Date#toLocaleString / toLocaleDateString / toLocaleTimeString
 * and Intl.DateTimeFormat. An explicit `timeZone` option still wins.
 * Injected as an inline <script> at the top of the root layout so it runs
 * before any app code, and loaded on the server too (containers already
 * run TZ=America/New_York, so server and browser render identically).
 */
export const ORLANDO_TIME_PATCH = `(function(){
  var TZ = ${JSON.stringify(STORE_TZ)};
  var g = typeof globalThis !== "undefined" ? globalThis : window;
  if (g.__carbonTzPatched) return;
  g.__carbonTzPatched = true;
  function withTz(o) {
    if (o && o.timeZone) return o;
    var n = {}; if (o) for (var k in o) n[k] = o[k];
    n.timeZone = TZ; return n;
  }
  var D = Intl.DateTimeFormat;
  function P(l, o) { return new D(l, withTz(o)); }
  P.prototype = D.prototype;
  P.supportedLocalesOf = function(l, o) { return D.supportedLocalesOf(l, o); };
  Intl.DateTimeFormat = P;
  var p = Date.prototype;
  var a = p.toLocaleString, b = p.toLocaleDateString, c = p.toLocaleTimeString;
  p.toLocaleString = function(l, o) { return a.call(this, l, withTz(o)); };
  p.toLocaleDateString = function(l, o) { return b.call(this, l, withTz(o)); };
  p.toLocaleTimeString = function(l, o) { return c.call(this, l, withTz(o)); };
})();`;

/** Orlando calendar date "YYYY-MM-DD" for a moment (default: now). */
export function orlandoDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
