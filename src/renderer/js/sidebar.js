/**
 * ASRP Sidebar Component
 * Claude Code-inspired design: account at bottom-left, inline update prompt.
 */

const Sidebar = (() => {
  // SVG icon factory — monochrome, 18px, stroke-based (Claude-style)
  const svgIcon = (d, opts) => {
    const w = (opts && opts.w) || 18;
    const fill = (opts && opts.fill) || 'none';
    const sw = (opts && opts.sw) || '1.6';
    return `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  };

  const ICONS = {
    dashboard: svgIcon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    researches: svgIcon('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/>'),
    papers: svgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
    files: svgIcon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    audit: svgIcon('<polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>'),
    agents: svgIcon('<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>'),
    settings: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  };

  // Navigation items — Account section removed (now in footer)
  const navItems = [
    { section: 'Overview', items: [
      { route: '/dashboard',   icon: ICONS.dashboard,   label: 'Dashboard',   id: 'nav-dashboard' },
    ]},
    { section: 'Research', items: [
      { route: '/researches',  icon: ICONS.researches,  label: 'Researches',  id: 'nav-researches' },
      { route: '/papers',      icon: ICONS.papers,      label: 'Papers',       id: 'nav-papers' },
      { route: '/files',       icon: ICONS.files,       label: 'Files',        id: 'nav-files' },
      { route: '/audit',       icon: ICONS.audit,       label: 'Audit Log',    id: 'nav-audit' },
    ]},
    { section: 'Agents', items: [
      { route: '/agents',      icon: ICONS.agents,      label: 'Agents',       id: 'nav-agents' },
    ]},
    { section: 'System', items: [
      { route: '/settings',    icon: ICONS.settings,    label: 'Settings',     id: 'nav-settings' },
    ]},
  ];

  let currentActive = null;
  let isCollapsed = false;

  function render() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    let html = `
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="sidebar-logo-full">ASRP</span>
          <span class="sidebar-logo-icon" style="display:none">A</span>
        </div>
        <div class="sidebar-version sidebar-full-only" id="sidebar-version-label">v...</div>
        <button
          class="sidebar-collapse-btn btn btn-ghost"
          id="sidebar-collapse-btn"
          onclick="Sidebar.toggleCollapse()"
          title="Toggle sidebar (Ctrl+B)"
          style="margin-left:auto;padding:2px 5px;font-size:13px;opacity:0.6"
        >‹</button>
      </div>
      <div class="sidebar-nav">
    `;

    for (const group of navItems) {
      html += `<div class="sidebar-section sidebar-full-only">${group.section}</div>`;
      html += `<div class="sidebar-section sidebar-icon-only" style="display:none">·</div>`;
      for (const item of group.items) {
        html += `
          <button
            class="sidebar-item"
            id="${item.id}"
            onclick="Router.navigate('${item.route}')"
            title="${item.label}"
            data-tooltip="${item.label}"
          >
            <span class="item-icon">${item.icon}</span>
            <span class="item-label sidebar-full-only">${item.label}</span>
          </button>
        `;
      }
    }

    html += `</div>`;

    // Update prompt (hidden by default, shown when update is ready)
    html += `
      <div class="sidebar-update" id="sidebar-update" style="display:none">
        <div class="sidebar-update-inner" id="sidebar-update-inner">
          <div class="sidebar-update-icon" id="sidebar-update-icon">🌿</div>
          <div class="sidebar-update-text sidebar-full-only">
            <div id="sidebar-update-title" style="font-weight:600;font-size:12px">Update available</div>
            <div id="sidebar-update-sub" style="font-size:11px;color:var(--text-tertiary);margin-top:1px">Relaunch to apply</div>
          </div>
          <button class="sidebar-update-btn sidebar-full-only" id="sidebar-update-btn" onclick="Sidebar.handleUpdate()">Relaunch</button>
        </div>
        <div class="sidebar-update-progress" id="sidebar-update-progress" style="display:none">
          <div class="sidebar-update-progress-bar" id="sidebar-update-progress-bar"></div>
        </div>
      </div>
    `;

    // Footer: account info (Claude-style)
    html += `
      <div class="sidebar-footer" id="sidebar-footer">
        <div class="sidebar-account" id="sidebar-account" onclick="Sidebar.toggleAccountMenu()">
          <div class="sidebar-avatar" id="sidebar-avatar">J</div>
          <div class="sidebar-account-info sidebar-full-only">
            <div class="sidebar-account-name" id="sidebar-account-name">User</div>
            <div class="sidebar-account-plan" id="sidebar-account-plan"></div>
          </div>
          <span class="sidebar-account-arrow sidebar-full-only" id="sidebar-account-arrow">⌃</span>
        </div>
        <div class="sidebar-account-menu" id="sidebar-account-menu" style="display:none">
          <button class="sidebar-account-menu-item" onclick="Router.navigate('/settings');Sidebar.closeAccountMenu()">
            <span>⚙️</span><span>Settings</span>
          </button>
          <button class="sidebar-account-menu-item" onclick="Sidebar.handleLogout()">
            <span>🚪</span><span>Logout</span>
          </button>
        </div>
      </div>
    `;

    sidebar.innerHTML = html;

    if (isCollapsed) applyCollapse(true);
    loadAccountInfo();
    loadVersion();
    setupUpdateListener();
  }

  // ---- Account ----
  function loadAccountInfo() {
    try {
      const raw = localStorage.getItem('asrp_user');
      if (raw) {
        const user = JSON.parse(raw);
        const nameEl = document.getElementById('sidebar-account-name');
        const avatarEl = document.getElementById('sidebar-avatar');
        const planEl = document.getElementById('sidebar-account-plan');
        if (nameEl && user.name) nameEl.textContent = user.name;
        if (avatarEl && user.name) avatarEl.textContent = user.name.charAt(0).toUpperCase();
        if (planEl) planEl.textContent = user.plan || '';
      }
    } catch { /* ignore */ }
  }

  function toggleAccountMenu() {
    const menu = document.getElementById('sidebar-account-menu');
    const arrow = document.getElementById('sidebar-account-arrow');
    if (!menu) return;
    const visible = menu.style.display !== 'none';
    menu.style.display = visible ? 'none' : 'flex';
    if (arrow) arrow.textContent = visible ? '⌃' : '⌄';
  }

  function closeAccountMenu() {
    const menu = document.getElementById('sidebar-account-menu');
    const arrow = document.getElementById('sidebar-account-arrow');
    if (menu) menu.style.display = 'none';
    if (arrow) arrow.textContent = '⌃';
  }

  // Close account menu when clicking outside
  document.addEventListener('click', (e) => {
    const footer = document.getElementById('sidebar-footer');
    if (footer && !footer.contains(e.target)) {
      closeAccountMenu();
    }
  });

  // ---- Update prompt (Claude-style inline in sidebar) ----
  let _updateState = 'idle';
  let _updateVersion = '';

  function setupUpdateListener() {
    if (!window.asrp || !window.asrp.updater || !window.asrp.updater.onStatus) return;
    window.asrp.updater.onStatus(function(status) {
      const el = document.getElementById('sidebar-update');
      const titleEl = document.getElementById('sidebar-update-title');
      const subEl = document.getElementById('sidebar-update-sub');
      const iconEl = document.getElementById('sidebar-update-icon');
      const btnEl = document.getElementById('sidebar-update-btn');
      const progressEl = document.getElementById('sidebar-update-progress');
      const progressBar = document.getElementById('sidebar-update-progress-bar');

      if (!el) return;

      if (status.downloading) {
        _updateState = 'downloading';
        _updateVersion = status.version || '';
        el.style.display = '';
        if (iconEl) iconEl.textContent = '⬇';
        if (titleEl) titleEl.textContent = 'Downloading v' + _updateVersion;
        if (subEl) subEl.textContent = (status.progress || 0) + '%';
        if (btnEl) btnEl.style.display = 'none';
        if (progressEl) progressEl.style.display = '';
        if (progressBar) progressBar.style.width = (status.progress || 0) + '%';
      } else if (status.ready) {
        _updateState = 'ready';
        _updateVersion = status.version || '';
        el.style.display = '';
        el.className = 'sidebar-update ready';
        if (iconEl) iconEl.textContent = '🌿';
        if (titleEl) titleEl.textContent = 'Updated to ' + _updateVersion;
        if (subEl) subEl.textContent = 'Relaunch to apply';
        if (btnEl) { btnEl.style.display = ''; btnEl.textContent = 'Relaunch'; }
        if (progressEl) progressEl.style.display = 'none';
        // Also hide the old bottom bar if present
        const oldBar = document.getElementById('update-bar');
        if (oldBar) oldBar.style.display = 'none';
      } else if (status.available && !status.downloading) {
        _updateState = 'available';
        _updateVersion = status.version || '';
        el.style.display = '';
        if (iconEl) iconEl.textContent = '🔔';
        if (titleEl) titleEl.textContent = 'v' + _updateVersion + ' available';
        if (subEl) subEl.textContent = 'Downloading...';
        if (btnEl) btnEl.style.display = 'none';
        if (progressEl) progressEl.style.display = 'none';
        // Auto-start download
        if (window.asrp.updater.download) {
          window.asrp.updater.download();
        }
      } else if (status.error) {
        _updateState = 'idle';
        // Don't show for errors — keep sidebar clean
        el.style.display = 'none';
      }
    });
  }

  function handleUpdate() {
    if (_updateState === 'ready') {
      const btn = document.getElementById('sidebar-update-btn');
      if (btn) { btn.textContent = 'Restarting...'; btn.disabled = true; }
      if (window.asrp && window.asrp.updater) {
        window.asrp.updater.install().then(function() {
          setTimeout(function() {
            if (btn) { btn.textContent = 'Relaunch'; btn.disabled = false; }
            if (window.showToast) window.showToast('Update may have failed. Please restart manually.', 'warning', 8000);
          }, 30000);
        }).catch(function(err) {
          if (btn) { btn.textContent = 'Relaunch'; btn.disabled = false; }
          if (window.showToast) window.showToast('Install error: ' + String(err), 'error', 5000);
        });
      }
    }
  }

  // ---- Collapse ----
  function toggleCollapse() {
    isCollapsed = !isCollapsed;
    applyCollapse(isCollapsed);
  }

  function applyCollapse(collapsed) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const fullEls = sidebar.querySelectorAll('.sidebar-full-only');
    const iconEls = sidebar.querySelectorAll('.sidebar-icon-only');
    const logoFull = sidebar.querySelector('.sidebar-logo-full');
    const logoIcon = sidebar.querySelector('.sidebar-logo-icon');
    const btn = document.getElementById('sidebar-collapse-btn');

    if (collapsed) {
      sidebar.style.width = '52px';
      sidebar.style.minWidth = '52px';
      fullEls.forEach(el => { el.style.display = 'none'; });
      iconEls.forEach(el => { el.style.display = ''; });
      if (logoFull) logoFull.style.display = 'none';
      if (logoIcon) logoIcon.style.display = '';
      if (btn) btn.textContent = '›';
    } else {
      sidebar.style.width = '';
      sidebar.style.minWidth = '';
      fullEls.forEach(el => { el.style.display = ''; });
      iconEls.forEach(el => { el.style.display = 'none'; });
      if (logoFull) logoFull.style.display = '';
      if (logoIcon) logoIcon.style.display = 'none';
      if (btn) btn.textContent = '‹';
    }
  }

  function setActive(route) {
    currentActive = route;
    for (const group of navItems) {
      for (const item of group.items) {
        const el = document.getElementById(item.id);
        if (!el) continue;
        el.classList.toggle('active', item.route === route);
      }
    }
  }

  async function loadVersion() {
    if (!window.asrp) return;
    try {
      const info = await window.asrp.system.info();
      const el = document.getElementById('sidebar-version-label');
      if (el && info.version) {
        el.textContent = 'v' + info.version;
      }
    } catch { /* ignore */ }
  }

  function init() {
    render();
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapse();
      }
    });
  }

  async function handleLogout() {
    if (!confirm('Are you sure you want to logout?')) return;
    closeAccountMenu();
    var token = localStorage.getItem('asrp_token');
    if (window.asrp && window.asrp.auth && token) {
      try { await window.asrp.auth.logout(token); } catch(e) { /* ignore */ }
    }
    localStorage.removeItem('asrp_token');
    localStorage.removeItem('asrp_user');
    if (Router.clearCache) Router.clearCache();
    if (typeof Toast !== 'undefined') Toast.show('Logged out', 'info');
    setTimeout(function() { Router.navigate('/login'); }, 300);
  }

  return {
    init, render, setActive, toggleCollapse,
    handleLogout, handleUpdate,
    toggleAccountMenu, closeAccountMenu,
    refreshWorkspace: function() {},
  };
})();

// Toast notification helper (global)
const Toast = (() => {
  function show(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icons[type] || icons.info;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }
  return { show };
})();

document.addEventListener('DOMContentLoaded', () => {
  Sidebar.init();
});
