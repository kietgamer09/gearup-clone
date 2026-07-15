'use strict';

// =============================================================================
// airEngine.js — Adaptive Intelligent Routing (AIR) Engine
// Continuously monitors route quality and dynamically switches to better relays
// when sustained improvement is detected.
// =============================================================================

const { EventEmitter } = require('events');

/**
 * AIREngine — Adaptive Intelligent Routing Engine.
 *
 * Continuously monitors the active relay route, periodically tests alternatives,
 * and switches to a better relay path when sustained improvement (>15% for 2
 * consecutive cycles) is detected. Maintains a hot-standby list of top relays.
 *
 * Events:
 *  - 'ping-update'    : { timestamp, latency, jitter, loss, relay, routeId }
 *  - 'route-changed'  : { oldRoute, newRoute, reason, improvement }
 *  - 'status-update'  : { status, message }
 *
 * @extends EventEmitter
 */
class AIREngine extends EventEmitter {
  /**
   * @param {Object} routeOptimizer — The routeOptimizer module (must export
   *   measureRelayPath, scoreRoute, findBestRelayPath)
   */
  constructor(routeOptimizer) {
    super();

    if (!routeOptimizer) {
      throw new Error('AIREngine requires a routeOptimizer module');
    }

    this._optimizer = routeOptimizer;

    // Runtime state
    this._running = false;
    this._intervalHandle = null;
    this._config = null;
    this._currentRoute = null;
    this._hotStandby = [];
    this._cycleCount = 0;

    // Candidate tracking for sustained-improvement detection
    // Maps relayId → { betterCount: number, lastScore: number }
    this._candidateTracker = new Map();

    // Session statistics
    this._stats = {
      sessionStart: null,
      totalPings: 0,
      latencySum: 0,
      minLatency: Infinity,
      maxLatency: -Infinity,
      routeSwitches: 0,
    };
  }

  /**
   * start — Begin adaptive route monitoring.
   *
   * @param {Object} config
   * @param {Object} config.targetServer — Target game server { host, port, label }
   * @param {Array<Object>} config.relays — Available relay nodes
   * @param {number} [config.intervalMs=10000] — Monitoring interval in ms
   * @param {number} [config.maxHotStandby=3] — Max relays to keep in hot-standby
   */
  async start({ targetServer, relays, intervalMs = 10000, maxHotStandby = 3 }) {
    if (this._running) {
      this.emit('status-update', {
        status: 'monitoring',
        message: 'AIR Engine is already running',
      });
      return;
    }

    // Validate inputs
    if (!targetServer || !targetServer.host || !targetServer.port) {
      throw new Error('targetServer with host and port is required');
    }
    if (!relays || relays.length === 0) {
      throw new Error('At least one relay node is required');
    }

    this._running = true;
    this._config = { targetServer, relays, intervalMs, maxHotStandby };
    this._stats.sessionStart = Date.now();
    this._cycleCount = 0;
    this._candidateTracker.clear();

    this.emit('status-update', {
      status: 'monitoring',
      message: 'AIR Engine starting — running initial relay scan...',
    });

    // --- Initial full scan to find best relay path ---
    try {
      const initialScan = await this._optimizer.findBestRelayPath(relays, targetServer, {
        trials: 4,
        delay: 150,
      });

      if (initialScan.best) {
        this._currentRoute = initialScan.best;

        // Build hot-standby from top N results (excluding current best)
        this._hotStandby = initialScan.results
          .filter((r) => r.relay.id !== this._currentRoute.relay.id && r.measurement.success)
          .slice(0, maxHotStandby);

        this.emit('status-update', {
          status: 'stable',
          message: `Initial route selected: ${this._currentRoute.relay.label} ` +
            `(${this._currentRoute.measurement.estimatedTotalMs}ms, score: ${this._currentRoute.score})`,
        });
      } else {
        this.emit('status-update', {
          status: 'degraded',
          message: 'No reachable relay found during initial scan',
        });
      }
    } catch (err) {
      this.emit('status-update', {
        status: 'degraded',
        message: `Initial scan error: ${err.message}`,
      });
    }

    // --- Start monitoring interval ---
    this._intervalHandle = setInterval(() => this._monitorCycle(), intervalMs);
  }

  /**
   * stop — Stop monitoring and clean up all timers.
   */
  stop() {
    if (!this._running) return;

    this._running = false;

    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }

    this._candidateTracker.clear();

    this.emit('status-update', {
      status: 'monitoring',
      message: 'AIR Engine stopped',
    });
  }

  /**
   * getCurrentRoute — Returns the currently active route.
   * @returns {Object|null} Current route object or null if none selected
   */
  getCurrentRoute() {
    return this._currentRoute;
  }

  /**
   * getStats — Returns session statistics.
   * @returns {Object} Session stats including avg/min/max latency, route switches, etc.
   */
  getStats() {
    const avgLatency =
      this._stats.totalPings > 0
        ? parseFloat((this._stats.latencySum / this._stats.totalPings).toFixed(2))
        : null;

    return {
      sessionStart: this._stats.sessionStart,
      totalPings: this._stats.totalPings,
      avgLatency,
      minLatency: this._stats.minLatency === Infinity ? null : this._stats.minLatency,
      maxLatency: this._stats.maxLatency === -Infinity ? null : this._stats.maxLatency,
      routeSwitches: this._stats.routeSwitches,
      currentRoute: this._currentRoute
        ? {
            relayId: this._currentRoute.relay.id,
            relayLabel: this._currentRoute.relay.label,
            estimatedTotalMs: this._currentRoute.measurement.estimatedTotalMs,
            score: this._currentRoute.score,
          }
        : null,
      hotStandby: this._hotStandby.map((r) => ({
        relayId: r.relay.id,
        relayLabel: r.relay.label,
        score: r.score,
      })),
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * _monitorCycle — Runs a single monitoring cycle.
   * Every cycle: ping current route.
   * Every 3rd cycle: also test alternative relays and possibly switch.
   */
  async _monitorCycle() {
    if (!this._running) return;

    this._cycleCount++;

    // --- Step 1: Ping current route ---
    if (this._currentRoute) {
      try {
        const ping = await this._optimizer.measureRelayPath(
          this._currentRoute.relay,
          this._config.targetServer,
          { trials: 3, delay: 100 }
        );

        // Update current route measurement
        this._currentRoute.measurement = ping;
        this._currentRoute.score = this._optimizer.scoreRoute(ping);

        // Update session stats
        if (ping.success && ping.estimatedTotalMs !== null) {
          this._stats.totalPings++;
          this._stats.latencySum += ping.estimatedTotalMs;
          if (ping.estimatedTotalMs < this._stats.minLatency) {
            this._stats.minLatency = ping.estimatedTotalMs;
          }
          if (ping.estimatedTotalMs > this._stats.maxLatency) {
            this._stats.maxLatency = ping.estimatedTotalMs;
          }
        }

        // Emit ping update
        this.emit('ping-update', {
          timestamp: Date.now(),
          latency: ping.estimatedTotalMs,
          jitter: ping.jitter,
          loss: ping.loss,
          relay: this._currentRoute.relay.label,
          routeId: this._currentRoute.relay.id,
        });

        // Check for degradation
        if (!ping.success || ping.loss > 30) {
          this.emit('status-update', {
            status: 'degraded',
            message: `Current route ${this._currentRoute.relay.label} is degraded ` +
              `(loss: ${ping.loss}%)`,
          });
        }
      } catch (err) {
        this.emit('status-update', {
          status: 'degraded',
          message: `Ping error on ${this._currentRoute.relay.label}: ${err.message}`,
        });
      }
    }

    // --- Step 2: Every 3rd cycle, test alternatives ---
    if (this._cycleCount % 3 === 0) {
      await this._testAlternatives();
    }
  }

  /**
   * _testAlternatives — Tests alternative relay paths and switches if a
   * significantly better route is sustained for 2 consecutive cycles.
   * Improvement threshold: >15% better score.
   */
  async _testAlternatives() {
    if (!this._currentRoute || !this._config) return;

    this.emit('status-update', {
      status: 'monitoring',
      message: 'Testing alternative relay paths...',
    });

    try {
      const scan = await this._optimizer.findBestRelayPath(
        this._config.relays,
        this._config.targetServer,
        { trials: 3, delay: 100 }
      );

      if (!scan.best) return;

      const currentScore = this._currentRoute.score;

      // Update hot-standby list
      this._hotStandby = scan.results
        .filter((r) => r.relay.id !== this._currentRoute.relay.id && r.measurement.success)
        .slice(0, this._config.maxHotStandby);

      // Check each alternative for sustained improvement
      for (const candidate of scan.results) {
        if (candidate.relay.id === this._currentRoute.relay.id) continue;
        if (!candidate.measurement.success) continue;

        const improvementRatio = (currentScore - candidate.score) / currentScore;

        if (improvementRatio > 0.15) {
          // This candidate is >15% better — track it
          const tracker = this._candidateTracker.get(candidate.relay.id) || {
            betterCount: 0,
            lastScore: Infinity,
          };

          tracker.betterCount++;
          tracker.lastScore = candidate.score;
          this._candidateTracker.set(candidate.relay.id, tracker);

          // Sustained improvement for 2 consecutive check cycles → switch!
          if (tracker.betterCount >= 2) {
            const oldRoute = { ...this._currentRoute };
            this._currentRoute = candidate;
            this._stats.routeSwitches++;
            this._candidateTracker.clear();

            const improvementPct = parseFloat((improvementRatio * 100).toFixed(1));

            this.emit('route-changed', {
              oldRoute: {
                relayId: oldRoute.relay.id,
                relayLabel: oldRoute.relay.label,
                score: oldRoute.score,
              },
              newRoute: {
                relayId: candidate.relay.id,
                relayLabel: candidate.relay.label,
                score: candidate.score,
                estimatedTotalMs: candidate.measurement.estimatedTotalMs,
              },
              reason: `Sustained ${improvementPct}% improvement over ${oldRoute.relay.label}`,
              improvement: improvementPct,
            });

            this.emit('status-update', {
              status: 'switching',
              message: `Switched to ${candidate.relay.label} ` +
                `(${candidate.measurement.estimatedTotalMs}ms, ${improvementPct}% better)`,
            });

            return; // Only switch once per cycle
          }
        } else {
          // Not better enough — reset tracker for this candidate
          this._candidateTracker.delete(candidate.relay.id);
        }
      }

      this.emit('status-update', {
        status: 'stable',
        message: `Route stable: ${this._currentRoute.relay.label} ` +
          `(${this._currentRoute.measurement.estimatedTotalMs}ms)`,
      });
    } catch (err) {
      this.emit('status-update', {
        status: 'degraded',
        message: `Alternative scan error: ${err.message}`,
      });
    }
  }
}

module.exports = { AIREngine };
