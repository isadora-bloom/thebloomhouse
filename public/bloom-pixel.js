/**
 * Bloom House — site pixel (Wave 6E follow-up)
 *
 * Drop the snippet below into the head of every page on the venue's
 * marketing site. It:
 *   1. Sets a first-party cookie `bloom_visitor_id` on first load (1-year
 *      max-age). Same visitor across sessions keeps the same id.
 *   2. Reads UTM params + ad-platform click ids (gclid/fbclid/ttclid/
 *      msclkid) from the URL.
 *   3. POSTs the page metadata to https://YOUR_BLOOM_DOMAIN/api/v1/visit
 *      with the venue's pixel_ingest_key.
 *
 * Embed via:
 *   <script>
 *     window.BLOOM_PIXEL_KEY = "<PIXEL_INGEST_KEY>";
 *     window.BLOOM_PIXEL_ENDPOINT = "https://YOUR_BLOOM_DOMAIN/api/v1/visit";
 *   </script>
 *   <script async src="https://YOUR_BLOOM_DOMAIN/bloom-pixel.js"></script>
 *
 * If the venue's web form submits to Bloom via the existing web-form
 * adapter, the cookie travels with the form payload and the resolver
 * ties the anonymous visit history to the new candidate identity.
 */
(function () {
  'use strict'
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  // Guard against double-load.
  if (window.__bloom_pixel_loaded) return
  window.__bloom_pixel_loaded = true

  var KEY = window.BLOOM_PIXEL_KEY
  var ENDPOINT = window.BLOOM_PIXEL_ENDPOINT
  if (!KEY || !ENDPOINT) {
    // Misconfiguration — log to console so the venue's web team can
    // find it but don't throw (a failed pixel must not break the host
    // page).
    if (window.console && console.warn) {
      console.warn('[bloom-pixel] missing BLOOM_PIXEL_KEY or BLOOM_PIXEL_ENDPOINT')
    }
    return
  }

  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID()
    }
    // RFC4122-ish fallback.
    var bytes = new Array(16)
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes)
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    var hex = []
    for (var j = 0; j < 16; j++) {
      var b = (bytes[j] | 0) & 0xff
      hex.push((b < 16 ? '0' : '') + b.toString(16))
    }
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    )
  }

  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp('(?:^|; )' + name.replace(/[-.+*]/g, '\\$&') + '=([^;]*)'),
    )
    return match ? decodeURIComponent(match[1]) : null
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 86400000).toUTCString()
    document.cookie =
      name +
      '=' +
      encodeURIComponent(value) +
      '; expires=' +
      expires +
      '; path=/; SameSite=Lax'
  }

  var visitorId = getCookie('bloom_visitor_id')
  if (!visitorId) {
    visitorId = uuidv4()
    setCookie('bloom_visitor_id', visitorId, 365)
  }
  // Expose for the form adapter to copy into the form payload.
  window.__bloom_visitor_id = visitorId

  function paramsFromUrl() {
    var search = (window.location && window.location.search) || ''
    var params = new URLSearchParams(search)
    function get(name) {
      var v = params.get(name)
      if (!v) return undefined
      v = v.trim()
      return v.length === 0 ? undefined : v.slice(0, 500)
    }
    return {
      utm: {
        source: get('utm_source'),
        medium: get('utm_medium'),
        campaign: get('utm_campaign'),
        term: get('utm_term'),
        content: get('utm_content'),
      },
      cids: {
        gclid: get('gclid'),
        fbclid: get('fbclid'),
        ttclid: get('ttclid'),
        msclkid: get('msclkid'),
      },
    }
  }

  function send() {
    var p = paramsFromUrl()
    var body = JSON.stringify({
      k: KEY,
      v: visitorId,
      u: window.location.href,
      r: document.referrer || '',
      ts: Date.now(),
      utm: p.utm,
      cids: p.cids,
    })
    // Use sendBeacon when available so the request survives page
    // navigation. Fallback to fetch keepalive.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          ENDPOINT,
          new Blob([body], { type: 'application/json' }),
        )
        return
      }
    } catch (_) {}
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit',
      }).catch(function () {})
    } catch (_) {}
  }

  // Fire on every pageview. For SPAs we also listen for popstate +
  // a custom event the host site can fire on virtual page change.
  send()
  window.addEventListener('popstate', send)
  window.addEventListener('bloom:pageview', send)
})()
