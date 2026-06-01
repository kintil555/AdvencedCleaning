const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#48494A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.ico'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow.minimize());
ipcMain.on('win-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow.close());

// ── System info ──────────────────────────────────────────────────────────────
ipcMain.handle('get-system-info', async () => {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  return {
    platform: os.platform(),
    release:  os.release(),
    arch:     os.arch(),
    cpus:     os.cpus().length,
    totalMem: (totalMem / 1073741824).toFixed(2),
    freeMem:  (freeMem  / 1073741824).toFixed(2),
    usedMem:  (usedMem  / 1073741824).toFixed(2),
    memPercent: Math.round((usedMem / totalMem) * 100),
    tmpDir:   os.tmpdir(),
    hostname: os.hostname(),
    uptime:   Math.floor(os.uptime() / 3600),
  };
});

// ── Disk info ────────────────────────────────────────────────────────────────
ipcMain.handle('get-disk-info', async () => {
  return new Promise(resolve => {
    exec('wmic logicaldisk get size,freespace,caption', (err, stdout) => {
      if (err) { resolve([]); return; }
      const lines = stdout.trim().split('\n').slice(1);
      const disks = lines.map(l => {
        const parts = l.trim().split(/\s+/);
        if (parts.length < 3) return null;
        const caption = parts[0];
        const free    = parseInt(parts[1]) || 0;
        const total   = parseInt(parts[2]) || 0;
        if (!total) return null;
        return {
          caption,
          free:    (free  / 1073741824).toFixed(2),
          total:   (total / 1073741824).toFixed(2),
          used:    ((total - free) / 1073741824).toFixed(2),
          percent: Math.round(((total - free) / total) * 100),
        };
      }).filter(Boolean);
      resolve(disks);
    });
  });
});

// ── Generic PowerShell runner (returns stdout+stderr stream via events) ───────
function runPS(script, eventName, win) {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ]);
    let out = '';
    ps.stdout.on('data', d => {
      const line = d.toString();
      out += line;
      win.webContents.send(eventName, { type: 'stdout', data: line.trim() });
    });
    ps.stderr.on('data', d => {
      win.webContents.send(eventName, { type: 'stderr', data: d.toString().trim() });
    });
    ps.on('close', code => {
      win.webContents.send(eventName, { type: 'done', code });
      resolve({ code, out });
    });
  });
}

// ── Estimate size helper ──────────────────────────────────────────────────────
function estimatePS(paths) {
  const joined = paths.map(p => `"${p}"`).join(',');
  return `
$paths = @(${joined})
$total = 0
foreach ($p in $paths) {
  if (Test-Path $p) {
    $total += (Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  }
}
[math]::Round($total / 1MB, 2)
`;
}

// ── Estimate sizes ────────────────────────────────────────────────────────────
ipcMain.handle('estimate-sizes', async () => {
  const tmp   = os.tmpdir();
  const win   = process.env.SystemRoot || 'C:\\Windows';
  const user  = os.homedir();
  const prefetch = `${win}\\Prefetch`;
  const winevt   = `${win}\\Logs`;
  const recycle  = 'C:\\$Recycle.Bin';

  const scripts = {
    tempFiles:      estimatePS([tmp, `${win}\\Temp`]),
    browserCache:   estimatePS([
      `${user}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache`,
      `${user}\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache`,
      `${user}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles`,
    ]),
    recyclebin:     estimatePS([recycle]),
    prefetch:       estimatePS([prefetch]),
    windowsLogs:    estimatePS([winevt, `${win}\\Logs`]),
    thumbnailCache: estimatePS([`${user}\\AppData\\Local\\Microsoft\\Windows\\Explorer`]),
    windowsUpdate:  estimatePS([`${win}\\SoftwareDistribution\\Download`]),
    memoryDumps:    estimatePS([`${win}\\Minidump`, `${win}\\memory.dmp`]),
  };

  const results = {};
  for (const [key, script] of Object.entries(scripts)) {
    try {
      const r = await new Promise((res) => {
        const tmpF = path.join(os.tmpdir(), `ac_sz_${key}.ps1`);
        try { fs.writeFileSync(tmpF, script, 'utf8'); } catch { res('0'); return; }
        exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpF}"`,
          { timeout: 15000 }, (err, stdout) => {
            try { fs.unlinkSync(tmpF); } catch {}
            if (err) res('0');
            else res(stdout.trim() || '0');
          });
      });
      results[key] = parseFloat(r) || 0;
    } catch { results[key] = 0; }
  }
  return results;
});

// ── Clean operations ──────────────────────────────────────────────────────────
ipcMain.handle('run-clean', async (event, tasks) => {
  const win  = mainWindow;
  const tmp  = os.tmpdir();
  const winR = process.env.SystemRoot || 'C:\\Windows';
  const user = os.homedir();

  const scripts = {
    tempFiles: `
Write-Output "Cleaning Temp Files..."
$paths = @("${tmp}", "${winR}\\Temp")
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "  Cleaned: $p"
  }
}
Write-Output "Temp Files: Done"`,

    browserCache: `
Write-Output "Cleaning Browser Cache..."
$paths = @(
  "${user}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache",
  "${user}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache",
  "${user}\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache",
  "${user}\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Code Cache",
  "${user}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "  Cleaned: $p"
  }
}
Write-Output "Browser Cache: Done"`,

    recyclebin: `
Write-Output "Emptying Recycle Bin..."
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
Write-Output "Recycle Bin: Done"`,

    prefetch: `
Write-Output "Cleaning Prefetch..."
$p = "${winR}\\Prefetch"
if (Test-Path $p) {
  Get-ChildItem -Path $p -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Output "  Cleaned: $p"
}
Write-Output "Prefetch: Done"`,

    windowsLogs: `
Write-Output "Cleaning Windows Logs..."
$paths = @("${winR}\\Logs", "${winR}\\Panther")
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "  Cleaned: $p"
  }
}
wevtutil el | ForEach-Object { wevtutil cl $_ 2>$null }
Write-Output "Windows Logs: Done"`,

    thumbnailCache: `
Write-Output "Cleaning Thumbnail Cache..."
$p = "${user}\\AppData\\Local\\Microsoft\\Windows\\Explorer"
if (Test-Path $p) {
  Get-ChildItem -Path $p -Filter "thumbcache_*.db" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Output "  Cleaned thumbnail databases"
}
Write-Output "Thumbnail Cache: Done"`,

    windowsUpdate: `
Write-Output "Cleaning Windows Update Cache..."
Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
$p = "${winR}\\SoftwareDistribution\\Download"
if (Test-Path $p) {
  Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "  Cleaned: $p"
}
Start-Service -Name wuauserv -ErrorAction SilentlyContinue
Write-Output "Windows Update Cache: Done"`,

    memoryDumps: `
Write-Output "Cleaning Memory Dumps..."
$paths = @("${winR}\\Minidump", "${winR}\\memory.dmp")
foreach ($p in $paths) {
  if (Test-Path $p) {
    Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "  Cleaned: $p"
  }
}
Write-Output "Memory Dumps: Done"`,

    dns: `
Write-Output "Flushing DNS Cache..."
ipconfig /flushdns | Out-Null
Write-Output "DNS Cache: Done"`,

    ramOptimize: `
Write-Output "Optimizing RAM..."
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()
$sig = @"
[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess);
"@
$t = Add-Type -MemberDefinition $sig -Name "Mem" -Namespace "Win32" -PassThru
Get-Process | ForEach-Object { try { $t::EmptyWorkingSet($_.Handle) } catch {} }
Write-Output "RAM Optimize: Done"`,
  };

  const selected = tasks.filter(t => scripts[t]);
  for (const task of selected) {
    await runPS(scripts[task], 'clean-log', win);
  }
  return { done: true };
});

// ── Startup manager ───────────────────────────────────────────────────────────
ipcMain.handle('get-startup-items', async () => {
  return new Promise(resolve => {
    // Write script to temp file to avoid quote-escaping issues
    const tmpScript = path.join(os.tmpdir(), 'ac_startup_query.ps1');
    const script = [
      '$items = @()',
      '$regPaths = @(',
      '  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",',
      '  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",',
      '  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run"',
      ')',
      'foreach ($rp in $regPaths) {',
      '  if (Test-Path $rp) {',
      '    $props = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue',
      '    $props.PSObject.Properties | Where-Object { $_.Name -notmatch "^PS" } | ForEach-Object {',
      '      $items += [PSCustomObject]@{ Name=$_.Name; Path=$_.Value; Location=$rp; Enabled=$true }',
      '    }',
      '  }',
      '}',
      'if ($items.Count -gt 0) { $items | ConvertTo-Json -Depth 3 -Compress }',
      'else { Write-Output "[]" }',
    ].join('\n');

    try { fs.writeFileSync(tmpScript, script, 'utf8'); } catch(e) { resolve([]); return; }

    exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`,
      { timeout: 15000 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpScript); } catch {}
        if (err) { resolve([]); return; }
        const out = stdout.trim();
        if (!out || out === '[]') { resolve([]); return; }
        try {
          const data = JSON.parse(out);
          resolve(Array.isArray(data) ? data : [data]);
        } catch { resolve([]); }
      });
  });
});

ipcMain.handle('toggle-startup-item', async (event, { name, location, enable }) => {
  return new Promise(resolve => {
    const action = enable
      ? `# Enable not implemented via reg (item would need original value stored)`
      : `Remove-ItemProperty -Path "${location}" -Name "${name}" -ErrorAction SilentlyContinue`;
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${action.replace(/"/g, '\\"')}"`,
      (err) => resolve(!err));
  });
});

// ── Disk Cleanup (built-in cleanmgr) ─────────────────────────────────────────
ipcMain.handle('run-disk-cleanup', async () => {
  return new Promise(resolve => {
    exec('cleanmgr /sagerun:1', (err) => resolve(!err));
  });
});

// ── DISM / SFC ────────────────────────────────────────────────────────────────
ipcMain.handle('run-sfc', async () => {
  const win = mainWindow;
  await runPS('sfc /scannow', 'tool-log', win);
  return { done: true };
});

ipcMain.handle('run-dism', async () => {
  const win = mainWindow;
  await runPS('DISM /Online /Cleanup-Image /RestoreHealth', 'tool-log', win);
  return { done: true };
});

// ── Network tools ─────────────────────────────────────────────────────────────
ipcMain.handle('run-network-reset', async () => {
  const win = mainWindow;
  const script = `
ipconfig /flushdns
netsh winsock reset
netsh int ip reset
Write-Output "Network reset done. Restart may be required."
`;
  await runPS(script, 'tool-log', win);
  return { done: true };
});

// ── Open external ─────────────────────────────────────────────────────────────
ipcMain.on('open-external', (e, url) => shell.openExternal(url));
ipcMain.on('open-path', (e, p) => shell.openPath(p));
