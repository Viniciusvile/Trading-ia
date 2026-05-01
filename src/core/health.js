/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate } from '../connection.js';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';

export async function healthCheck() {
  await getClient({ fast: true });
  const target = await getTargetInfo();

  const state = await evaluate(`
    (function() {
      ...
    })()
  `, { fast: true });

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
  };
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      ...
    })()
  `, { fast: true });

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      ...
    })()
  `, { fast: true });

  return { success: true, ...state };
}

export async function launch({ port, kill_existing } = {}) {
  const cdpPort = port || 9222;
  const killFirst = kill_existing !== false;
  const platform = process.platform;

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  if (killFirst) {
    try {
      if (platform === 'win32') execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      else execSync('pkill -f TradingView', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* may not be running */ }
  }

  const child = spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const http = await import('http');
      const ready = await new Promise((resolve) => {
        http.get(`http://localhost:${cdpPort}/json/version`, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(null));
      });
      if (ready) {
        const info = JSON.parse(ready);
        return {
          success: true, platform, binary: tvPath, pid: child.pid,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          browser: info.Browser, user_agent: info['User-Agent'],
        };
      }
    } catch { /* retry */ }
  }

  return {
    success: true, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
