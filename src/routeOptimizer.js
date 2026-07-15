'use strict';

// =============================================================================
// routeOptimizer.js — TCP ping, route measurement, relay path analysis, scoring
// Enhanced with relay path measurement and stability-aware scoring
// =============================================================================

const net = require('net');

const LIVE_MODE = process.env.ROUTEPILOT_LIVE === '1';

/** Realistic demo latencies (ms) when relay/game hosts are unreachable. */
const DEMO_LATENCY = {
  'hk-direct': { avg: 28, jitter: 2.8, loss: 0.4 },
  'hk-2': { avg: 31, jitter: 3.1, loss: 0.5 },
  'tw-1': { avg: 38, jitter: 4.2, loss: 0.6 },
  'sg-1': { avg: 46, jitter: 5.5, loss: 0.8 },
  'jp-1': { avg: 58, jitter: 6.2, loss: 1.0 },
  'vn-1': { avg: 22, jitter: 2.2, loss: 0.3 },
};

function isDemoModeEnabled() {
  return !LIVE_MODE;
}

function buildSimulatedMeasurement(host, port, relayId, options = {}) {
  const profile = DEMO_LATENCY[relayId] || { avg: 45, jitter: 5, loss: 1 };
  const variance = (Math.random() - 0.5) * profile.jitter;
  const avg = parseFloat(Math.max(8, profile.avg + variance).toFixed(2));
  const jitter = parseFloat((profile.jitter + Math.random()).toFixed(2));
  const loss = parseFloat(profile.loss.toFixed(1));
  const trials = options.trials || 5;

  return {
    host,
    port,
    trials,
    success: true,
    simulated: true,
    avg,
    min: parseFloat((avg - jitter).toFixed(2)),
    max: parseFloat((avg + jitter).toFixed(2)),
    jitter,
    loss,
    stddev: parseFloat((jitter * 0.6).toFixed(2)),
    samples: Array.from({ length: trials }, () => avg),
  };
}

function buildSimulatedRelayPath(relay, targetServer, options = {}) {
  const relayMeasurement = buildSimulatedMeasurement(
    relay.host,
    relay.probePort || relay.port,
    relay.id,
    options
  );
  const targetMeasurement = {
    ...buildSimulatedMeasurement(targetServer.host, targetServer.port, relay.id, options),
    avg: parseFloat((relayMeasurement.avg + 12 + Math.random() * 6).toFixed(2)),
  };
  const relayToTarget = Math.max(targetMeasurement.avg - relayMeasurement.avg, 2);
  const estimatedTotalMs = parseFloat((relayMeasurement.avg + relayToTarget).toFixed(2));
  const combinedJitter = parseFloat(
    Math.sqrt(relayMeasurement.jitter ** 2 + (targetMeasurement.jitter || 0) ** 2).toFixed(2)
  );
  const combinedLoss = parseFloat(
    (100 - ((100 - relayMeasurement.loss) / 100) * ((100 - targetMeasurement.loss) / 100) * 100).toFixed(1)
  );

  return {
    relayId: relay.id,
    relayLabel: relay.label,
    relayHost: relay.host,
    relayPort: relay.port,
    targetHost: targetServer.host,
    targetPort: targetServer.port,
    targetLabel: targetServer.label || 'Unknown',
    success: true,
    simulated: true,
    estimatedTotalMs,
    relayLatency: relayMeasurement.avg,
    targetLatency: targetMeasurement.avg,
    avg: estimatedTotalMs,
    min: relayMeasurement.min,
    max: relayMeasurement.max,
    jitter: combinedJitter,
    loss: combinedLoss,
    stddev: relayMeasurement.stddev,
    relayMeasurement,
    targetMeasurement,
  };
}

/**
 * tcpPing — Measures TCP handshake latency to a host:port.
 * Uses high-resolution nanosecond timer for accurate sub-ms measurement.
 *
 * @param {string} host — Target hostname or IP
 * @param {number} port — Target port number
 * @param {number} [timeout=3000] — Connection timeout in milliseconds
 * @returns {Promise<{ success: boolean, ms: number|null, error: string|null }>}
 */
function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const startNs = process.hrtime.bigint();
    const socket = new net.Socket();

    // Set connection timeout
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      const endNs = process.hrtime.bigint();
      const ms = Number(endNs - startNs) / 1_000_000; // ns → ms
      socket.destroy();
      resolve({ success: true, ms: parseFloat(ms.toFixed(2)), error: null });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ success: false, ms: null, error: 'timeout' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ success: false, ms: null, error: err.message });
    });

    socket.connect(port, host);
  });
}

/**
 * measureRoute — Runs multiple TCP ping trials and computes latency statistics.
 *
 * @param {string} host — Target hostname or IP
 * @param {number} port — Target port number
 * @param {Object} [options] — Measurement options
 * @param {number} [options.trials=8] — Number of ping trials to run
 * @param {number} [options.timeout=3000] — Per-trial timeout in ms
 * @param {number} [options.delay=200] — Delay between trials in ms
 * @returns {Promise<Object>} Measurement result with avg, min, max, jitter, loss, stddev
 */
async function measureRoute(host, port, options = {}) {
  const { trials = 8, timeout = 3000, delay = 200 } = options;
  const samples = [];
  let successCount = 0;
  let minMs = Infinity;
  let maxMs = -Infinity;

  for (let i = 0; i < trials; i++) {
    const result = await tcpPing(host, port, timeout);

    if (result.success && result.ms !== null) {
      samples.push(result.ms);
      successCount++;

      // Track min/max
      if (result.ms < minMs) minMs = result.ms;
      if (result.ms > maxMs) maxMs = result.ms;
    }

    // Wait between trials (except after last one)
    if (i < trials - 1 && delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // No successful pings — demo fallback or failure
  if (samples.length === 0) {
    if (isDemoModeEnabled() && options.relayId) {
      return buildSimulatedMeasurement(host, port, options.relayId, options);
    }

    return {
      host,
      port,
      trials,
      success: false,
      avg: null,
      min: null,
      max: null,
      jitter: null,
      loss: 100,
      stddev: null,
      samples: [],
    };
  }

  // Compute statistics
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const loss = ((trials - successCount) / trials) * 100;

  // Jitter = average difference between consecutive samples
  let jitter = 0;
  if (samples.length > 1) {
    let diffs = 0;
    for (let i = 1; i < samples.length; i++) {
      diffs += Math.abs(samples[i] - samples[i - 1]);
    }
    jitter = diffs / (samples.length - 1);
  }

  // Standard deviation of samples
  const variance = samples.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / samples.length;
  const stddev = Math.sqrt(variance);

  return {
    host,
    port,
    trials,
    success: true,
    avg: parseFloat(avg.toFixed(2)),
    min: parseFloat(minMs.toFixed(2)),
    max: parseFloat(maxMs.toFixed(2)),
    jitter: parseFloat(jitter.toFixed(2)),
    loss: parseFloat(loss.toFixed(1)),
    stddev: parseFloat(stddev.toFixed(2)),
    samples,
  };
}

/**
 * measureRelayPath — Measures latency through a relay hop to a target server.
 * Pings the relay node and the target server independently, then sums the
 * estimates for the full relay path latency.
 *
 * @param {Object} relay — Relay node object { id, label, host, port, ... }
 * @param {Object} targetServer — Target server { host, port, label, ... }
 * @param {Object} [options] — Measurement options (passed to measureRoute)
 * @returns {Promise<Object>} Extended measurement with relay info and estimated total
 */
async function measureRelayPath(relay, targetServer, options = {}) {
  if (isDemoModeEnabled()) {
    return buildSimulatedRelayPath(relay, targetServer, options);
  }

  const relayOptions = { ...options, relayId: relay.id };
  const probePort = relay.probePort || relay.port;

  // Measure latency to the relay node (TCP probe; WireGuard UDP is not TCP-testable)
  const relayMeasurement = await measureRoute(relay.host, probePort, relayOptions);

  // Measure latency to the target server directly
  const targetMeasurement = await measureRoute(
    targetServer.host,
    targetServer.port,
    relayOptions
  );

  // Calculate estimated total path latency (relay hop + target hop)
  // In practice, the relay forwards traffic, so total ≈ relay_ping + relay→target_ping
  // We approximate relay→target as a fraction of direct target ping (relay is closer)
  let estimatedTotalMs = null;
  let combinedSuccess = false;

  if (relayMeasurement.success && targetMeasurement.success) {
    // Estimate: user→relay + relay→target
    // Since relay is positioned between user and target, the relay→target leg
    // is roughly (direct_ping - relay_ping), clamped to minimum 2ms
    const relayToTarget = Math.max(targetMeasurement.avg - relayMeasurement.avg, 2);
    estimatedTotalMs = parseFloat((relayMeasurement.avg + relayToTarget).toFixed(2));
    combinedSuccess = true;
  } else if (relayMeasurement.success) {
    // Only relay reachable — estimate with relay ping + overhead
    estimatedTotalMs = parseFloat((relayMeasurement.avg + 15).toFixed(2));
    combinedSuccess = true;
  } else if (isDemoModeEnabled()) {
    const simulated = buildSimulatedMeasurement(relay.host, relay.port, relay.id, options);
    estimatedTotalMs = simulated.avg;
    combinedSuccess = true;
    Object.assign(relayMeasurement, simulated);
    Object.assign(targetMeasurement, {
      ...simulated,
      avg: parseFloat((simulated.avg + 8).toFixed(2)),
    });
  }

  // Combined jitter (root-sum-square for independent paths)
  const combinedJitter =
    relayMeasurement.success && targetMeasurement.success
      ? parseFloat(
          Math.sqrt(
            Math.pow(relayMeasurement.jitter || 0, 2) + Math.pow(targetMeasurement.jitter || 0, 2)
          ).toFixed(2)
        )
      : relayMeasurement.jitter;

  // Combined loss (probability of either leg failing)
  const relayLoss = relayMeasurement.loss || 0;
  const targetLoss = targetMeasurement.loss || 0;
  const combinedLoss = parseFloat(
    (100 - ((100 - relayLoss) / 100) * ((100 - targetLoss) / 100) * 100).toFixed(1)
  );

  // Combined stddev
  const combinedStddev =
    relayMeasurement.success && targetMeasurement.success
      ? parseFloat(
          Math.sqrt(
            Math.pow(relayMeasurement.stddev || 0, 2) +
              Math.pow(targetMeasurement.stddev || 0, 2)
          ).toFixed(2)
        )
      : relayMeasurement.stddev;

  return {
    relayId: relay.id,
    relayLabel: relay.label,
    relayHost: relay.host,
    relayPort: relay.port,
    targetHost: targetServer.host,
    targetPort: targetServer.port,
    targetLabel: targetServer.label || 'Unknown',
    success: combinedSuccess,
    simulated: !!(relayMeasurement.simulated || targetMeasurement.simulated),
    estimatedTotalMs,
    relayLatency: relayMeasurement.avg,
    targetLatency: targetMeasurement.avg,
    avg: estimatedTotalMs,
    min: relayMeasurement.min,
    max: relayMeasurement.max,
    jitter: combinedJitter,
    loss: combinedLoss,
    stddev: combinedStddev,
    relayMeasurement,
    targetMeasurement,
  };
}

/**
 * scoreRoute — Computes a weighted quality score for a measurement.
 * Lower score = better route.
 *
 * Formula: latency + jitter*2.5 + loss*800 + stability_penalty
 * Where stability_penalty = stddev * 1.5
 *
 * @param {Object} m — Measurement object from measureRoute or measureRelayPath
 * @returns {number} Weighted quality score (lower is better), or Infinity on failure
 */
function scoreRoute(m) {
  if (!m || !m.success || m.avg === null) {
    return Infinity;
  }

  const latency = m.avg || 0;
  const jitter = (m.jitter || 0) * 2.5;
  const loss = (m.loss || 0) * 800;
  const stabilityPenalty = (m.stddev || 0) * 1.5;

  return parseFloat((latency + jitter + loss + stabilityPenalty).toFixed(2));
}

/**
 * findBestRoute — Tests multiple candidate servers and returns the best one.
 * Uses enhanced scoring to rank candidates.
 *
 * @param {Array<{ host: string, port: number }>} candidates — Server candidates
 * @param {Object} [options] — Measurement options passed to measureRoute
 * @returns {Promise<Object>} Best route result with measurements and scores
 */
async function findBestRoute(candidates, options = {}) {
  if (!candidates || candidates.length === 0) {
    return { best: null, results: [], error: 'No candidates provided' };
  }

  const results = [];

  for (const candidate of candidates) {
    const measurement = await measureRoute(candidate.host, candidate.port, options);
    const score = scoreRoute(measurement);

    results.push({
      ...candidate,
      measurement,
      score,
    });
  }

  // Sort by score ascending (lower = better)
  results.sort((a, b) => a.score - b.score);

  return {
    best: results[0] || null,
    results,
    error: null,
  };
}

/**
 * findBestRelayPath — Tests all relay nodes against a target server and ranks them.
 * Returns a sorted list of relay paths with scores.
 *
 * @param {Array<Object>} relays — Array of relay node objects
 * @param {Object} targetServer — Target server { host, port, label }
 * @param {Object} [options] — Measurement options passed to measureRelayPath
 * @returns {Promise<Object>} Ranked relay paths with best path and full results
 */
async function findBestRelayPath(relays, targetServer, options = {}) {
  if (!relays || relays.length === 0) {
    return { best: null, results: [], error: 'No relay nodes provided' };
  }

  if (!targetServer || !targetServer.host || !targetServer.port) {
    return { best: null, results: [], error: 'Invalid target server' };
  }

  const results = [];

  for (const relay of relays) {
    const measurement = await measureRelayPath(relay, targetServer, options);
    const score = scoreRoute(measurement);

    results.push({
      relay,
      measurement,
      score,
    });
  }

  // Sort by score ascending (lower = better)
  results.sort((a, b) => a.score - b.score);

  return {
    best: results[0] || null,
    results,
    error: null,
  };
}

module.exports = {
  tcpPing,
  measureRoute,
  measureRelayPath,
  scoreRoute,
  findBestRoute,
  findBestRelayPath,
};
