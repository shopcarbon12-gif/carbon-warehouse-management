package com.shopcarbon.wmspc.web

/**
 * Injected after every page load (idempotent). No change to the web app is needed:
 *  - window.print()            → native print dialog (WebView has no window.print)
 *  - <a download href="blob:"> → bytes handed to native → Downloads (WebView cannot download blob: URLs)
 *  - <a download href="http…"> → DownloadManager with session cookie
 *  - window.CarbonWMSPC        → promise-based bridge (printZpl over TCP 9100, saveBlob, version, device)
 *  - html.wms-native-app       → optional CSS hook for the web app (unused today)
 * Kotlin raw string: no `$` inside the JS on purpose.
 */
object JsShims {
    val SOURCE: String = """
(function () {
  if (window.__cwmsShim) return;
  var N = window.CarbonWMSPCNative;
  if (!N) return;
  window.__cwmsShim = true;
  try { document.documentElement.classList.add('wms-native-app'); } catch (e) {}

  var pending = {};
  var seq = 0;
  window.__cwmsResolve = function (id, ok, msg) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    p({ ok: !!ok, message: msg });
  };

  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  window.CarbonWMSPC = {
    version: N.version(),
    device: N.device(),
    print: function () { N.print(); },
    printZpl: function (host, port, zpl) {
      return new Promise(function (res) {
        var id = 'p' + (++seq);
        pending[id] = res;
        N.printZpl(id, String(host), Number(port) || 9100, String(zpl));
      });
    },
    saveBlob: function (name, blob) {
      return blobToB64(blob).then(function (b64) {
        return N.saveBlob(String(name || 'download'), blob.type || 'application/octet-stream', b64);
      });
    },
    setBusy: function (label, busy) { try { N.setBusy(String(label || 'Working…'), !!busy); } catch (e) {} },
    log: function (m) { N.log(String(m)); }
  };

  window.print = function () { N.print(); };

  var blobs = new Map();
  var origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var u = origCreate(obj);
    if (obj instanceof Blob) blobs.set(u, obj);
    return u;
  };
  var origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (u) { blobs.delete(u); return origRevoke(u); };

  function handleAnchor(a) {
    if (!a || !a.hasAttribute || !a.hasAttribute('download')) return false;
    var href = a.getAttribute('href') || '';
    var name = a.getAttribute('download') || '';
    if (href.indexOf('blob:') === 0) {
      var b = blobs.get(href);
      if (!b) return false;
      var nm = name || 'download';
      blobToB64(b).then(function (b64) { N.saveBlob(nm, b.type || 'application/octet-stream', b64); });
      return true;
    }
    if (/^https?:/i.test(href) || href.indexOf('/') === 0) {
      var abs;
      try { abs = new URL(href, location.href).href; } catch (e) { return false; }
      N.downloadUrl(abs, name);
      return true;
    }
    return false;
  }

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (handleAnchor(this)) return;
    return origClick.apply(this, arguments);
  };
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[download]') : null;
    if (a && handleAnchor(a)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
""".trimIndent()
}
