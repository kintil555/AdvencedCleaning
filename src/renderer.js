// ── Layout fix: wrap sidebar + content ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app     = document.getElementById('app');
  const titlebar = document.getElementById('titlebar');
  const sidebar = document.getElementById('sidebar');
  const content = document.getElementById('content');

  const bodyWrap = document.createElement('div');
  bodyWrap.id = 'body-wrap';
  bodyWrap.style.cssText = 'display:flex;flex:1;overflow:hidden;';
  app.appendChild(bodyWrap);
  bodyWrap.appendChild(sidebar);
  bodyWrap.appendChild(content);
});

// ── Window controls ─────────────────────────────────────────────────────────
document.getElementById('btn-min').addEventListener('click',   () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click',   () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

// ── Navigation ──────────────────────────────────────────────────────────────
const navBtns = document.querySelectorAll('.nav-btn');
const pages   = document.querySelectorAll('.page');

navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.page;
    navBtns.forEach(b => b.classList.remove('active'));
    pages.forEach(p  => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`page-${target}`).classList.add('active');
    if (target === 'startup') loadStartupItems();
  });
});

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const area = document.getElementById('toast-area');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  area.appendChild(el);
  requestAnimationFrame(() => { el.classList.add('show'); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 2800);
}

// ── Log helper ───────────────────────────────────────────────────────────────
function appendLog(box, data) {
  if (!data || !data.data) return;
  const line = document.createElement('div');
  if (data.type === 'stderr')  line.className = 'log-line-stderr';
  else if (data.type === 'done') line.className = 'log-line-done';
  else                           line.className = 'log-line-stdout';
  line.textContent = data.type === 'done'
    ? `✓ Process exited (code ${data.code})`
    : data.data;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════
async function loadDashboard() {
  // System info
  const si = await window.api.getSystemInfo();
  document.getElementById('si-os').textContent     = `Windows ${si.release}`;
  document.getElementById('si-arch').textContent   = si.arch;
  document.getElementById('si-cpu').textContent    = `${si.cpus} cores`;
  document.getElementById('si-host').textContent   = si.hostname;
  document.getElementById('si-uptime').textContent = `${si.uptime}h`;
  document.getElementById('si-tmp').textContent    = si.tmpDir;

  // Memory
  document.getElementById('mem-used').textContent  = si.usedMem;
  document.getElementById('mem-total').textContent = si.totalMem;
  document.getElementById('mem-pct').textContent   = `${si.memPercent}%`;
  const bar = document.getElementById('mem-bar');
  bar.style.width = `${si.memPercent}%`;
  bar.classList.toggle('warn',   si.memPercent >= 70 && si.memPercent < 85);
  bar.classList.toggle('danger', si.memPercent >= 85);

  // Disks
  const disks = await window.api.getDiskInfo();
  const dl = document.getElementById('disk-list');
  dl.innerHTML = '';
  if (!disks.length) {
    dl.innerHTML = `<div class="empty-state">
        <img src="images/Building.png" alt="no data"/>
        <div class="empty-state-text">No disk data available</div>
        <div class="empty-state-sub">Requires Windows with WMIC support</div>
      </div>`;
  } else {
    disks.forEach(d => {
      const el = document.createElement('div');
      el.className = 'disk-item';
      el.innerHTML = `
        <div class="disk-letter">${d.caption}</div>
        <div class="disk-bar-wrap">
          <div class="disk-bar ${d.percent>=90?'danger':d.percent>=70?'warn':''}" style="width:${d.percent}%"></div>
        </div>
        <div class="disk-label">${d.used} / ${d.total} GB (${d.percent}%)</div>
      `;
      dl.appendChild(el);
    });
  }
}

// Quick actions
document.getElementById('qa-refresh').addEventListener('click', loadDashboard);

document.getElementById('qa-flush-dns').addEventListener('click', async () => {
  toast('Flushing DNS...', 'warn');
  await window.api.runClean(['dns']);
  toast('DNS flushed!', 'success');
});

document.getElementById('qa-clean-all').addEventListener('click', async () => {
  const resultBox = document.getElementById('quick-result');
  resultBox.innerHTML = '';
  resultBox.classList.remove('hidden');
  window.api.removeCleanLog();
  window.api.onCleanLog(data => appendLog(resultBox, data));
  toast('Quick clean started...', 'warn');
  await window.api.runClean(['tempFiles', 'browserCache', 'recyclebin', 'dns']);
  toast('Quick clean done!', 'success');
  window.api.removeCleanLog();
  loadDashboard();
});

// ═══════════════════════════════════════════════════════════════════
//  CLEANER PAGE
// ═══════════════════════════════════════════════════════════════════
// Checkbox toggle
document.querySelectorAll('.ore-checkbox').forEach(cb => {
  cb.addEventListener('click', e => {
    e.stopPropagation();
    cb.classList.toggle('on');
  });
});
document.querySelectorAll('.clean-item').forEach(item => {
  item.addEventListener('click', () => {
    const cb = item.querySelector('.ore-checkbox');
    if (cb) cb.classList.toggle('on');
  });
});

document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('.ore-checkbox').forEach(cb => cb.classList.add('on'));
});
document.getElementById('btn-deselect-all').addEventListener('click', () => {
  document.querySelectorAll('.ore-checkbox').forEach(cb => cb.classList.remove('on'));
});

// Load estimated sizes
async function loadSizes() {
  const sizes = await window.api.estimateSizes();
  Object.entries(sizes).forEach(([key, mb]) => {
    const el = document.getElementById(`sz-${key}`);
    if (el) {
      if (mb >= 1024)     el.textContent = `${(mb/1024).toFixed(2)} GB`;
      else if (mb > 0)    el.textContent = `${mb.toFixed(1)} MB`;
      else                el.textContent = '0 B';
    }
  });
}

// Start cleaning
document.getElementById('btn-start-clean').addEventListener('click', async () => {
  const selected = [];
  document.querySelectorAll('.ore-checkbox.on').forEach(cb => {
    if (cb.dataset.task) selected.push(cb.dataset.task);
  });
  if (!selected.length) { toast('Select at least one item!', 'warn'); return; }

  const btn      = document.getElementById('btn-start-clean');
  const progress = document.getElementById('clean-progress');
  const progBar  = document.getElementById('clean-progress-bar');
  const progLbl  = document.getElementById('clean-progress-label');
  const logBox   = document.getElementById('clean-log');

  btn.disabled = true;
  progress.classList.remove('hidden');
  logBox.classList.remove('hidden');
  logBox.innerHTML = '';
  progBar.style.width = '0%';

  const total = selected.length;
  let done = 0;

  window.api.removeCleanLog();
  window.api.onCleanLog(data => {
    appendLog(logBox, data);
    if (data.type === 'done') {
      done++;
      const pct = Math.round((done / total) * 100);
      progBar.style.width = `${pct}%`;
      progLbl.textContent = `${done}/${total} tasks complete (${pct}%)`;
    }
  });

  toast('Cleaning started...', 'warn');
  progLbl.textContent = 'Cleaning...';
  await window.api.runClean(selected);

  progBar.style.width = '100%';
  progLbl.textContent = 'All done!';
  toast('Cleaning complete!', 'success');
  btn.disabled = false;
  window.api.removeCleanLog();
  loadSizes();
  loadDashboard();
});

// ═══════════════════════════════════════════════════════════════════
//  STARTUP MANAGER
// ═══════════════════════════════════════════════════════════════════
async function loadStartupItems() {
  const list = document.getElementById('startup-list');
  list.innerHTML = '<div class="loading-state"><img src="images/Loading.gif" alt="loading"/><span>Loading startup items...</span></div>';
  const items = await window.api.getStartupItems();
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
        <img src="images/Building.png" alt="empty"/>
        <div class="empty-state-text">No startup items found</div>
        <div class="empty-state-sub">Try running as Administrator for full access</div>
      </div>`;
    return;
  }
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'startup-item';
    el.innerHTML = `
      <div class="startup-item-info">
        <div class="startup-item-name">${escHtml(item.Name)}</div>
        <div class="startup-item-path">${escHtml(item.Path || '')}</div>
        <div class="startup-item-loc">${escHtml(item.Location || '')}</div>
      </div>
      <div class="startup-actions">
        <button class="ore-btn red-btn small-btn" data-name="${escHtml(item.Name)}" data-loc="${escHtml(item.Location || '')}">🗑 Remove</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Remove "${item.Name}" from startup?`)) return;
      const ok = await window.api.toggleStartupItem({ name: item.Name, location: item.Location, enable: false });
      toast(ok ? `Removed: ${item.Name}` : 'Failed (try as Administrator)', ok ? 'success' : 'error');
      if (ok) el.remove();
    });
    list.appendChild(el);
  });
}

document.getElementById('btn-refresh-startup').addEventListener('click', loadStartupItems);

// ═══════════════════════════════════════════════════════════════════
//  TOOLS PAGE
// ═══════════════════════════════════════════════════════════════════
const toolLog = document.getElementById('tool-log');

function startTool(label, fn) {
  return async () => {
    toolLog.classList.remove('hidden');
    toolLog.innerHTML = `<div class="log-line-info">▶ Starting: ${label}</div>`;
    window.api.removeToolLog();
    window.api.onToolLog(data => appendLog(toolLog, data));
    toast(`Running ${label}...`, 'warn');
    await fn();
    toast(`${label} complete!`, 'success');
    window.api.removeToolLog();
  };
}

document.getElementById('btn-sfc').addEventListener('click',
  startTool('SFC Scan', () => window.api.runSfc()));

document.getElementById('btn-dism').addEventListener('click',
  startTool('DISM Repair', () => window.api.runDism()));

document.getElementById('btn-diskcleanup').addEventListener('click', async () => {
  toast('Opening Disk Cleanup...', 'warn');
  await window.api.runDiskCleanup();
});

document.getElementById('btn-netreset').addEventListener('click',
  startTool('Network Reset', () => window.api.runNetworkReset()));

document.getElementById('btn-ramopt').addEventListener('click',
  startTool('RAM Optimizer', () => window.api.runClean(['ramOptimize'])));

document.getElementById('btn-eventvwr').addEventListener('click', () => {
  window.api.openExternal('eventvwr.msc');
  toast('Opening Event Viewer...', '');
});

// ═══════════════════════════════════════════════════════════════════
//  ABOUT PAGE
// ═══════════════════════════════════════════════════════════════════
document.getElementById('btn-github').addEventListener('click', () => {
  window.api.openExternal('https://github.com/kintil555/AdvencedCleaning');
});
document.getElementById('link-oreui').addEventListener('click', e => {
  e.preventDefault();
  window.api.openExternal('https://github.com/Spectrollay-OreUI/OreUI');
});

// ── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // DOM must be set up — fix layout if not already done
  if (!document.getElementById('body-wrap')) {
    const bodyWrap = document.createElement('div');
    bodyWrap.id = 'body-wrap';
    bodyWrap.style.cssText = 'display:flex;flex:1;overflow:hidden;';
    const app = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    const content = document.getElementById('content');
    app.appendChild(bodyWrap);
    bodyWrap.appendChild(sidebar);
    bodyWrap.appendChild(content);
  }

  loadDashboard();
  loadSizes();
});
