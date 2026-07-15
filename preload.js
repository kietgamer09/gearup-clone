'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('routepilot', {
  // ── Request-response (renderer → main) ──────────────────────────────────
  listGames: () => ipcRenderer.invoke('games:list'),
  getServers: (gameId) => ipcRenderer.invoke('games:servers', gameId),
  testRoutes: (options) => ipcRenderer.invoke('routes:test', options),
  startBoost: (route) => ipcRenderer.invoke('boost:start', route),
  stopBoost: () => ipcRenderer.invoke('boost:stop'),
  boostStatus: () => ipcRenderer.invoke('boost:status'),
  startAIR: (config) => ipcRenderer.invoke('air:start', config),
  stopAIR: () => ipcRenderer.invoke('air:stop'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  // ── Event subscriptions (main → renderer) ───────────────────────────────
  onPingUpdate: (callback) => {
    ipcRenderer.on('ping:update', (_event, data) => callback(data));
  },
  onAIRRouteChanged: (callback) => {
    ipcRenderer.on('air:route-changed', (_event, data) => callback(data));
  },
  onAIRStatus: (callback) => {
    ipcRenderer.on('air:status-update', (_event, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
