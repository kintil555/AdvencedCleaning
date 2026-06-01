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

// ── System info (accurate via PowerShell WMI) ────────────────────────────────
ipcMain.handle('get-system-info', async () => {
  // Fallback from Node.js first (always works)
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const base = {
    platform:   os.platform(),
    release:    os.release(),
    arch:       os.arch(),
    cpus:       os.cpus().length,
    cpuName:    os.cpus()[0]?.model || 'Unknown',
    totalMem:   (totalMem / 1073741824).toFixed(2),
    freeMem:    (freeMem  / 1073741824).toFixed(2),
    usedMem:    (usedMem  / 1073741824).toFixed(2),
    memPercent: Math.round((usedMem / totalMem) * 100),
    tmpDir:     os.tmpdir(),
    hostname:   os.hostname(),
    uptime:     Math.floor(os.uptime() / 3600),
    osName:     'Windows',
    osBuild:    '',
    gpuName:    'Detecting...',
    cpuTemp:    'N/A',
    vram:       '',
  };

  // Enrich with WMI data
  const psScript = `
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
$temp = 'N/A'
try {
  $tz = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -EA Stop | Select-Object -First 1
  $temp = [math]::Round($tz.CurrentTemperature/10 - 273.15, 0).ToString()
} catch {}
[PSCustomObject]@{
  OSName    = $os.Caption
  OSBuild   = $os.BuildNumber
  OSVersion = $os.Version
  CPUName   = $cpu.Name.Trim()
  CPUCores  = $cpu.NumberOfCores
  CPULogical= $cpu.NumberOfLogicalProcessors
  GPUName   = $gpu.Name
  VRAM      = [math]::Round($gpu.AdapterRAM/1MB, 0)
  CPUTemp   = $temp
} | ConvertTo-Json -Compress`;

  try {
    const result = await new Promise((resolve) => {
      exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
        { timeout: 10000 }, (err, stdout) => resolve({ err, stdout }));
    });
    if (!result.err && result.stdout.trim()) {
      const d = JSON.parse(result.stdout.trim());
      base.osName   = d.OSName  || base.osName;
      base.osBuild  = d.OSBuild || '';
      base.cpuName  = d.CPUName || base.cpuName;
      base.cpus     = d.CPULogical || base.cpus;
      base.cpuCores = d.CPUCores;
      base.gpuName  = d.GPUName || 'Not detected';
      base.vram     = d.VRAM > 0 ? `${d.VRAM} MB` : '';
      base.cpuTemp  = d.CPUTemp || 'N/A';
    }
  } catch {}

  return base;
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

// ── Generic PS runner for new features (streams live to renderer) ────────────
function runPSNew(script, win) {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ]);
    let out = '';
    ps.stdout.on('data', d => {
      const line = d.toString();
      out += line;
      win.webContents.send('feature-log', { type: 'stdout', data: line.trim() });
    });
    ps.stderr.on('data', d => {
      win.webContents.send('feature-log', { type: 'stderr', data: d.toString().trim() });
    });
    ps.on('close', code => {
      win.webContents.send('feature-log', { type: 'done', code });
      resolve({ code, out });
    });
    ps.on('error', () => resolve({ code: -1, out: '' }));
  });
}

// ── Exclude helpers ────────────────────────────────────────────────────────────
const EXCL_FILE = path.join(os.homedir(), 'AppData', 'Local', 'AdvancedCleanup_excludes.txt');

ipcMain.handle('get-excludes', async () => {
  try {
    if (!fs.existsSync(EXCL_FILE)) return [];
    return fs.readFileSync(EXCL_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('save-excludes', async (event, list) => {
  try {
    fs.writeFileSync(EXCL_FILE, list.join('\n'), 'utf8');
    return true;
  } catch { return false; }
});

// ── Performance Boost ─────────────────────────────────────────────────────────
const boostScripts = {
  visualfx: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKCU\\Control Panel\\Desktop" /v UserPreferencesMask /t REG_BINARY /d 9012038010000000 /f 2>$null|Out-Null
reg add "HKCU\\Control Panel\\Desktop" /v FontSmoothing /t REG_SZ /d 2 /f 2>$null|Out-Null
reg add "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v MinAnimate /t REG_SZ /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v TaskbarAnimations /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\DWM" /v EnableAeroPeek /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[OK] Visual Effects -> Best Performance applied."`,

  powerplan: `
powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null
Write-Output "[OK] Power plan -> High Performance."`,

  memory: `
$ram=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)
$ri=[int][math]::Floor($ram)
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "LargeSystemCache" /t REG_DWORD /d 1 /f 2>$null|Out-Null
if($ri -ge 12){
  reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "DisablePagingExecutive" /t REG_DWORD /d 1 /f 2>$null|Out-Null
  Write-Output "[OK] Memory management optimized (RAM: $($ram) GB)."
} else {
  Write-Output "[WARN] LargeSystemCache ON. DisablePagingExecutive skipped (RAM $($ram)GB < 12GB — BSOD risk)."
}`,

  netthrottle: `
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f 2>$null|Out-Null
Write-Output "[OK] Network throttling disabled."`,

  gamemode: `
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AllowAutoGameMode" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "High" /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[OK] Game Mode + CPU/GPU priority maxed."`,

  nagle: `
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object {
  Set-ItemProperty -Path $_.PSPath -Name TcpAckFrequency -Value 1 -Type DWord -EA SilentlyContinue
  Set-ItemProperty -Path $_.PSPath -Name TCPNoDelay -Value 1 -Type DWord -EA SilentlyContinue
}
Write-Output "[OK] Nagle algorithm disabled."`,

  all: `
Write-Output "[1/6] Visual FX..."
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v MinAnimate /t REG_SZ /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v TaskbarAnimations /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[2/6] Power plan..."
powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null
Write-Output "[3/6] Memory management..."
$ri=[int][math]::Floor([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1))
if($ri -ge 12){ reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "DisablePagingExecutive" /t REG_DWORD /d 1 /f 2>$null|Out-Null }
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "LargeSystemCache" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[4/6] Network throttling..."
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f 2>$null|Out-Null
Write-Output "[5/6] Game Mode + CPU/GPU priority..."
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[6/6] Nagle..."
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name TcpAckFrequency -Value 1 -Type DWord -EA SilentlyContinue; Set-ItemProperty -Path $_.PSPath -Name TCPNoDelay -Value 1 -Type DWord -EA SilentlyContinue }
Write-Output "[OK] ALL boost tweaks applied! Restart for full effect."`,

  undo: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v MinAnimate /t REG_SZ /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v TaskbarAnimations /t REG_DWORD /d 1 /f 2>$null|Out-Null
powercfg -setactive 381b4222-f694-41f0-9685-ff5bb260df2e 2>$null
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "LargeSystemCache" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v "DisablePagingExecutive" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xa0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 20 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "Medium" /f 2>$null|Out-Null
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object { try{Remove-ItemProperty $_.PSPath TcpAckFrequency -EA SilentlyContinue}catch{}; try{Remove-ItemProperty $_.PSPath TCPNoDelay -EA SilentlyContinue}catch{} }
Write-Output "[OK] All boost tweaks restored to Windows defaults."`,
};

ipcMain.handle('run-boost', async (event, type) => {
  const script = boostScripts[type];
  if (!script) return;
  await runPSNew(script, mainWindow);
});

// ── Gaming Mode ────────────────────────────────────────────────────────────────
const gamingScripts = {
  killbg: `
foreach($p in @('OneDrive','Teams','ms-teams','Cortana','SearchApp','SearchIndexer','WidgetService','YourPhone','PhoneExperienceHost','MicrosoftEdgeUpdate','msedgewebview2','GameBarPresenceWriter','MoUsoCoreWorker','chrome','msedge','brave','opera','firefox','Discord','Spotify','EpicGamesLauncher','EpicWebHelper','Origin','RiotClientUx','AdobeUpdateService','CCXProcess','NahimicService','SteelSeriesGG','RazerCentral','lghub','iCUE','ArmouryCrate','WallpaperEngine')){Stop-Process -Name $p -Force -EA SilentlyContinue}
[System.GC]::Collect();[System.GC]::WaitForPendingFinalizers();[System.GC]::Collect()
Write-Output "[OK] Background processes cleared + RAM flushed."`,

  powerplan: `
$guid=$null
(powercfg /list 2>$null) | Select-String 'Ultimate' | ForEach-Object { if($_ -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'){$guid=$Matches[1]} }
if(-not $guid){ $out=powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 2>&1; if($out -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'){$guid=$Matches[1]} }
if($guid){ powercfg -setactive $guid 2>$null } else { powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null }
Write-Output "[OK] Ultimate Performance plan active."`,

  priority: `
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "High" /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "SFIO Priority" /t REG_SZ /d "High" /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[OK] CPU + GPU priority maxed."`,

  gamemode: `
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AllowAutoGameMode" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[OK] Windows Game Mode activated."`,

  hags: `
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /t REG_DWORD /d 2 /f 2>$null|Out-Null
Write-Output "[OK] HAGS enabled. Restart PC for full effect."`,

  netthrottle: `
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f 2>$null|Out-Null
Write-Output "[OK] Network throttling disabled."`,

  nagle: `
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name TcpAckFrequency -Value 1 -Type DWord -EA SilentlyContinue; Set-ItemProperty -Path $_.PSPath -Name TCPNoDelay -Value 1 -Type DWord -EA SilentlyContinue }
Write-Output "[OK] Nagle algorithm disabled."`,

  services: `
foreach($s in @('SysMain','WSearch','DiagTrack','MapsBroker','RetailDemo','wisvc','PcaSvc','SensorDataService','lfsvc')){ Stop-Service -Name $s -Force -EA SilentlyContinue }
Write-Output "[OK] Heavy services stopped (will re-enable on restart)."`,

  uwpbg: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search" /v "BackgroundAppGlobalToggle" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[OK] UWP background apps disabled."`,

  ramflush: `
[System.GC]::Collect();[System.GC]::WaitForPendingFinalizers();[System.GC]::Collect()
$free=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0)
Write-Output "[OK] RAM flushed. Free: $($free) MB"`,

  timer: `
bcdedit /set useplatformtick yes 2>$null|Out-Null
bcdedit /deletevalue useplatformclock 2>$null|Out-Null
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel" /v "GlobalTimerResolutionRequests" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[OK] Timer resolution hint applied. Restart for full effect."`,

  all: `
Write-Output "[1/11] Kill BG processes..."
foreach($p in @('OneDrive','Teams','Cortana','SearchApp','SearchIndexer','WidgetService','YourPhone','MicrosoftEdgeUpdate','msedgewebview2','GameBarPresenceWriter','chrome','msedge','brave','opera','firefox','Discord','Spotify','EpicGamesLauncher','Origin','RiotClientUx','AdobeUpdateService','CCXProcess','NahimicService','SteelSeriesGG','RazerCentral','lghub','iCUE','ArmouryCrate','WallpaperEngine')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
Write-Output "[2/11] Power plan..."
powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null
Write-Output "[3/11] CPU/GPU priority..."
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[4/11] Game Mode..."
reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[5/11] HAGS..."
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /t REG_DWORD /d 2 /f 2>$null|Out-Null
Write-Output "[6/11] Network throttling..."
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f 2>$null|Out-Null
Write-Output "[7/11] Nagle..."
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name TcpAckFrequency -Value 1 -Type DWord -EA SilentlyContinue; Set-ItemProperty -Path $_.PSPath -Name TCPNoDelay -Value 1 -Type DWord -EA SilentlyContinue }
Write-Output "[8/11] UWP background..."
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[9/11] Stop heavy services..."
foreach($s in @('SysMain','WSearch','DiagTrack','MapsBroker','RetailDemo','wisvc','PcaSvc','SensorDataService','lfsvc')){ Stop-Service -Name $s -Force -EA SilentlyContinue }
Write-Output "[10/11] RAM flush..."
[System.GC]::Collect();[System.GC]::WaitForPendingFinalizers();[System.GC]::Collect()
$free=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0)
Write-Output "  RAM free: $($free) MB"
Write-Output "[11/11] Timer resolution..."
bcdedit /set useplatformtick yes 2>$null|Out-Null
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel" /v "GlobalTimerResolutionRequests" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[OK] ALL GAMING TWEAKS APPLIED! Use UNDO to revert."`,

  undo: `
powercfg -setactive 381b4222-f694-41f0-9685-ff5bb260df2e 2>$null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 2 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "Medium" /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "SFIO Priority" /t REG_SZ /d "Normal" /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "SystemResponsiveness" /t REG_DWORD /d 20 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xa0 /f 2>$null|Out-Null
Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces" -EA SilentlyContinue | ForEach-Object { try{Remove-ItemProperty $_.PSPath TcpAckFrequency -EA SilentlyContinue}catch{}; try{Remove-ItemProperty $_.PSPath TCPNoDelay -EA SilentlyContinue}catch{} }
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search" /v "BackgroundAppGlobalToggle" /t REG_DWORD /d 1 /f 2>$null|Out-Null
bcdedit /deletevalue useplatformtick 2>$null|Out-Null
try{Remove-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel' -Name 'GlobalTimerResolutionRequests' -EA SilentlyContinue}catch{}
Start-Service SysMain,WSearch -EA SilentlyContinue
Write-Output "[OK] Gaming Mode tweaks restored to default."`,
};

ipcMain.handle('run-gaming', async (event, type) => {
  const script = gamingScripts[type];
  if (!script) return;
  await runPSNew(script, mainWindow);
});

// ── Background Apps & Services ────────────────────────────────────────────────
const bgScripts = {
  kill: `
foreach($p in @('esrv','esrv_svc','PCManager','MSPCManager','SnippingTool','PhoneExperienceHost','YourPhone','WidgetService','winwidgets','SearchIndexer','MicrosoftEdgeUpdate','msedgewebview2','NvTelemetryContainer','nvNodeLauncher','nvbackend','AdobeUpdateService','CCXProcess','AdobeIPCBroker','mDNSResponder','ArmouryNotification','AsusUpdateCheck','ROGLiveService')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
Write-Output "[OK] Bloat processes killed."`,

  uwp: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search" /v "BackgroundAppGlobalToggle" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy" /v "LetAppsRunInBackground" /t REG_DWORD /d 2 /f 2>$null|Out-Null
Write-Output "[OK] UWP Background Apps disabled."`,

  snip: `
Stop-Process -Name SnippingTool -Force -EA SilentlyContinue
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.ScreenSketch_8wekyb3d8bbwe" /v "Disabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.ScreenSketch_8wekyb3d8bbwe" /v "DisabledByUser" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[OK] Snipping Tool background disabled."`,

  phonelink: `
foreach($p in @('PhoneExperienceHost','YourPhone')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.YourPhone_8wekyb3d8bbwe" /v "Disabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.YourPhone_8wekyb3d8bbwe" /v "DisabledByUser" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[OK] Phone Link background disabled."`,

  widgets: `
foreach($p in @('WidgetService','winwidgets')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Dsh" /v "AllowNewsAndInterests" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v "TaskbarDa" /t REG_DWORD /d 0 /f 2>$null|Out-Null
sc.exe config Widgets start= disabled 2>$null; sc.exe stop Widgets 2>$null
sc.exe config WidgetService start= disabled 2>$null; sc.exe stop WidgetService 2>$null
Write-Output "[OK] Widgets disabled."`,

  search: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\SearchSettings" /v "IsDynamicSearchBoxEnabled" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v "EnableDynamicContentInWSB" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v "AllowSearchHighlights" /t REG_DWORD /d 0 /f 2>$null|Out-Null
sc.exe config WSearch start= disabled 2>$null; sc.exe stop WSearch 2>$null
Write-Output "[OK] Search Highlights + WSearch disabled."`,

  esrv: `
foreach($p in @('esrv','esrv_svc')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
foreach($s in @('SUR5WRYService','esrv_svc','esrv_svc_queencreek','esrv_svc_willamette','Intel(R) System Usage Report Service','Energy Server Service WILLAMETTE','Energy Server Service queencreek')){ sc.exe config $s start= disabled 2>$null; sc.exe stop $s 2>$null }
schtasks /change /tn "\\Intel\\Intel System Usage Report\\SUR_SVC" /disable 2>$null|Out-Null
Write-Output "[OK] Intel esrv/SUR disabled."`,

  pcmanager: `
foreach($p in @('PCManager','MSPCManager')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
foreach($s in @('PCManagerService','MSPCManagerService')){ sc.exe config $s start= demand 2>$null; sc.exe stop $s 2>$null }
try{Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'PCManager' -EA SilentlyContinue}catch{}
Write-Output "[OK] PC Manager background disabled."`,

  edgeupdate: `
foreach($p in @('MicrosoftEdgeUpdate','msedgewebview2')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
foreach($s in @('edgeupdate','edgeupdatem')){ sc.exe config $s start= disabled 2>$null; sc.exe stop $s 2>$null }
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v "UpdateDefault" /t REG_DWORD /d 0 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v "StartupBoostEnabled" /t REG_DWORD /d 0 /f 2>$null|Out-Null
schtasks /change /tn "\\MicrosoftEdgeUpdateTaskMachineCore" /disable 2>$null|Out-Null
schtasks /change /tn "\\MicrosoftEdgeUpdateTaskMachineUA" /disable 2>$null|Out-Null
Write-Output "[OK] Edge Update disabled."`,

  nvidiatelem: `
foreach($p in @('NvTelemetryContainer','nvNodeLauncher','nvbackend')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
sc.exe config NvTelemetryContainer start= disabled 2>$null; sc.exe stop NvTelemetryContainer 2>$null
reg add "HKLM\\SOFTWARE\\NVIDIA Corporation\\NvControlPanel2\\Client" /v "OptInOrOutPreference" /t REG_DWORD /d 0 /f 2>$null|Out-Null
schtasks /change /tn "\\NvTmRepOnLogon_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}" /disable 2>$null|Out-Null
schtasks /change /tn "\\NvTmMon_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}" /disable 2>$null|Out-Null
Write-Output "[OK] NVIDIA Telemetry disabled."`,

  adobe: `
foreach($p in @('AdobeUpdateService','CCXProcess','AdobeIPCBroker','mDNSResponder')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
sc.exe config AdobeARMservice start= demand 2>$null; sc.exe stop AdobeARMservice 2>$null
sc.exe config "Bonjour Service" start= disabled 2>$null; sc.exe stop "Bonjour Service" 2>$null
try{Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CCXProcess' -EA SilentlyContinue}catch{}
Write-Output "[OK] Adobe + Bonjour disabled."`,

  winservices: `
Write-Output "Disabling Windows built-in services..."
sc.exe config DiagTrack start= disabled 2>$null; sc.exe stop DiagTrack 2>$null
sc.exe config WerSvc start= demand 2>$null; sc.exe stop WerSvc 2>$null
sc.exe config DoSvc start= demand 2>$null; sc.exe stop DoSvc 2>$null
sc.exe config SysMain start= disabled 2>$null; sc.exe stop SysMain 2>$null
foreach($s in @('XblAuthManager','XblGameSave','XboxNetApiSvc','XboxGipSvc')){ sc.exe config $s start= disabled 2>$null; sc.exe stop $s 2>$null }
sc.exe config RemoteRegistry start= disabled 2>$null; sc.exe stop RemoteRegistry 2>$null
sc.exe config RemoteAccess start= disabled 2>$null; sc.exe stop RemoteAccess 2>$null
sc.exe config Fax start= disabled 2>$null; sc.exe stop Fax 2>$null
sc.exe config RetailDemo start= disabled 2>$null; sc.exe stop RetailDemo 2>$null
sc.exe config dmwappushservice start= disabled 2>$null; sc.exe stop dmwappushservice 2>$null
sc.exe config WMPNetworkSvc start= disabled 2>$null; sc.exe stop WMPNetworkSvc 2>$null
Write-Output "[OK] Windows services disabled. NOTE: Re-enable SysMain if using HDD."`,

  all: `
Write-Output "[1/11] Kill bloat..."
foreach($p in @('esrv','esrv_svc','PCManager','MSPCManager','SnippingTool','PhoneExperienceHost','YourPhone','WidgetService','winwidgets','SearchIndexer','MicrosoftEdgeUpdate','msedgewebview2','NvTelemetryContainer','nvNodeLauncher','nvbackend','AdobeUpdateService','CCXProcess','AdobeIPCBroker','mDNSResponder')){ Stop-Process -Name $p -Force -EA SilentlyContinue }
Write-Output "[2/11] UWP background..."
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy" /v "LetAppsRunInBackground" /t REG_DWORD /d 2 /f 2>$null|Out-Null
Write-Output "[3/11] Snipping Tool..."
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.ScreenSketch_8wekyb3d8bbwe" /v "Disabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[4/11] Phone Link..."
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.YourPhone_8wekyb3d8bbwe" /v "Disabled" /t REG_DWORD /d 1 /f 2>$null|Out-Null
Write-Output "[5/11] Widgets..."
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Dsh" /v "AllowNewsAndInterests" /t REG_DWORD /d 0 /f 2>$null|Out-Null
sc.exe config Widgets start= disabled 2>$null; sc.exe stop Widgets 2>$null
Write-Output "[6/11] Search Highlights..."
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v "AllowSearchHighlights" /t REG_DWORD /d 0 /f 2>$null|Out-Null
sc.exe config WSearch start= disabled 2>$null; sc.exe stop WSearch 2>$null
Write-Output "[7/11] Intel esrv..."
foreach($s in @('SUR5WRYService','esrv_svc','esrv_svc_queencreek','esrv_svc_willamette')){ sc.exe config $s start= disabled 2>$null; sc.exe stop $s 2>$null }
Write-Output "[8/11] PC Manager..."
foreach($s in @('PCManagerService','MSPCManagerService')){ sc.exe config $s start= demand 2>$null; sc.exe stop $s 2>$null }
Write-Output "[9/11] Edge Update..."
foreach($s in @('edgeupdate','edgeupdatem')){ sc.exe config $s start= disabled 2>$null; sc.exe stop $s 2>$null }
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v "StartupBoostEnabled" /t REG_DWORD /d 0 /f 2>$null|Out-Null
Write-Output "[10/11] NVIDIA Telemetry..."
sc.exe config NvTelemetryContainer start= disabled 2>$null; sc.exe stop NvTelemetryContainer 2>$null
Write-Output "[11/11] Adobe + Bonjour..."
sc.exe config AdobeARMservice start= demand 2>$null; sc.exe stop AdobeARMservice 2>$null
sc.exe config "Bonjour Service" start= disabled 2>$null; sc.exe stop "Bonjour Service" 2>$null
Write-Output "[OK] ALL background bloat disabled! Restart PC for full effect."`,

  undo: `
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 0 /f 2>$null|Out-Null
try{Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search' -Name 'BackgroundAppGlobalToggle' -EA SilentlyContinue}catch{}
try{Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy' -Name 'LetAppsRunInBackground' -EA SilentlyContinue}catch{}
try{Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.ScreenSketch_8wekyb3d8bbwe' -Name 'Disabled' -EA SilentlyContinue}catch{}
try{Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications\\Microsoft.YourPhone_8wekyb3d8bbwe' -Name 'Disabled' -EA SilentlyContinue}catch{}
try{Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh' -Name 'AllowNewsAndInterests' -EA SilentlyContinue}catch{}
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v "TaskbarDa" /t REG_DWORD /d 1 /f 2>$null|Out-Null
sc.exe config Widgets start= auto 2>$null; sc.exe config WidgetService start= auto 2>$null
try{Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Name 'AllowSearchHighlights' -EA SilentlyContinue}catch{}
sc.exe config WSearch start= auto 2>$null; Start-Service WSearch -EA SilentlyContinue
foreach($s in @('edgeupdate','edgeupdatem')){ sc.exe config $s start= auto 2>$null }
schtasks /change /tn "\\MicrosoftEdgeUpdateTaskMachineCore" /enable 2>$null|Out-Null
schtasks /change /tn "\\MicrosoftEdgeUpdateTaskMachineUA" /enable 2>$null|Out-Null
sc.exe config NvTelemetryContainer start= auto 2>$null
sc.exe config AdobeARMservice start= auto 2>$null
sc.exe config "Bonjour Service" start= auto 2>$null
Start-Service SysMain -EA SilentlyContinue
Write-Output "[OK] All background apps restored to default."`,
};

ipcMain.handle('run-bgapp', async (event, type) => {
  const script = bgScripts[type];
  if (!script) return;
  await runPSNew(script, mainWindow);
});
