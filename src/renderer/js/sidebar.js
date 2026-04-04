/**
 * ASRP Desktop Sidebar Component
 * Mint Apple style sidebar with icons, labels, and active state.
 */

const Sidebar = (() => {
  // Navigation items definition
  const navItems = [
    // Section: Overview
    { section: 'Overview', items: [
      { route: '/dashboard',   icon: '📊', label: 'Dashboard',   id: 'nav-dashboard' },
    ]},
    // Section: Research
    { section: 'Research', items: [
      { route: '/experiments', icon: '🧪', label: 'Experiments',  id: 'nav-experiments' },
      { route: '/papers',      icon: '📄', label: 'Papers',       id: 'nav-papers' },
      { route: '/files',       icon: '🗂️', label: 'Files',        id: 'nav-files' },
      { route: '/audit',       icon: '📝', label: 'Audit Log',    id: 'nav-audit' },
    ]},
    // Section: Agents
    { section: 'Agents', items: [
      { route: '/agents',      icon: '🤖', label: 'All Agents',   id: 'nav-agents' },
    ]},
    // Section: System
    { section: 'System', items: [
      { route: '/settings',    icon: '⚙️', label: 'Settings',     id: 'nav-settings' },
    ]},
    // Section: Account
    { section: 'Account', items: [
      { route: '#logout',      icon: '🚪', label: 'Logout',       id: 'nav-logout' },
    ]},
  ];

  let currentActive = null;
  let isCollapsed = false;

  /**
   * Build and inject the sidebar HTML
   */
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
        const clickAction = item.route === '#logout'
          ? `Sidebar.handleLogout()`
          : `Router.navigate('${item.route}')`;
        html += `
          <button
            class="sidebar-item"
            id="${item.id}"
            onclick="${clickAction}"
            title="${item.label}"
            data-tooltip="${item.label}"
          >
            <span class="item-icon">${item.icon}</span>
            <span class="item-label sidebar-full-only">${item.label}</span>
          </button>
        `;
      }
    }

    html += `</div>`;  // close sidebar-nav

    // Footer with workspace info
    html += `
      <div class="sidebar-footer">
        <div class="sidebar-workspace sidebar-full-only" id="sidebar-workspace-info">
          <strong>Workspace</strong><br>
          <span id="sidebar-workspace-path">~/asrp-workspace</span>
        </div>
        <div class="sidebar-icon-only" style="display:none;text-align:center;font-size:18px">🗂️</div>
      </div>
    `;

    sidebar.innerHTML = html;

    // Restore collapse state
    if (isCollapsed) applyCollapse(true);

    // Load workspace path from settings
    loadWorkspaceInfo();

    // Load version dynamically
    loadVersion();
  }

  /**
   * Toggle sidebar narrow/wide mode
   */
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

  /**
   * Set the active navigation item
   */
  function setActive(route) {
    if (currentActive === route) {
      // Still update visual state in case DOM was re-rendered
    }
    currentActive = route;

    // Find all nav items and update active class
    for (const group of navItems) {
      for (const item of group.items) {
        const el = document.getElementById(item.id);
        if (!el) continue;
        if (item.route === route) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    }
  }

  /**
   * Load workspace info from settings
   */
  async function loadWorkspaceInfo() {
    if (!window.asrp) return;
    try {
      const workspace = await window.asrp.system.workspace();
      const el = document.getElementById('sidebar-workspace-path');
      if (el && workspace.path) {
        // Show shortened path
        const parts = workspace.path.split(/[/\\]/);
        const short = parts.length > 3
          ? '~/' + parts.slice(-2).join('/')
          : workspace.path;
        el.textContent = short;
        el.title = workspace.path;
      }
    } catch {
      // Ignore — just keep the default text
    }
  }

  /**
   * Load version from system info
   */
  async function loadVersion() {
    if (!window.asrp) return;
    try {
      const info = await window.asrp.system.info();
      const el = document.getElementById('sidebar-version-label');
      if (el && info.version) {
        el.textContent = 'v' + info.version;
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Initialize sidebar
   */
  function init() {
    render();

    // Keyboard shortcut: Ctrl/Cmd+B to toggle sidebar
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapse();
      }
    });
  }

  /**
   * Handle logout from sidebar
   */
  async function handleLogout() {
    if (!confirm('Are you sure you want to logout?')) return;
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

  return { init, render, setActive, toggleCollapse, handleLogout };
})();

// Toast notification helper (global)
const Toast = (() => {
  function show(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // H1: Use DOM methods instead of innerHTML to prevent XSS from message content
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

// Init sidebar when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  Sidebar.init();
});
