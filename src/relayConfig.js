'use strict';

// =============================================================================
// relayConfig.js — Game server definitions, relay node topology, and region map
// Optimized for Vietnam → Hong Kong routing (target: 20-30ms from 70-80ms)
// =============================================================================

const GAMES = [
  {
    id: 'valorant',
    name: 'VALORANT',
    publisher: 'Riot Games',
    icon: '🎯',
    servers: [
      { id: 'val-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '43.229.67.1', port: 443 },
      { id: 'val-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '43.229.67.2', port: 443 },
      { id: 'val-sg1', label: 'Singapore', region: 'Singapore', host: '43.229.69.1', port: 443 },
      { id: 'val-jp1', label: 'Tokyo', region: 'Japan', host: '43.229.71.1', port: 443 },
      { id: 'val-tw1', label: 'Taiwan', region: 'Taiwan', host: '43.229.68.1', port: 443 },
    ],
  },
  {
    id: 'league-of-legends',
    name: 'League of Legends',
    publisher: 'Riot Games',
    icon: '⚔️',
    servers: [
      { id: 'lol-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '43.229.67.10', port: 443 },
      { id: 'lol-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '43.229.67.11', port: 443 },
      { id: 'lol-sg1', label: 'Singapore', region: 'Singapore', host: '43.229.69.10', port: 443 },
      { id: 'lol-jp1', label: 'Tokyo', region: 'Japan', host: '43.229.71.10', port: 443 },
      { id: 'lol-tw1', label: 'Taiwan', region: 'Taiwan', host: '43.229.68.10', port: 443 },
    ],
  },
  {
    id: 'apex-legends',
    name: 'Apex Legends',
    publisher: 'EA / Respawn',
    icon: '🔫',
    servers: [
      { id: 'apex-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '159.153.36.1', port: 37015 },
      { id: 'apex-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '159.153.36.2', port: 37015 },
      { id: 'apex-sg1', label: 'Singapore', region: 'Singapore', host: '159.153.37.1', port: 37015 },
      { id: 'apex-jp1', label: 'Tokyo', region: 'Japan', host: '159.153.38.1', port: 37015 },
      { id: 'apex-tw1', label: 'Taiwan', region: 'Taiwan', host: '159.153.39.1', port: 37015 },
    ],
  },
  {
    id: 'pubg',
    name: 'PUBG: BATTLEGROUNDS',
    publisher: 'Krafton',
    icon: '🪖',
    servers: [
      { id: 'pubg-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '52.187.68.1', port: 7777 },
      { id: 'pubg-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '52.187.68.2', port: 7777 },
      { id: 'pubg-sg1', label: 'Singapore', region: 'Singapore', host: '52.187.69.1', port: 7777 },
      { id: 'pubg-jp1', label: 'Tokyo', region: 'Japan', host: '52.187.70.1', port: 7777 },
      { id: 'pubg-kr1', label: 'Korea', region: 'Korea', host: '52.187.71.1', port: 7777 },
    ],
  },
  {
    id: 'dota2',
    name: 'Dota 2',
    publisher: 'Valve',
    icon: '🛡️',
    servers: [
      { id: 'dota-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '103.28.54.1', port: 27015 },
      { id: 'dota-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '103.28.54.2', port: 27015 },
      { id: 'dota-sg1', label: 'Singapore', region: 'Singapore', host: '103.28.55.1', port: 27015 },
      { id: 'dota-jp1', label: 'Tokyo', region: 'Japan', host: '103.28.56.1', port: 27015 },
      { id: 'dota-sea1', label: 'SEA', region: 'Singapore', host: '103.28.57.1', port: 27015 },
    ],
  },
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    publisher: 'Valve',
    icon: '💣',
    servers: [
      { id: 'cs2-hk1', label: 'Hong Kong 1', region: 'Hong Kong', host: '103.28.54.10', port: 27015 },
      { id: 'cs2-hk2', label: 'Hong Kong 2', region: 'Hong Kong', host: '103.28.54.11', port: 27015 },
      { id: 'cs2-sg1', label: 'Singapore', region: 'Singapore', host: '103.28.55.10', port: 27015 },
      { id: 'cs2-jp1', label: 'Tokyo', region: 'Japan', host: '103.28.56.10', port: 27015 },
      { id: 'cs2-sea1', label: 'SEA', region: 'Singapore', host: '103.28.57.10', port: 27015 },
    ],
  },
  {
    id: 'genshin-impact',
    name: 'Genshin Impact',
    publisher: 'HoYoverse',
    icon: '🌟',
    servers: [
      { id: 'gi-hk1', label: 'Hong Kong', region: 'Hong Kong', host: '47.74.47.1', port: 22101 },
      { id: 'gi-sg1', label: 'Singapore', region: 'Singapore', host: '47.74.48.1', port: 22101 },
      { id: 'gi-jp1', label: 'Tokyo', region: 'Japan', host: '47.74.49.1', port: 22101 },
      { id: 'gi-asia1', label: 'Asia', region: 'Hong Kong', host: '47.74.50.1', port: 22101 },
    ],
  },
  {
    id: 'honkai-star-rail',
    name: 'Honkai: Star Rail',
    publisher: 'HoYoverse',
    icon: '🚂',
    servers: [
      { id: 'hsr-hk1', label: 'Hong Kong', region: 'Hong Kong', host: '47.74.51.1', port: 23301 },
      { id: 'hsr-sg1', label: 'Singapore', region: 'Singapore', host: '47.74.52.1', port: 23301 },
      { id: 'hsr-jp1', label: 'Tokyo', region: 'Japan', host: '47.74.53.1', port: 23301 },
      { id: 'hsr-asia1', label: 'Asia', region: 'Hong Kong', host: '47.74.54.1', port: 23301 },
    ],
  },
];

const RELAY_NODES = [
  {
    id: 'hk-direct',
    label: 'Hong Kong Direct',
    region: 'Hong Kong',
    host: '103.152.220.1',
    port: 51820,
    probePort: 443,
    flag: '🇭🇰',
    configPath: null,
  },
  {
    id: 'hk-2',
    label: 'Hong Kong 2',
    region: 'Hong Kong',
    host: '103.152.220.2',
    port: 51820,
    probePort: 443,
    flag: '🇭🇰',
    configPath: null,
  },
  {
    id: 'tw-1',
    label: 'Taiwan 1',
    region: 'Taiwan',
    host: '103.31.196.1',
    port: 51820,
    probePort: 443,
    flag: '🇹🇼',
    configPath: null,
  },
  {
    id: 'sg-1',
    label: 'Singapore 1',
    region: 'Singapore',
    host: '103.253.72.1',
    port: 51820,
    probePort: 443,
    flag: '🇸🇬',
    configPath: null,
  },
  {
    id: 'jp-1',
    label: 'Tokyo 1',
    region: 'Japan',
    host: '103.73.64.1',
    port: 51820,
    probePort: 443,
    flag: '🇯🇵',
    configPath: null,
  },
  {
    id: 'vn-1',
    label: 'Vietnam Gateway',
    region: 'Vietnam',
    host: '103.97.125.1',
    port: 51820,
    probePort: 443,
    flag: '🇻🇳',
    configPath: null,
  },
];

const REGIONS = [
  { id: 'hk', name: 'Hong Kong', flag: '🇭🇰' },
  { id: 'tw', name: 'Taiwan', flag: '🇹🇼' },
  { id: 'sg', name: 'Singapore', flag: '🇸🇬' },
  { id: 'jp', name: 'Japan', flag: '🇯🇵' },
  { id: 'kr', name: 'Korea', flag: '🇰🇷' },
  { id: 'vn', name: 'Vietnam', flag: '🇻🇳' },
];

function getGameServers(gameId) {
  const game = GAMES.find((g) => g.id === gameId);
  return game ? game.servers : [];
}

module.exports = { GAMES, RELAY_NODES, REGIONS, getGameServers };
