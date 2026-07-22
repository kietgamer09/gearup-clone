'use strict';

// =============================================================================
// airEngine.js — Adaptive Intelligent Routing (AIR) Engine
// =============================================================================

const { EventEmitter } = require('events');

class AIREngine extends EventEmitter {
  constructor(routeOptimizer) {
    super();

    if (!routeOptimizer) {
      throw new Error('AIREngine requires a routeOptimizer module');
    }

    this._optimizer = routeOptimizer;

    this._running = false;
    this._intervalHandle = null;
    this._config = null;
    this._currentRoute = null;
    this._hotStandby = [];
    this._cycleCount = 0;

    this._candidateTracker = new Map();

    this._stats = {
      sessionStart: null,
      totalPings: 0,
      latencySum: 0,
      minLatency: Infinity,
      maxLatency: -Infinity,
      routeSwitches: 0,
    };
  }

  async start({ targetServer, relays, intervalMs = 10000, maxHotStandby = 3 }) {
    if (this._running) {
      this.emit('status-update', {
        status: 'monitoring',
        message: 'AIR Engine is already running',
      });
      return;
    }

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

    try {
      const initialScan = await this._optimizer.findBestRelayPath(relays, targetServer, {
        trials: 4,
        delay: 150,
      });

      if (initialScan.best) {
        this._currentRoute = initialScan.best;

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

    this._intervalHandle = setInterval(() => this._monitorCycle(), intervalMs);
  }

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

  getCurrentRoute() {
    return this._currentRoute;
  }

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

  async _monitorCycle() {
    if (!this._running) return;

    this._cycleCount++;

    if (this._currentRoute) {
      try {
        const ping = await this._optimizer.measureRelayPath(
          this._currentRoute.relay,
          this._config.targetServer,
          { trials: 3, delay: 100 }
        );

        this._currentRoute.measurement = ping;
        this._currentRoute.score = this._optimizer.scoreRoute(ping);

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

        this.emit('ping-update', {
          timestamp: Date.now(),
          latency: ping.estimatedTotalMs,
          jitter: ping.jitter,
          loss: ping.loss,
          relay: this._currentRoute.relay.label,
          routeId: this._currentRoute.relay.id,
        });

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

    if (this._cycleCount % 3 === 0) {
      await this._testAlternatives();
    }
  }

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

      this._hotStandby = scan.results
        .filter((r) => r.relay.id !== this._currentRoute.relay.id && r.measurement.success)
        .slice(0, this._config.maxHotStandby);

      for (const candidate of scan.results) {
        if (candidate.relay.id === this._currentRoute.relay.id) continue;
        if (!candidate.measurement.success) continue;

        const improvementRatio = (currentScore - candidate.score) / currentScore;

        if (improvementRatio > 0.15) {
          const tracker = this._candidateTracker.get(candidate.relay.id) || {
            betterCount: 0,
            lastScore: Infinity,
          };

          tracker.betterCount++;
          tracker.lastScore = candidate.score;
          this._candidateTracker.set(candidate.relay.id, tracker);

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

            return;
          }
        } else {
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
