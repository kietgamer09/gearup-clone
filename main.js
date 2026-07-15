'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { GAMES, RELAY_NODES, REGIONS, getGameServers } = require('./src/relayConfig');
const routeOptimizer = require('./src/routeOptimizer');
const { findBestRelayPath } = routeOptimizer;
const { AIREngine } = require('./src/airEngine');
const tunnelManager = require('./src/tunnelManager');

// ── Module-level state ──────────────────────────────────────────────────────
let mainWindow = null;
let airEngine = null;

// ── Settings persistence ────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  preferredGame: 'valorant',
  preferredServer: null,
  autoBoost: false,
  airSensitivity: 15,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Settings] Failed to save:', err.message);
  }
}

// ── Window creation ─────────────────────────────────────────────────────────
function createWindow() {
  const windowOptions = {
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#060b14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // Platform-specific frameless setup
  if (process.platform === 'darwin') {
    windowOptions.frame = false;
    windowOptions.titleBarStyle = 'hidden';
  } else {
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

// Games
ipcMain.handle('games:list', () => {
  return GAMES;
});

ipcMain.handle('games:servers', (_event, gameId) => {
  return getGameServers(gameId);
});

function resolveTargetServer(options = {}) {
  const { gameId, serverId } = options;
  if (gameId && serverId) {
    const match = getGameServers(gameId).find((s) => s.id === serverId);
    if (match) return match;
  }
  return { id: 'val-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '43.229.67.1', port: 443 };
}

function flattenRelayResults(results = []) {
  return results.map((entry) => {
    const relay = entry.relay || entry;
    const measurement = entry.measurement || {};
    const avgLatency = measurement.estimatedTotalMs ?? measurement.avg ?? null;

    return {
      id: relay.id,
      name: relay.label || relay.id,
      relay: relay.label || relay.id,
      region: relay.region || '',
      flag: relay.flag || '',
      host: relay.host,
      port: relay.port,
      configPath: relay.configPath || null,
      avgLatency,
      latency: avgLatency,
      jitter: measurement.jitter || 0,
      loss: measurement.loss ? measurement.loss / 100 : 0,
      score: entry.score,
      reachable: !!measurement.success,
      simulated: !!measurement.simulated,
      measurement: {
        ...measurement,
        estimatedTotalMs: avgLatency,
      },
      relay_obj: {
        id: relay.id,
        label: relay.label,
        host: relay.host,
        port: relay.port,
        configPath: relay.configPath,
        flag: relay.flag,
        region: relay.region,
      },
    };
  });
}

// Route testing
ipcMain.handle('routes:test', async (_event, options) => {
  try {
    const targetServer = resolveTargetServer(options);
    const ranked = await findBestRelayPath(RELAY_NODES, targetServer, {
      trials: 5,
      timeout: 2000,
      delay: 150,
    });
    return flattenRelayResults(ranked.results || []);
  } catch (err) {
    console.error('[Routes] Test failed:', err.message);
    return [];
  }
});

// Boost (tunnel)
ipcMain.handle('boost:start', async (_event, route) => {
  try {
    // Normalize route shape for tunnelManager — it expects { relay: {...}, measurement: {...} }
    const tunnelRoute = {
      relay: route.relay_obj || { id: route.id, label: route.name || route.relay, host: route.host, port: route.port, configPath: route.configPath },
      measurement: route.measurement || { estimatedTotalMs: route.avgLatency || route.latency },
    };
    const result = await tunnelManager.connect(tunnelRoute);
    return result;
  } catch (err) {
    console.error('[Boost] Start failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('boost:stop', async () => {
  try {
    const result = await tunnelManager.disconnect();
    return { success: true, disconnected: result };
  } catch (err) {
    console.error('[Boost] Stop failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('boost:status', () => {
  return tunnelManager.getStatus();
});

// AIR Engine
ipcMain.handle('air:start', (_event, config) => {
  try {
    // Stop any existing engine
    if (airEngine) {
      airEngine.stop();
      airEngine = null;
    }

    airEngine = new AIREngine(routeOptimizer);

    // Forward events to the renderer
    airEngine.on('ping-update', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ping:update', data);
      }
    });

    airEngine.on('route-changed', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('air:route-changed', data);
      }
    });

    airEngine.on('status-update', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('air:status-update', data);
      }
    });

    // Build AIR config from renderer data — resolve relay objects and target server
    const targetServer = config.targetServer;
    const resolvedTarget = typeof targetServer === 'string'
      ? (getGameServers(config.gameId || '').find(s => s.id === targetServer) || { host: '43.229.67.1', port: 443, label: targetServer })
      : targetServer;

    airEngine.start({
      targetServer: resolvedTarget,
      relays: RELAY_NODES,
      intervalMs: config.intervalMs || 10000,
      maxHotStandby: 3,
    });
    return { success: true };
  } catch (err) {
    console.error('[AIR] Start failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('air:stop', () => {
  try {
    if (airEngine) {
      airEngine.stop();
      airEngine = null;
    }
    return { success: true };
  } catch (err) {
    console.error('[AIR] Stop failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Settings
ipcMain.handle('settings:get', () => {
  return loadSettings();
});

ipcMain.handle('settings:set', (_event, key, value) => {
  try {
    const settings = loadSettings();
    settings[key] = value;
    saveSettings(settings);
    return { success: true, settings };
  } catch (err) {
    console.error('[Settings] Set failed:', err.message);
    return { success: false, error: err.message };
  }
});

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Clean up AIR engine before quitting
  if (airEngine) {
    airEngine.stop();
    airEngine = null;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
