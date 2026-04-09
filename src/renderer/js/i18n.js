// ============================================================
// ASRP i18n Engine — Multi-language support
// Provides global t(key, params?) function + live language switching
// ============================================================

(function () {
  'use strict';

  var SUPPORTED = ['en', 'zh', 'zht', 'de'];
  var DEFAULT = 'en';
  var current = DEFAULT;
  var dicts = {};

  // ---- Collect locale scripts registered on window ----
  function collectLocales() {
    SUPPORTED.forEach(function (lang) {
      var key = '__i18n_' + lang;
      if (window[key]) {
        dicts[lang] = window[key];
        try { delete window[key]; } catch (e) { window[key] = undefined; }
      }
    });
  }

  // ---- Detect system language (first-launch default) ----
  function detectSystemLang() {
    var raw = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    if (raw.startsWith('zh')) {
      if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zht';
      return 'zh';
    }
    if (raw.startsWith('de')) return 'de';
    return 'en';
  }

  // ---- Resolve a dotted key from a nested object ----
  function resolve(obj, key) {
    if (!obj) return undefined;
    var parts = key.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return typeof cur === 'string' ? cur : undefined;
  }

  // ---- Translate ----
  function t(key, params) {
    var val = resolve(dicts[current], key);
    if (val === undefined) val = resolve(dicts[DEFAULT], key);
    if (val === undefined) return key; // fallback: show key

    if (params) {
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        val = val.split('{' + keys[i] + '}').join(String(params[keys[i]]));
      }
    }
    return val;
  }

  // ---- Update all data-i18n elements in current DOM ----
  function translatePage() {
    // data-i18n → textContent
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-i18n');
      if (k) els[i].textContent = t(k);
    }
    // data-i18n-html → innerHTML (for strings with simple markup)
    els = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < els.length; j++) {
      var k2 = els[j].getAttribute('data-i18n-html');
      if (k2) els[j].innerHTML = t(k2);
    }
    // data-i18n-placeholder → placeholder
    els = document.querySelectorAll('[data-i18n-placeholder]');
    for (var m = 0; m < els.length; m++) {
      var k3 = els[m].getAttribute('data-i18n-placeholder');
      if (k3) els[m].placeholder = t(k3);
    }
    // data-i18n-title → title attribute
    els = document.querySelectorAll('[data-i18n-title]');
    for (var n = 0; n < els.length; n++) {
      var k4 = els[n].getAttribute('data-i18n-title');
      if (k4) els[n].title = t(k4);
    }
  }

  // ---- Set language and broadcast ----
  function setLanguage(lang) {
    if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT;
    current = lang;
    localStorage.setItem('asrp_language', lang);
    document.documentElement.setAttribute('lang', lang === 'zht' ? 'zh-Hant' : lang);
    translatePage();
    window.dispatchEvent(new CustomEvent('language-changed', { detail: { lang: lang } }));
  }

  // ---- Init ----
  collectLocales();

  var saved = localStorage.getItem('asrp_language');
  if (saved && SUPPORTED.indexOf(saved) !== -1) {
    current = saved;
  } else {
    current = detectSystemLang();
    localStorage.setItem('asrp_language', current);
  }
  document.documentElement.setAttribute('lang', current === 'zht' ? 'zh-Hant' : current);

  // ---- Expose globally ----
  window.t = t;
  window.setLanguage = setLanguage;
  window.getLang = function () { return current; };
  window.translatePage = translatePage;
})();
