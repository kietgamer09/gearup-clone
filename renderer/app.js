'use strict';

/* ═══════════════════════════════════════════════════
   RoutePilot — Application Logic
   ═══════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────
const state = {
  games: [],
  activeGame: null,
  activeServer: null,
  routes: [],
  selectedRoute: null,
  boosted: false,
  airActive: false,
  pingHistory: [],          // last 60 data points
  sessionStart: null,
  beforePing: null,
  currentPing: null,
  stats: { avgPing: 0, minPing: 999, maxPing: 0, routeSwitches: 0 },
  sessionTimerInterval: null,
  graphRAF: null,
};

// ── DOM Cache ──────────────────────────────────────
const el = {};
const DOM_IDS = [
  'app', 'sidebar', 'gameList', 'engineDot', 'engineText',
  'topbarGameName', 'serverDropdown', 'retestBtn', 'settingsBtn',
  'heroSection', 'boostContainer', 'boostBtn', 'boostIcon',
  'boostRingOuter', 'boostRingMid', 'boostRingInner',
  'pingValue', 'boostStatus',
  'beforePingValue', 'afterPingValue', 'improveValue', 'sessionTimer',
  'routeVisualization', 'routeLine1', 'routeLine2',
  'routePulse1', 'routePulse2',
  'routeLat1', 'routeLat2',
  'relayName', 'relayDetail', 'serverDetail',
  'pingGraph', 'graphLegend',
  'routeCardsGrid', 'routeCount',
  'airDot', 'airLabel', 'airHotStandby', 'airSwitches', 'airUptime',
  'settingsOverlay', 'settingsPanel', 'settingsClose',
  'settingGame', 'settingServer', 'settingAutoBoost', 'settingAIR', 'airSensitivityValue',
  'toastContainer',
];

// ── API Shorthand ──────────────────────────────────
const api = window.routepilot || {};

// ═══════════════════════════════════════════════════
//  INITIALISATION
// ═══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  bindEvents();
  initCanvas();
  loadGames();
  loadSettings();
  startPingSubscription();
  startAIRSubscriptions();
});

function cacheDom() {
  for (const id of DOM_IDS) {
    el[id] = document.getElementById(id);
  }
}

// ═══════════════════════════════════════════════════
//  EVENT BINDINGS
// ═══════════════════════════════════════════════════
function bindEvents() {
  el.boostBtn.addEventListener('click', handleBoostToggle);
  el.retestBtn.addEventListener('click', () => testRoutes());
  el.settingsBtn.addEventListener('click', openSettings);
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsOverlay.addEventListener('click', closeSettings);
  el.serverDropdown.addEventListener('change', handleServerChange);

  // Settings controls
  el.settingAutoBoost.addEventListener('change', () => {
    saveSetting('autoBoost', el.settingAutoBoost.checked);
  });
  el.settingAIR.addEventListener('input', () => {
    el.airSensitivityValue.textContent = el.settingAIR.value;
  });
  el.settingAIR.addEventListener('change', () => {
    saveSetting('airSensitivity', parseInt(el.settingAIR.value, 10));
  });
  el.settingGame.addEventListener('change', () => {
    saveSetting('preferredGame', el.settingGame.value);
  });
  el.settingServer.addEventListener('change', () => {
    saveSetting('preferredServer', el.settingServer.value);
  });
}

// ═══════════════════════════════════════════════════
//  GAMES & SERVERS
// ═══════════════════════════════════════════════════
async function loadGames() {
  try {
    const games = await api.listGames();
    state.games = games || [];
    renderGameList();
    populateSettingGames();

    // Auto-select first game
    if (state.games.length > 0) {
      selectGame(state.games[0]);
    }
  } catch (err) {
    console.error('Failed to load games:', err);
    showToast('Failed to load game list', 'error');
  }
}

function renderGameList() {
  el.gameList.innerHTML = '';
  for (const game of state.games) {
    const li = document.createElement('li');
    li.className = 'game-item';
    li.dataset.gameId = game.id;
    li.innerHTML = `
      <div class="game-icon">${game.icon || '🎮'}</div>
      <div class="game-info">
        <div class="game-name">${escHtml(game.name)}</div>
        <div class="game-publisher">${escHtml(game.publisher || '')}</div>
      </div>
      <span class="game-status-dot"></span>
    `;
    li.addEventListener('click', () => selectGame(game));
    el.gameList.appendChild(li);
  }
}

async function selectGame(game) {
  state.activeGame = game;
  el.topbarGameName.textContent = game.name;

  // Highlight in sidebar
  el.gameList.querySelectorAll('.game-item').forEach(item => {
    item.classList.toggle('active', item.dataset.gameId === String(game.id));
  });

  // Load servers — prefer inline servers array, fall back to API
  try {
    const servers = game.servers || await api.getServers(game.id);
    populateServerDropdown(servers);

    // Auto-select first HK server
    const hkServer = servers.find(s =>
      /hong\s*kong|hk/i.test(s.label || s.region || s.name || '')
    ) || servers[0];

    if (hkServer) {
      el.serverDropdown.value = hkServer.id;
      state.activeServer = hkServer;
      el.serverDetail.textContent = hkServer.label || hkServer.region || 'Hong Kong';
      testRoutes();
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
    showToast('Failed to load servers', 'error');
  }
}

function populateServerDropdown(servers) {
  el.serverDropdown.innerHTML = '<option value="">— Choose Server —</option>';
  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${regionFlag(s.region || s.label || '')} ${s.label || s.id}`;
    el.serverDropdown.appendChild(opt);
  }
}

function handleServerChange() {
  const val = el.serverDropdown.value;
  if (!val || !state.activeGame) return;

  const servers = state.activeGame.servers || [];
  state.activeServer = servers.find(s => s.id === val) || { id: val, label: val };
  el.serverDetail.textContent = state.activeServer.label || state.activeServer.region || val;
  testRoutes();
}

// ═══════════════════════════════════════════════════
//  ROUTE TESTING
// ═══════════════════════════════════════════════════
async function testRoutes() {
  if (!state.activeServer) return;

  el.routeCardsGrid.innerHTML = `
    <div class="route-cards-loading">
      <div class="spinner"></div>
      Testing routes...
    </div>
  `;
  el.routeCount.textContent = 'scanning...';

  try {
    const results = await api.testRoutes({
      gameId: state.activeGame?.id,
      serverId: state.activeServer?.id || state.activeServer?.name,
    });

    state.routes = results || [];
    renderRouteCards();

    // Auto-select best route
    if (state.routes.length > 0) {
      selectRoute(state.routes[0]);
      state.beforePing = state.routes[0].avgLatency || state.routes[0].latency;
      el.beforePingValue.textContent = Math.round(state.beforePing);
    }
  } catch (err) {
    console.error('Route test failed:', err);
    el.routeCardsGrid.innerHTML = '';
    showToast('Route testing failed', 'error');
  }
}

function renderRouteCards() {
  el.routeCardsGrid.innerHTML = '';
  el.routeCount.textContent = `${state.routes.length} relay${state.routes.length !== 1 ? 's' : ''}`;

  state.routes.forEach((route, index) => {
    const lat = route.avgLatency || route.latency || 0;
    const jitter = route.jitter || 0;
    const loss = route.loss || 0;
    const rank = index + 1;

    const card = document.createElement('div');
    card.className = 'route-card';
    card.dataset.routeIndex = index;

    const latClass = lat < 30 ? 'latency-good' : lat < 60 ? 'latency-ok' : 'latency-bad';
    const rankClass = rank <= 3 ? `rank-${rank}` : '';

    card.innerHTML = `
      <div class="route-card-rank ${rankClass}">${rank}</div>
      <div class="route-card-header">
        <span class="route-card-flag">${regionFlag(route.region || route.relay || '')}</span>
        <span class="route-card-name">${escHtml(route.relay || route.name || `Relay ${rank}`)}</span>
      </div>
      <div class="route-card-metrics">
        <div class="route-metric">
          <span class="route-metric-val ${latClass}">${Math.round(lat)} ms</span>
          <span class="route-metric-label">Latency</span>
        </div>
        <div class="route-metric">
          <span class="route-metric-val">${jitter.toFixed(1)} ms</span>
          <span class="route-metric-label">Jitter</span>
        </div>
        <div class="route-metric">
          <span class="route-metric-val">${(loss * 100).toFixed(1)}%</span>
          <span class="route-metric-label">Loss</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => selectRoute(route, index));
    el.routeCardsGrid.appendChild(card);
  });
}

function selectRoute(route, index) {
  state.selectedRoute = route;

  // Highlight card
  const idx = index !== undefined ? index : state.routes.indexOf(route);
  el.routeCardsGrid.querySelectorAll('.route-card').forEach((c, i) => {
    c.classList.toggle('selected', i === idx);
  });

  // Update route visualization
  const lat = route.avgLatency || route.latency || 0;
  el.relayName.textContent = route.relay || route.name || 'Relay';
  el.relayDetail.textContent = route.region || '--';
  el.routeLat1.textContent = `${Math.round(lat * 0.6)} ms`;
  el.routeLat2.textContent = `${Math.round(lat * 0.4)} ms`;
}

// ═══════════════════════════════════════════════════
//  BOOST FLOW
// ═══════════════════════════════════════════════════
async function handleBoostToggle() {
  if (state.boosted) {
    await stopBoosting();
  } else {
    await startBoosting();
  }
}

async function startBoosting() {
  if (!state.selectedRoute) {
    showToast('Select a route first', 'warning');
    return;
  }

  setBoostState('connecting');

  try {
    const result = await api.startBoost(state.selectedRoute);

    if (result && result.error) {
      showToast(`Boost failed: ${result.error}`, 'error');
      setBoostState('idle');
      return;
    }

    const isSimulated = result && result.simulated;
    state.boosted = true;
    state.sessionStart = Date.now();
    state.pingHistory = [];

    // Record before ping
    if (!state.beforePing && state.selectedRoute) {
      state.beforePing = state.selectedRoute.avgLatency || state.selectedRoute.latency;
      el.beforePingValue.textContent = Math.round(state.beforePing);
    }

    setBoostState('boosted');
    startSessionTimer();
    startAIR();
    showToast(
      isSimulated
        ? 'Boost active (demo mode — add a WireGuard .conf in relays/ for real routing)'
        : 'Boost activated! Route optimized.',
      isSimulated ? 'info' : 'success'
    );

    // Update engine status
    el.engineDot.classList.add('active');
    el.engineText.textContent = 'Engine Active';

  } catch (err) {
    console.error('Boost start failed:', err);
    showToast('Failed to start boost', 'error');
    setBoostState('idle');
  }
}

async function stopBoosting() {
  setBoostState('stopping');

  try {
    await api.stopBoost();
    await stopAIR();

    state.boosted = false;
    state.sessionStart = null;
    clearInterval(state.sessionTimerInterval);
    state.sessionTimerInterval = null;

    setBoostState('idle');
    showToast('Boost disconnected', 'info');

    el.engineDot.classList.remove('active');
    el.engineText.textContent = 'Engine Idle';

  } catch (err) {
    console.error('Boost stop failed:', err);
    showToast('Failed to stop boost', 'error');
    setBoostState('boosted'); // revert
  }
}

function setBoostState(mode) {
  const c = el.boostContainer;
  c.classList.remove('boosted', 'connecting', 'stopping');
  el.routeVisualization.classList.remove('boosted');

  switch (mode) {
    case 'connecting':
      c.classList.add('connecting');
      el.boostStatus.textContent = 'Connecting...';
      el.boostIcon.textContent = 'hourglass_empty';
      break;
    case 'boosted':
      c.classList.add('boosted');
      el.boostStatus.textContent = 'Boosted';
      el.boostIcon.textContent = 'flash_on';
      el.routeVisualization.classList.add('boosted');
      break;
    case 'stopping':
      c.classList.add('stopping');
      el.boostStatus.textContent = 'Disconnecting...';
      el.boostIcon.textContent = 'hourglass_empty';
      break;
    default: // idle
      el.boostStatus.textContent = 'Ready to Boost';
      el.boostIcon.textContent = 'bolt';
      break;
  }
}

// ═══════════════════════════════════════════════════
//  SESSION TIMER
// ═══════════════════════════════════════════════════
function startSessionTimer() {
  clearInterval(state.sessionTimerInterval);
  state.sessionTimerInterval = setInterval(updateSessionTimer, 1000);
  updateSessionTimer();
}

function updateSessionTimer() {
  if (!state.sessionStart) {
    el.sessionTimer.textContent = '00:00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  el.sessionTimer.textContent = `${h}:${m}:${s}`;
}

// ═══════════════════════════════════════════════════
//  AIR (Adaptive Intelligent Routing)
// ═══════════════════════════════════════════════════
async function startAIR() {
  if (!state.selectedRoute || !state.activeServer) return;

  try {
    await api.startAIR({
      targetServer: state.activeServer,
      gameId: state.activeGame ? state.activeGame.id : '',
      intervalMs: 10000,
    });

    state.airActive = true;
    el.airDot.classList.add('active');
    el.airLabel.textContent = 'AIR Active';
  } catch (err) {
    console.error('AIR start failed:', err);
  }
}

async function stopAIR() {
  try {
    await api.stopAIR();
  } catch (err) {
    console.error('AIR stop failed:', err);
  }
  state.airActive = false;
  el.airDot.classList.remove('active');
  el.airLabel.textContent = 'AIR Inactive';
}

// ═══════════════════════════════════════════════════
//  PING SUBSCRIPTIONS
// ═══════════════════════════════════════════════════
function startPingSubscription() {
  if (!api.onPingUpdate) return;

  api.onPingUpdate((data) => {
    const lat = data.latency;
    state.currentPing = lat;

    // Update boost circle ping display
    el.pingValue.textContent = Math.round(lat);

    // Update after ping
    if (state.boosted) {
      el.afterPingValue.textContent = Math.round(lat);
      updateImprovement();
    }

    // Push to history (keep last 60)
    state.pingHistory.push({
      timestamp: data.timestamp || Date.now(),
      latency: lat,
      jitter: data.jitter || 0,
      loss: data.loss || 0,
    });
    if (state.pingHistory.length > 60) {
      state.pingHistory.shift();
    }

    // Stats
    state.stats.avgPing = state.pingHistory.reduce((a, p) => a + p.latency, 0) / state.pingHistory.length;
    state.stats.minPing = Math.min(state.stats.minPing, lat);
    state.stats.maxPing = Math.max(state.stats.maxPing, lat);

    el.graphLegend.textContent = `${Math.round(state.stats.avgPing)} ms avg`;

    drawPingGraph();
  });
}

function startAIRSubscriptions() {
  if (api.onAIRRouteChanged) {
    api.onAIRRouteChanged((data) => {
      state.stats.routeSwitches++;
      el.airSwitches.textContent = state.stats.routeSwitches;

      // Find new route in list and select it
      const newRoute = state.routes.find(r =>
        (r.relay || r.name) === (data.newRoute?.relay || data.newRoute?.name)
      );
      if (newRoute) {
        selectRoute(newRoute);
      }

      const reason = data.reason || 'optimization';
      const improvement = data.improvement ? ` (${Math.round(data.improvement)}ms faster)` : '';
      showToast(`AIR switched route: ${reason}${improvement}`, 'info');
    });
  }

  if (api.onAIRStatus) {
    api.onAIRStatus((data) => {
      el.airLabel.textContent = data.message || data.status || 'AIR Active';
      if (data.hotStandby !== undefined) {
        el.airHotStandby.textContent = data.hotStandby;
      }
    });
  }
}

function updateImprovement() {
  if (state.beforePing && state.currentPing) {
    const pct = ((state.beforePing - state.currentPing) / state.beforePing * 100);
    el.improveValue.textContent = `${Math.max(0, pct).toFixed(0)}%`;
  }
}

// ═══════════════════════════════════════════════════
//  PING GRAPH (Canvas)
// ═══════════════════════════════════════════════════
let graphCtx = null;
let graphW = 0;
let graphH = 0;

function initCanvas() {
  const canvas = el.pingGraph;
  if (!canvas) return;

  const resize = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    graphW = rect.width;
    graphH = 140;
    canvas.width = graphW * dpr;
    canvas.height = graphH * dpr;
    canvas.style.width = graphW + 'px';
    canvas.style.height = graphH + 'px';
    graphCtx = canvas.getContext('2d');
    graphCtx.scale(dpr, dpr);
    drawPingGraph();
  };

  resize();
  window.addEventListener('resize', resize);
}

function drawPingGraph() {
  if (!graphCtx) return;
  const ctx = graphCtx;
  const w = graphW;
  const h = graphH;
  const pad = { top: 8, right: 10, bottom: 22, left: 40 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const data = state.pingHistory;
  const maxPoints = 60;

  // Auto-scale Y axis
  let yMax = 100;
  if (data.length > 0) {
    const maxLat = Math.max(...data.map(d => d.latency));
    yMax = Math.max(50, Math.ceil(maxLat / 25) * 25 + 25);
  }

  // Grid lines
  ctx.strokeStyle = 'rgba(26, 37, 64, 0.6)';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (plotH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    // Y label
    const val = Math.round(yMax - (yMax / gridLines) * i);
    ctx.fillStyle = '#4a5c78';
    ctx.font = '10px "JetBrains Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(`${val}`, pad.left - 6, y + 4);
  }

  // X label
  ctx.fillStyle = '#4a5c78';
  ctx.font = '10px "JetBrains Mono"';
  ctx.textAlign = 'center';
  ctx.fillText('60s ago', pad.left + 10, h - 4);
  ctx.fillText('now', w - pad.right - 10, h - 4);

  if (data.length < 2) return;

  // Plot line
  const stepX = plotW / (maxPoints - 1);

  const toX = (i) => pad.left + (maxPoints - data.length + i) * stepX;
  const toY = (lat) => pad.top + plotH - (lat / yMax) * plotH;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  grad.addColorStop(0, 'rgba(0, 229, 199, 0.20)');
  grad.addColorStop(1, 'rgba(0, 229, 199, 0.00)');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0].latency));
  for (let i = 1; i < data.length; i++) {
    const x = toX(i);
    const y = toY(data[i].latency);
    // Smooth curve
    const prevX = toX(i - 1);
    const prevY = toY(data[i - 1].latency);
    const cpX = (prevX + x) / 2;
    ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
  }

  // Fill area
  ctx.lineTo(toX(data.length - 1), pad.top + plotH);
  ctx.lineTo(toX(0), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0].latency));
  for (let i = 1; i < data.length; i++) {
    const x = toX(i);
    const y = toY(data[i].latency);
    const prevX = toX(i - 1);
    const prevY = toY(data[i - 1].latency);
    const cpX = (prevX + x) / 2;
    ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
  }
  ctx.strokeStyle = '#00e5c7';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Current point dot
  if (data.length > 0) {
    const last = data[data.length - 1];
    const lx = toX(data.length - 1);
    const ly = toY(last.latency);

    // Glow
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 199, 0.3)';
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00e5c7';
    ctx.fill();
  }
}

// ═══════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════
function openSettings() {
  el.settingsPanel.classList.add('open');
  el.settingsOverlay.classList.add('open');
}

function closeSettings() {
  el.settingsPanel.classList.remove('open');
  el.settingsOverlay.classList.remove('open');
}

async function loadSettings() {
  try {
    const settings = await api.getSettings();
    if (!settings) return;

    if (settings.autoBoost !== undefined) {
      el.settingAutoBoost.checked = !!settings.autoBoost;
    }
    if (settings.airSensitivity !== undefined) {
      el.settingAIR.value = settings.airSensitivity;
      el.airSensitivityValue.textContent = settings.airSensitivity;
    }
    if (settings.preferredGame) {
      el.settingGame.value = settings.preferredGame;
    }
    if (settings.preferredServer) {
      el.settingServer.value = settings.preferredServer;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

async function saveSetting(key, value) {
  try {
    await api.setSetting(key, value);
  } catch (err) {
    console.error(`Failed to save setting ${key}:`, err);
    showToast('Failed to save setting', 'error');
  }
}

function populateSettingGames() {
  el.settingGame.innerHTML = '<option value="">— None —</option>';
  for (const g of state.games) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    el.settingGame.appendChild(opt);
  }
}

// ═══════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════
const TOAST_ICONS = {
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
};

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="material-icons-round toast-icon">${TOAST_ICONS[type] || 'info'}</span>
    <span class="toast-text">${escHtml(message)}</span>
  `;
  el.toastContainer.appendChild(toast);

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function regionFlag(region) {
  const r = (region || '').toLowerCase();
  if (/hong\s*kong|hk/i.test(r))       return '🇭🇰';
  if (/singapore|sg/i.test(r))          return '🇸🇬';
  if (/japan|jp|tokyo/i.test(r))        return '🇯🇵';
  if (/korea|kr|seoul/i.test(r))        return '🇰🇷';
  if (/taiwan|tw/i.test(r))             return '🇹🇼';
  if (/vietnam|vn/i.test(r))            return '🇻🇳';
  if (/india|in|mumbai/i.test(r))       return '🇮🇳';
  if (/us|united\s*states|america/i.test(r)) return '🇺🇸';
  if (/eu|europe|frankfurt|london/i.test(r)) return '🇪🇺';
  if (/australia|au|sydney/i.test(r))   return '🇦🇺';
  return '🌐';
}
