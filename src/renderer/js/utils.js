// ============================================================
// ASRP Global Utilities
// Shared helpers used across all page scripts.
// Loaded before page fragments — available as window.Utils.*
// ============================================================

(function () {
  'use strict';

  // ---- HTML escaping (prevents XSS in innerHTML contexts) ----
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Page lifecycle cleanup ----
  // Pages register cleanup callbacks; router calls runPageCleanup() before unloading.
  var _cleanupCallbacks = [];

  function onPageUnload(fn) {
    if (typeof fn === 'function') _cleanupCallbacks.push(fn);
  }

  function runPageCleanup() {
    for (var i = 0; i < _cleanupCallbacks.length; i++) {
      try { _cleanupCallbacks[i](); } catch (e) { console.warn('[cleanup]', e); }
    }
    _cleanupCallbacks = [];
  }

  // ---- Toast (single source of truth) ----
  // Delegates to existing Toast.show or showToast, whichever is available
  function toast(message, type) {
    if (typeof Toast !== 'undefined' && Toast.show) {
      Toast.show(message, type);
    } else if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      console.log('[Toast]', type, message);
    }
  }

  // ---- Logout (single source of truth) ----
  function logout() {
    var token = localStorage.getItem('token');
    if (token && window.asrp && window.asrp.auth) {
      window.asrp.auth.logout(token).catch(function () {});
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (window.Router && window.Router.clearCache) window.Router.clearCache();
    window.location.hash = '#/login';
  }

  // ---- Expose ----
  window.Utils = {
    escHtml: escHtml,
    onPageUnload: onPageUnload,
    runPageCleanup: runPageCleanup,
    toast: toast,
    logout: logout,
  };

  // Also expose escHtml as a standalone global for backward compatibility
  window.escHtml = escHtml;

})();
