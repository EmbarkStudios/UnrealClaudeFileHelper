// dashboard.js — Shared module for Unreal Index unified dashboard
// Loaded by all pages: setup.html, index.html, search.html, analytics.html
// Provides: WorkspaceContext, tab bar injection, shared utilities

const WorkspaceContext = {
  workspaces: {},
  active: null,
  _listeners: [],

  get servicePort() {
    const ws = this.workspaces[this.active];
    return ws ? ws.port : null;
  },

  async serviceFetch(path, opts = {}) {
    if (!this.active) throw new Error('No workspace selected');
    // Route through setup GUI proxy to avoid CORS issues
    // The setup GUI on same-origin proxies to the workspace's service port
    const sep = path.includes('?') ? '&' : '?';
    return fetch('/api/service-proxy' + path + sep + 'workspace=' + encodeURIComponent(this.active), opts);
  },

  async load() {
    try {
      const resp = await fetch('/api/workspaces');
      const data = await resp.json();
      this.workspaces = data.workspaces || {};
      // Restore from localStorage, fall back to default
      const stored = localStorage.getItem('unreal-index-workspace');
      if (stored && this.workspaces[stored]) {
        this.active = stored;
      } else if (!this.active || !this.workspaces[this.active]) {
        this.active = data.defaultWorkspace || Object.keys(this.workspaces)[0] || null;
      }
      this._updateSelector();
    } catch {
      // workspaces.json not available — single-workspace mode
    }
  },

  onSelect(name) {
    this.active = name;
    localStorage.setItem('unreal-index-workspace', name);
    this._updateSelector();
    if (window.onWorkspaceChanged) window.onWorkspaceChanged();
  },

  _updateSelector() {
    const sel = document.getElementById('workspace-selector');
    if (!sel) return;
    const names = Object.keys(this.workspaces);
    if (names.length <= 1) {
      sel.style.display = 'none';
      return;
    }
    sel.style.display = '';
    sel.innerHTML = '';
    for (const name of names) {
      const ws = this.workspaces[name];
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + (ws.port ? ` (:${ws.port})` : '');
      opt.selected = name === this.active;
      sel.appendChild(opt);
    }
  }
};

// Tab definitions
const TABS = [
  { id: 'workspaces', label: 'Workspaces', href: '/setup.html' },
  { id: 'dashboard',  label: 'Dashboard',  href: '/index.html' },
  { id: 'search',     label: 'Search',     href: '/search.html' },
  { id: 'analytics',  label: 'Analytics',  href: '/analytics.html' },
];

function initDashboard(activeTab) {
  // Inject tab bar at top of <body>
  const nav = document.createElement('div');
  nav.id = 'dashboard-nav';
  nav.innerHTML = `
    <span class="dashboard-title">Unreal Index</span>
    ${TABS.map(t => {
      const cls = t.id === activeTab ? 'main-tab active' : 'main-tab';
      return `<a href="${t.href}" class="${cls}" data-tab="${t.id}">${t.label}</a>`;
    }).join('')}
    <select id="workspace-selector" onchange="WorkspaceContext.onSelect(this.value)"
      style="${activeTab === 'workspaces' ? 'display:none' : ''}"></select>
  `;
  document.body.prepend(nav);

  // Inject nav styles
  const style = document.createElement('style');
  style.textContent = `
    #dashboard-nav {
      display: flex; align-items: center; gap: 4px;
      padding: 8px 16px; margin: -20px -20px 20px -20px;
      background: #1a1a2e; border-bottom: 1px solid #3e3e3e;
    }
    .dashboard-title {
      font-size: 14px; font-weight: 600; color: #569cd6;
      margin-right: 12px;
    }
    .main-tab {
      padding: 6px 14px; font-size: 13px; color: #808080;
      text-decoration: none; border-radius: 3px;
    }
    .main-tab:hover { color: #d4d4d4; background: #252530; }
    .main-tab.active {
      color: #9cdcfe; background: #264f78;
    }
    #workspace-selector {
      margin-left: auto;
      background: #333; color: #d4d4d4; border: 1px solid #3e3e3e;
      padding: 4px 8px; border-radius: 3px; font-size: 13px;
    }
  `;
  document.head.appendChild(style);

  // Load workspace context (for non-workspaces tabs)
  if (activeTab !== 'workspaces') {
    WorkspaceContext.load();
  }
}

// ── Shared utilities ──────────────────────────────────

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}

function formatTime(ts) {
  if (!ts) return '\u2014';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function formatRelative(ts, future = false) {
  if (!ts) return '\u2014';
  const diff = future
    ? new Date(ts).getTime() - Date.now()
    : Date.now() - new Date(ts).getTime();
  if (diff < 0 && !future) return 'just now';
  const abs = Math.abs(diff);
  if (abs < 60000) return Math.round(abs / 1000) + 's ago';
  if (abs < 3600000) return Math.round(abs / 60000) + 'm ago';
  if (abs < 86400000) return Math.round(abs / 3600000) + 'h ago';
  return Math.round(abs / 86400000) + 'd ago';
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}
