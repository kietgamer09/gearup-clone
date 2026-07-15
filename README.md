# RoutePilot — Gaming Route Optimizer

> A GearUP Booster clone built from scratch with Electron. Designed for gamers in **Vietnam** connecting to **Hong Kong** servers — but works for any origin/destination.

---

## What It Does

Your ISP picks the cheapest route for your packets, not the fastest. When you play Valorant from Vietnam on Hong Kong servers, your traffic might bounce through Singapore, Tokyo, or even US transit — adding 40-60ms of unnecessary latency.

**RoutePilot** measures every possible path between you and the game server, finds the fastest relay chain, and tunnels your game traffic through it using WireGuard. The result: your packets take the optimal path instead of your ISP's cheapest one.

---

## Features

| Feature | Description |
|---|---|
| **Real TCP Latency Testing** | Measures actual TCP handshake time to each relay and game server — not ICMP, which ISPs deprioritize |
| **Adaptive Intelligent Routing (AIR)** | Continuously monitors all paths and auto-switches to the fastest one if conditions change mid-session |
| **Live Ping Graph** | Real-time visualization of latency, jitter, and packet loss with historical data |
| **Vietnam → HK Optimized** | Pre-configured relay nodes and game servers tuned for the Vietnam–Hong Kong corridor |
| **8 Games Pre-configured** | Valorant, League of Legends, Genshin Impact, PUBG, CS2, Dota 2, Apex Legends, and Honkai: Star Rail |
| **Premium Dark UI** | Glassmorphism design with smooth animations, custom titlebar, and real-time data displays |
| **WireGuard Integration** | Connects through WireGuard tunnels for encrypted, low-overhead packet routing |
| **Session Statistics** | Tracks per-session metrics: avg/min/max ping, jitter, uptime, and route switches |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Launch the app
npm start
```

The app will open with the route testing dashboard. Select Valorant (default), pick your Hong Kong server, and hit **Boost** to begin.

---

## How to Actually Reduce Your Ping (Vietnam → HK)

The app provides the UI and intelligence layer, but to actually reroute traffic you need relay infrastructure. Here's how to set it up for real results.

### Why Your Ping Is High

When you connect from Vietnam to Hong Kong, your ISP (VNPT, Viettel, FPT) often routes traffic through:

```
You (Hanoi/HCMC) → Singapore → Hong Kong
You (Hanoi/HCMC) → US West Coast → Hong Kong
You (Hanoi/HCMC) → Japan → Hong Kong
```

The direct geographic distance is ~1,500km and should yield **15-25ms**. But poor peering agreements between Vietnamese ISPs and HK networks push latency to **70-80ms** or worse.

### The Fix: A Relay VPS

Place a VPS with WireGuard on the direct path. Your traffic goes:

```
You → VPS (Hong Kong) → Game Server
```

Because cloud providers (Vultr, DigitalOcean, Linode) have premium peering with both Vietnamese and HK networks, this path is almost always faster than your ISP's default route.

### Step-by-Step Setup

#### 1. Get a Hong Kong VPS (~$5/month)

Recommended providers:
- **Vultr** — HK datacenter, $5/mo for 1 vCPU / 1GB RAM
- **DigitalOcean** — SGP datacenter (close enough), $4/mo
- **Linode (Akamai)** — Tokyo 2 or Singapore, $5/mo

> Pick whichever has the lowest ping from your location. Most have free trials.

#### 2. Install WireGuard on the VPS

```bash
# Ubuntu 22.04+
sudo apt update && sudo apt install -y wireguard

# Generate keys
wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey

# Enable IP forwarding
echo "net.ipv4.ip_forward = 1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

#### 3. Configure WireGuard

Create `/etc/wireguard/wg0.conf` on the VPS:

```ini
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = <VPS_PRIVATE_KEY>
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
PublicKey = <YOUR_PC_PUBLIC_KEY>
AllowedIPs = 10.66.66.2/32
```

Create a client config for your PC:

```ini
[Interface]
Address = 10.66.66.2/24
PrivateKey = <YOUR_PC_PRIVATE_KEY>
DNS = 1.1.1.1

[Peer]
PublicKey = <VPS_PUBLIC_KEY>
Endpoint = <VPS_IP>:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

#### 4. Start the tunnel

```bash
# On VPS
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0

# On your PC (Windows — use WireGuard GUI or:)
wireguard /installtunnelservice "C:\path\to\wg0.conf"
```

#### 5. Integrate with RoutePilot

Place your `.conf` files in the `relays/` directory:

```
relays/
  hk-vultr.conf
```

Update `src/relayConfig.js` and set `configPath` to point to your conf file:

```js
{
  id: 'hk-custom',
  label: 'Hong Kong (Vultr)',
  region: 'hk',
  host: '<YOUR_VPS_IP>',
  port: 51820,
  configPath: path.join(__dirname, '..', 'relays', 'hk-vultr.conf'),
  flag: '🇭🇰'
}
```

#### Expected Results

| Metric | Before (ISP direct) | After (WireGuard relay) |
|---|---|---|
| Ping to HK | 70-80ms | 20-30ms |
| Jitter | 15-25ms | 2-5ms |
| Packet Loss | 1-3% | <0.1% |
| Route Stability | Variable | Consistent |

---

## Architecture

```
routepilot/
├── main.js                  # Electron main process — IPC, window, AIR engine
├── preload.js               # Context bridge — secure API exposure
├── package.json             # Dependencies and scripts
├── src/
│   ├── relayConfig.js       # Game servers, relay nodes, region definitions
│   ├── routeOptimizer.js    # TCP latency measurement and route ranking
│   ├── airEngine.js         # Adaptive Intelligent Routing engine
│   └── tunnelManager.js     # WireGuard tunnel lifecycle management
├── renderer/
│   ├── index.html           # App shell
│   ├── styles.css           # Glassmorphism dark theme
│   └── app.js               # Frontend logic and UI state
└── relays/                  # WireGuard .conf files (user-provided)
```

---

## How AIR Works

The **Adaptive Intelligent Routing** engine runs as a background loop:

1. **Probe** — Periodically measures latency to all relay nodes and the target game server
2. **Rank** — Scores each path by weighted latency, jitter, and packet loss
3. **Decide** — If a better route is found and the improvement exceeds the sensitivity threshold, it triggers a switch
4. **Hot Standby** — Keeps the top N backup routes pre-measured so switches are instant
5. **Report** — Emits real-time events for the UI to display ping graphs and status updates

The sensitivity threshold (default: 15ms) prevents flapping between routes that are within noise margin.

---

## Legal Notice

This project is an **educational clone** built to understand how game traffic optimization works. It is not affiliated with, endorsed by, or connected to GearUP Booster, Riot Games, or any game publisher.

- Do not use this tool to gain unfair competitive advantages
- Tunneling game traffic may violate some games' Terms of Service — use at your own risk
- WireGuard® is a registered trademark of Jason A. Donenfeld

---

*Built for gamers who refuse to accept their ISP's routing decisions.*
