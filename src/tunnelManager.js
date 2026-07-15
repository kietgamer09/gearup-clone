'use strict';

// =============================================================================
// tunnelManager.js — WireGuard tunnel lifecycle management
// Handles connect/disconnect, health monitoring, and WireGuard availability.
// Falls back to simulated mode when WireGuard is not configured.
// =============================================================================

const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {{ connected: boolean, route: Object|null, simulated: boolean, connectedAt: number|null, reconnectCount: number }} */
let _state = {
  connected: false,
  route: null,
  simulated: false,
  connectedAt: null,
  reconnectCount: 0,
};

/** @type {string|null} Last health check timestamp */
let _lastHealthCheck = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * connect — Establishes a tunnel connection through the given route.
 *
 * If the route's relay has a configPath (WireGuard config), attempts to bring
 * up the WireGuard interface. Otherwise, simulates a successful connection
 * for development/testing.
 *
 * @param {Object} route — Route object containing relay info
 * @param {Object} route.relay — Relay node { id, label, host, port, configPath }
 * @param {Object} route.measurement — Measurement data
 * @returns {Promise<Object>} Connection result { success, simulated, message }
 */
async function connect(route) {
  if (!route || !route.relay) {
    return { success: false, simulated: false, message: 'Invalid route: missing relay info' };
  }

  // If already connected, increment reconnect count
  if (_state.connected) {
    _state.reconnectCount++;
  }

  const relay = route.relay;
  const configPath = relay.configPath || null;

  // --- Attempt real WireGuard connection if config exists ---
  if (configPath) {
    try {
      const wgAvailable = await isWireGuardAvailable();
      if (!wgAvailable) {
        // WireGuard binary not found — fall back to simulated
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

      // Bring up WireGuard interface using the config file
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
      // WireGuard command failed — fall back to simulated
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

  // --- No configPath — simulate success ---
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

/**
 * disconnect — Tears down the active tunnel connection.
 * If a real WireGuard tunnel is active, brings down the interface.
 *
 * @returns {Promise<Object>} Disconnection result { success, message }
 */
async function disconnect() {
  if (!_state.connected) {
    return { success: true, message: 'Already disconnected' };
  }

  const wasSimulated = _state.simulated;
  const relayLabel = _state.route ? _state.route.relay.label : 'unknown';

  // --- Tear down real WireGuard if active ---
  if (!wasSimulated && _state.route && _state.route.relay.configPath) {
    try {
      await _execWireGuard(_wireGuardDownCommand(_state.route.relay.configPath));
    } catch (err) {
      // Best-effort cleanup — log but don't fail
      console.error(`[tunnelManager] WireGuard down error: ${err.message}`);
    }
  }

  // Reset state
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

/**
 * getStatus — Returns the full tunnel connection status.
 *
 * @returns {Object} Status object with connection details and uptime
 */
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

/**
 * isWireGuardAvailable — Checks if the WireGuard CLI (`wg`) is available.
 * Runs `wg --version` and resolves true if the command succeeds.
 *
 * @returns {Promise<boolean>} True if WireGuard is installed and accessible
 */
function isWireGuardAvailable() {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'where wireguard' : 'wg --version';
    exec(command, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * getConnectionHealth — Returns health metrics for the active connection.
 *
 * @returns {Object} Health object { status, lastCheck, uptime }
 */
function getConnectionHealth() {
  if (!_state.connected) {
    return {
      status: 'disconnected',
      lastCheck: _lastHealthCheck,
      uptime: 0,
    };
  }

  const uptime = _state.connectedAt ? Date.now() - _state.connectedAt : 0;

  // Determine health status
  let status = 'healthy';
  if (_state.simulated) {
    // Simulated connections are always "healthy" in dev mode
    status = 'healthy';
  } else if (_lastHealthCheck) {
    const timeSinceCheck = Date.now() - _lastHealthCheck;
    // If we haven't checked in over 60 seconds, consider degraded
    if (timeSinceCheck > 60000) {
      status = 'degraded';
    }
  }

  // Update last check timestamp
  _lastHealthCheck = Date.now();

  return {
    status,
    lastCheck: _lastHealthCheck,
    uptime,
  };
}

// ---------------------------------------------------------------------------
// Private Helpers
// ---------------------------------------------------------------------------

/**
 * _wireGuardUpCommand — Platform-specific WireGuard bring-up command.
 */
function _wireGuardUpCommand(configPath) {
  const quoted = `"${configPath}"`;
  if (process.platform === 'win32') {
    return `wireguard /installtunnelservice ${quoted}`;
  }
  return `wg-quick up ${quoted}`;
}

/**
 * _wireGuardDownCommand — Platform-specific WireGuard tear-down command.
 */
function _wireGuardDownCommand(configPath) {
  const quoted = `"${configPath}"`;
  if (process.platform === 'win32') {
    return `wireguard /uninstalltunnelservice ${quoted}`;
  }
  return `wg-quick down ${quoted}`;
}

/**
 * _execWireGuard — Executes a WireGuard shell command.
 *
 * @param {string} command — The shell command to execute
 * @returns {Promise<string>} Command stdout on success
 * @throws {Error} If the command fails
 */
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
