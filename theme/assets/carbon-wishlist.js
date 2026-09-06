/*
  Carbon wishlist — the store.

  This is the whole wishlist engine. It owns the saved items and nothing else:
  no UI, no network, no third-party app. Every other wishlist file on the site
  (the heart button, the wishlist page, the header count) reads and writes
  through this one object, so there is exactly one source of truth.

  Storage is the browser's localStorage, which means the wishlist works for
  every visitor immediately — logged in or not, first visit or hundredth, with
  no account and no request to any server. The trade-off is that it lives on
  one device. Syncing a logged-in customer's list across their devices is the
  job of the sync layer (see syncAdapter below), which is deliberately optional:
  if it is never installed, everything here still works exactly as it does now.

  An item is stored small on purpose — just enough to find the product again:

      { v: "<variant id>", p: "<product id>", h: "<product handle>", t: <ms> }

  Titles, prices and images are NOT stored. They are read from Shopify at
  display time via /products/<handle>.js, so a wishlist can never show a stale
  price or a product name that has since been renamed.

  Public API (window.CarbonWishlist):
      .get()               -> array of items, newest first
      .has(variantId)      -> boolean
      .add(item)           -> true if it was added (false if already there)
      .remove(variantId)   -> true if it was removed
      .toggle(item)        -> the new saved state, as a boolean
      .count()             -> number of saved items
      .subscribe(fn)       -> calls fn(items) on every change; returns an
                              unsubscribe function
      .setSyncAdapter(a)   -> install cross-device sync (see below)

  Changes also fire a `carbon:wishlist:change` event on `document`, and are
  picked up in other open tabs through the native `storage` event.
*/
(function () {
  'use strict';

  var KEY = 'carbon_wishlist_v1';
  var LIMIT = 250;            /* generous, but stops localStorage growing without bound */

  var listeners = [];
  var sync = null;
  var items = [];

  /* ---------- persistence ---------------------------------------------- */

  /* localStorage throws in Safari private mode and when a browser blocks site
     data, so every access is guarded. A wishlist that cannot persist should
     degrade to an in-memory one for the session, not break the page. */
  function readStore() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch (e) {
      return [];
    }
  }

  function writeStore(next) {
    items = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) {
      /* quota or blocked storage — keep going with the in-memory copy */
    }
    emit();
    if (sync && typeof sync.push === 'function') {
      try { sync.push(next.slice()); } catch (e) {}
    }
  }

  function valid(it) {
    return it && typeof it === 'object' && it.v != null && it.h;
  }

  function normalise(it) {
    return {
      v: String(it.v),
      p: it.p != null ? String(it.p) : '',
      h: String(it.h),
      t: typeof it.t === 'number' ? it.t : Date.now()
    };
  }

  /* ---------- notification ---------------------------------------------- */

  function emit() {
    var snapshot = items.slice();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](snapshot); } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent('carbon:wishlist:change', {
        detail: { items: snapshot, count: snapshot.length }
      }));
    } catch (e) {}
  }

  /*
    Fired only when a shopper deliberately saves something — never when a
    signed-in customer's stored list is merged in on load, and never on remove.
    UI that should react to a save (the drawer opening) listens for this rather
    than for `change`, which fires for every mutation including those merges.
  */
  function emitAdded(item) {
    try {
      document.dispatchEvent(new CustomEvent('carbon:wishlist:added', {
        detail: { item: item }
      }));
    } catch (e) {}
  }

  /* ---------- public API ------------------------------------------------ */

  var api = {
    get: function () {
      return items.slice();
    },

    has: function (variantId) {
      var id = String(variantId);
      for (var i = 0; i < items.length; i++) if (items[i].v === id) return true;
      return false;
    },

    count: function () {
      return items.length;
    },

    add: function (item) {
      if (!valid(item)) return false;
      var next = normalise(item);
      if (api.has(next.v)) return false;
      /* newest first, so the wishlist page reads as a recency list */
      writeStore([next].concat(items).slice(0, LIMIT));
      emitAdded(next);
      return true;
    },

    remove: function (variantId) {
      var id = String(variantId);
      var next = items.filter(function (it) { return it.v !== id; });
      if (next.length === items.length) return false;
      writeStore(next);
      return true;
    },

    toggle: function (item) {
      if (!valid(item)) return false;
      if (api.has(item.v)) { api.remove(item.v); return false; }
      api.add(item);
      return true;
    },

    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      try { fn(items.slice()); } catch (e) {}
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /*
      Cross-device sync, installed separately so this file never depends on it.

      An adapter is { pull: fn -> Promise<items[]>, push: fn(items) }. On
      install we pull the stored copy and union it with whatever is on this
      device, so signing in merges the two lists rather than one silently
      replacing the other — losing a shopper's saved items is much worse than
      keeping one they had already removed elsewhere.
    */
    setSyncAdapter: function (adapter) {
      sync = adapter;
      if (!adapter || typeof adapter.pull !== 'function') return;
      Promise.resolve()
        .then(function () { return adapter.pull(); })
        .then(function (remote) {
          if (!Array.isArray(remote)) return;
          var seen = Object.create(null);
          var merged = [];
          items.concat(remote.filter(valid).map(normalise)).forEach(function (it) {
            if (seen[it.v]) return;
            seen[it.v] = true;
            merged.push(it);
          });
          merged.sort(function (a, b) { return b.t - a.t; });
          writeStore(merged.slice(0, LIMIT));
        })
        .catch(function () { /* offline or endpoint down — local list stands */ });
    }
  };

  /* ---------- boot ------------------------------------------------------ */

  items = readStore();

  /* Another tab changed the wishlist — adopt it so every open tab agrees. */
  window.addEventListener('storage', function (ev) {
    if (ev.key !== KEY) return;
    items = readStore();
    emit();
  });

  window.CarbonWishlist = api;
})();
