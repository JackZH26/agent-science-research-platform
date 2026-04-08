/**
 * ASRP SPA Router
 * Hash-based routing with no page refresh.
 * Loads page fragments into #page-content.
 */

const Router = (() => {
  // Route definitions: path -> { file, title, sidebar, section }
  const routes = {
    '/login':       { file: 'pages/login.html',       title: 'Login',       sidebar: false, section: null },
    '/setup':       { file: 'pages/setup.html',        title: 'Setup',       sidebar: false, section: null },
    '/dashboard':   { file: 'pages/dashboard.html',    title: 'Dashboard',   sidebar: true,  section: 'overview' },
    '/agents':      { file: 'pages/agents.html',       title: 'Agents',      sidebar: true,  section: 'agents' },
    '/files':       { file: 'pages/files.html',        title: 'Files',       sidebar: true,  section: 'files' },
    '/papers':      { file: 'pages/papers.html',       title: 'Papers',      sidebar: true,  section: 'papers' },
    '/researches':  { file: 'pages/researches.html',   title: 'Researches', sidebar: true,  section: 'researches' },
    '/audit':       { file: 'pages/audit.html',        title: 'Audit Log',   sidebar: true,  section: 'audit' },
    '/settings':    { file: 'pages/settings.html',     title: 'Settings',    sidebar: true,  section: 'settings' },
  };

  const DEFAULT_ROUTE = '/login';
  const AUTH_ROUTE = '/login';

  let currentRoute = null;
  const pageCache = new Map();

  /**
   * Parse hash into route path
   */
  function getHashRoute() {
    const hash = window.location.hash;
    if (!hash || hash === '#') return DEFAULT_ROUTE;
    return hash.replace(/^#/, '') || DEFAULT_ROUTE;
  }

  /**
   * Navigate to a route
   */
  function navigate(path) {
    if (!path.startsWith('/')) path = '/' + path;
    window.location.hash = path;
  }

  // Preload adjacency map: when on a page, prefetch these pages in background
  const PRELOAD_MAP = {
    '/dashboard':   ['/agents', '/papers'],
    '/agents':      ['/dashboard', '/researches'],
    '/researches': ['/agents', '/audit'],
    '/papers':      ['/researches', '/files'],
    '/files':       ['/papers', '/audit'],
    '/audit':       ['/dashboard', '/researches'],
    '/settings':    ['/dashboard'],
  };

  /**
   * Load and render the current route
   */
  async function handleRoute() {
    const path = getHashRoute();
    const route = routes[path] || routes[DEFAULT_ROUTE];
    const resolvedPath = routes[path] ? path : DEFAULT_ROUTE;

    if (currentRoute === resolvedPath) return; // No change
    currentRoute = resolvedPath;

    // Show loading overlay briefly
    const loading = document.getElementById('page-loading');
    if (loading) loading.classList.add('visible');

    try {
      // Load page HTML
      const html = await loadPage(route.file);

      // Update app layout
      const app = document.getElementById('app');
      const sidebar = document.getElementById('sidebar');
      const pageContent = document.getElementById('page-content');

      if (route.sidebar) {
        app.classList.remove('fullscreen-mode');
        if (sidebar) sidebar.classList.remove('hidden');
        // Update sidebar active state
        Sidebar.setActive(resolvedPath);
        // Update breadcrumb
        updateBreadcrumb(route.title);
      } else {
        app.classList.add('fullscreen-mode');
        if (sidebar) sidebar.classList.add('hidden');
      }

      // Inject page content with fade-in transition
      if (pageContent) {
        pageContent.style.opacity = '0';
        pageContent.innerHTML = html;
        // Run any inline scripts in the loaded HTML
        executeScripts(pageContent);
        // Fade in (150ms)
        requestAnimationFrame(() => {
          pageContent.style.transition = 'opacity 0.15s ease';
          pageContent.style.opacity = '1';
        });
      }

      // Update document title
      document.title = `${route.title} — ASRP`;

      // Scroll to top
      if (pageContent) pageContent.scrollTop = 0;

      // Preload adjacent pages in background (don't await)
      const adjacents = PRELOAD_MAP[resolvedPath] || [];
      adjacents.forEach(adjPath => {
        const adjRoute = routes[adjPath];
        if (adjRoute && !pageCache.has(adjRoute.file)) {
          loadPage(adjRoute.file).catch(() => { /* ignore preload failures */ });
        }
      });

    } catch (err) {
      console.error('[Router] Failed to load route:', resolvedPath, err);
      if (document.getElementById('page-content')) {
        // Issue #5: Build error DOM with textContent to avoid XSS via err.message / route.file
        var errContainer = document.createElement('div');
        errContainer.className = 'empty-state';
        var icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = '⚠️';
        var h3 = document.createElement('h3');
        h3.textContent = 'Page Load Error';
        var p1 = document.createElement('p');
        p1.textContent = 'Could not load page: ' + route.file;
        var p2 = document.createElement('p');
        p2.style.fontFamily = 'monospace';
        p2.style.fontSize = '12px';
        p2.style.marginTop = '8px';
        p2.textContent = err.message;
        var retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-outline btn-sm';
        retryBtn.style.marginTop = '16px';
        retryBtn.textContent = 'Retry';
        retryBtn.onclick = function() { Router.clearCache(); Router.handleRoute(); };
        errContainer.appendChild(icon);
        errContainer.appendChild(h3);
        errContainer.appendChild(p1);
        errContainer.appendChild(p2);
        errContainer.appendChild(retryBtn);
        document.getElementById('page-content').appendChild(errContainer);
      }
    } finally {
      if (loading) loading.classList.remove('visible');
    }
  }

  /**
   * Fetch and cache a page fragment
   */
  async function loadPage(file) {
    if (pageCache.has(file)) {
      return pageCache.get(file);
    }

    // In Electron, file:// protocol - build relative path
    const url = file;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    pageCache.set(file, html);
    return html;
  }

  /**
   * Execute <script> tags in injected HTML
   */
  function executeScripts(container) {
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      if (oldScript.src) {
        newScript.src = oldScript.src;
      } else {
        newScript.textContent = oldScript.textContent;
      }
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  }

  /**
   * Update the breadcrumb in the content header
   */
  function updateBreadcrumb(title) {
    const breadcrumb = document.querySelector('.breadcrumb .current');
    if (breadcrumb) breadcrumb.textContent = title;
  }

  /**
   * Initialize the router
   */
  function init() {
    // Listen for hash changes
    window.addEventListener('hashchange', handleRoute);

    // Handle IPC navigate events from main process
    if (window.asrp && window.asrp.on) {
      window.asrp.on('navigate', (route) => {
        navigate(route);
      });
    }

    // Initial route
    handleRoute();
  }

  /**
   * Clear page cache (useful for hot reload / dev)
   */
  function clearCache() {
    pageCache.clear();
  }

  return { init, navigate, handleRoute, clearCache, routes };
})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', Router.init);
} else {
  Router.init();
}
