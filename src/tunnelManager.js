'use strict';

// =============================================================================
// tunnelManager.js — WireGuard tunnel lifecycle management
// Handles connect/disconnect, health monitoring, and WireGuard availability.
// Falls back to simulated mode when WireGuard is not configured.
// =============================================================================

const { exec } = require('child_process');

let _state = {
  connected: false,
  route: null,
  simulated: false,
  connectedAt: null,
  reconnectCount: 0,
};

let _lastHealthCheck = null;

async function connect(route) {
  if (!route || !route.relay) {
    return { success: false, simulated: false, message: 'Invalid route: missing relay info' };
  }

  if (_state.connected) {
    _state.reconnectCount++;
  }

  const relay = route.relay;
  const configPath = relay.configPath || null;

  if (configPath) {
    try {
      const wgAvailable = await isWireGuardAvailable();
      if (!wgAvailable) {
        _state = {
          connected: true,
          route,
          simulated: true,
          connectedAt: Date.now(),
          reconnectCount: _state.reconnectCount,
        };
        _lastHealthCheck = Date.now();

        return {
          success: true,
          simulated: true,
          message: `WireGuard not installed — simulated connection to ${relay.label}`,
        };
      }

      await _execWireGuard(_wireGuardUpCommand(configPath));

      _state = {
        connected: true,
        route,
        simulated: false,
        connectedAt: Date.now(),
        reconnectCount: _state.reconnectCount,
      };
      _lastHealthCheck = Date.now();

      return {
        success: true,
        simulated: false,
        message: `Connected to ${relay.label} via WireGuard`,
      };
    } catch (err) {
      _state = {
        connected: true,
        route,
        simulated: true,
        connectedAt: Date.now(),
        reconnectCount: _state.reconnectCount,
      };
      _lastHealthCheck = Date.now();

      return {
        success: true,
        simulated: true,
        message: `WireGuard error (${err.message}) — simulated connection to ${relay.label}`,
      };
    }
  }

  _state = {
    connected: true,
    route,
    simulated: true,
    connectedAt: Date.now(),
    reconnectCount: _state.reconnectCount,
  };
  _lastHealthCheck = Date.now();

  return {
    success: true,
    simulated: true,
    message: `Simulated connection to ${relay.label} (no WireGuard config set)`,
  };
}

async function disconnect() {
  if (!_state.connected) {
    return { success: true, message: 'Already disconnected' };
  }

  const wasSimulated = _state.simulated;
  const relayLabel = _state.route ? _state.route.relay.label : 'unknown';

  if (!wasSimulated && _state.route && _state.route.relay.configPath) {
    try {
      await _execWireGuard(_wireGuardDownCommand(_state.route.relay.configPath));
    } catch (err) {
      console.error(`[tunnelManager] WireGuard down error: ${err.message}`);
    }
  }

  _state = {
    connected: false,
    route: null,
    simulated: false,
    connectedAt: null,
    reconnectCount: 0,
  };
  _lastHealthCheck = null;

  return {
    success: true,
    message: `Disconnected from ${relayLabel}${wasSimulated ? ' (was simulated)' : ''}`,
  };
}

function getStatus() {
  const uptime = _state.connectedAt ? Date.now() - _state.connectedAt : 0;

  return {
    connected: _state.connected,
    route: _state.route
      ? {
          relayId: _state.route.relay.id,
          relayLabel: _state.route.relay.label,
          relayHost: _state.route.relay.host,
          relayPort: _state.route.relay.port,
          estimatedTotalMs: _state.route.measurement
            ? _state.route.measurement.estimatedTotalMs
            : null,
        }
      : null,
    simulated: _state.simulated,
    connectedAt: _state.connectedAt,
    uptime,
    reconnectCount: _state.reconnectCount,
  };
}

function isWireGuardAvailable() {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'where wireguard' : 'wg --version';
    exec(command, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

function getConnectionHealth() {
  if (!_state.connected) {
    return {
      status: 'disconnected',
      lastCheck: _lastHealthCheck,
      uptime: 0,
    };
  }

  const uptime = _state.connectedAt ? Date.now() - _state.connectedAt : 0;

  let status = 'healthy';
  if (_state.simulated) {
    status = 'healthy';
  } else if (_lastHealthCheck) {
    const timeSinceCheck = Date.now() - _lastHealthCheck;
    if (timeSinceCheck > 60000) {
      status = 'degraded';
    }
  }

  _lastHealthCheck = Date.now();

  return {
    status,
    lastCheck: _lastHealthCheck,
    uptime,
  };
}

function _wireGuardUpCommand(configPath) {
  const quoted = `"${configPath}"`;
  if (process.platform === 'win32') {
    return `wireguard /installtunnelservice ${quoted}`;
  }
  return `wg-quick up ${quoted}`;
}

function _wireGuardDownCommand(configPath) {
  const quoted = `"${configPath}"`;
  if (process.platform === 'win32') {
    return `wireguard /uninstalltunnelservice ${quoted}`;
  }
  return `wg-quick down ${quoted}`;
}

function _execWireGuard(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  isWireGuardAvailable,
  getConnectionHealth,
};
