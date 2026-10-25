# frp-game · A self-hosted web board-game platform for small groups

> For **small groups of friends** — dorms, classes, clubs, or a boring lecture.
> Run one Node process on a Windows PC, send a link, and everyone plays in the browser.
> No client downloads, no third-party game accounts, no data leaving your machine.

- One platform account for every game (friends, rooms, invites, avatars, presence).
- 10 games: 3 original mini-games + 7 stitched open-source projects
  (Sanguosha / Werewolf / Dou Dizhu / Monopoly / Guangdong Mahjong / Horizon Racing / AI Town).
- Mobile friendly: five landscape games have a rotate shell; every game has an optional
  fullscreen button (hidden on desktop).
- **Zero third-party runtime dependencies**: Node's built-ins + one SQLite file.

> ⚠️ This project is for **learning and playing with friends only. Commercial use is not
> permitted.** Upstream projects keep their own licenses (see below); GPL-3.0 parts must
> remain GPL-3.0 when redistributed.

---

## Games

| Game | Path | Players | Notes |
| --- | --- | --- | --- |
| 🎴 Noname (Sanguosha) | `/noname/` | 2–10 | Upstream client hosted as-is; identity/role/guozhan modes, online play |
| 🐺 Werewolf | `/werewolf/` | 4–18 | Host assigns roles, text chat, replay after the game |
| 🃏 Dou Dizhu | `/ddz/` | 3 | Bid → rob → play; the table is an upstream Godot web export |
| 🎲 Monopoly | `/games/monopoly/` | 1–6 | Upstream 3D board, 5 public maps, online relay |
| 🀄 Lianhua Mahjong | `/mahjong/` | 2–4 | Four-player Guangdong mahjong; single-player vs AI too |
| 🏎️ Horizon Racing | `/games/horizon/` | 2–8 | Open-world coastal 3D racing; real car-to-car collision, touch controls |
| 🏘️ AI Town | `/ai-town/` | 1–4 | AI villagers live their day in a 2D town; host opens their own save, friends join the same map with their own avatars |
| 💣 Cannon Goblin | `/games/cannon-goblin/` | 1–2 | Asymmetric board: cannon captures at range, goblins block |
| 🔫 Shell Gambit | `/games/shell-gambit/` | 1–4 | Devil's roulette: shotgun, 7 items, nerve and luck |
| ⚔️ BladeSteed | `/games/blade-steed/` | 2–4 | Wuxia rock-paper-scissors: win the throw to act |

The home page supports search, player-count filtering, and an A–Z index. Game cards open in a
**new tab**, so the lobby stays open.

## Why

Joining a small online game normally means: download a client, create an account, add friends,
find a room. For a 20-minute game between classes that is too much. A web platform means:

- **No install** — send a link; it works on phones and laptops.
- **One identity** — the same account and avatar in every game.
- **Your own server** — data stays on your PC; nobody can shut the service down.
- **Hackable** — rules, UI and new games are all in this repository.

## Deploy on your own PC

Full, AI-friendly instructions: **[`DEPLOY.md`](DEPLOY.md)**. Quick version:

1. Install **Node.js ≥ 24** (needs `node:sqlite`).
2. Clone or unzip this repository.
3. Run:

   ```powershell
   cd E:\frp-game
   npm start
   ```

   No `npm install` is required (zero runtime dependencies).
4. Open <http://127.0.0.1:7891/>, register, play.
5. To let friends connect from the internet, create a **TCP tunnel** to `127.0.0.1:7891`
   (SakuraFrp is recommended) and enable **automatic HTTPS** on the tunnel.
   Do not add TLS to the Node server itself — the tunnel terminates it.

Optional:

- **Mahjong**: install Python 3.11+ and create `games/mahjong/backend/.venv`
  (commands in `DEPLOY.md`). Without it the mahjong page returns 503; other games work.
- **Noname**: `node tools/noname-update.mjs` downloads/builds the ~1.2 GB upstream.
  Without it `/noname/` is unavailable; other games work.
- Dou Dizhu / Monopoly / Werewolf shipped prebuilt — no frontend build needed.
- **AI Town**: the frontend is prebuilt. The Rust `bin/` and the ~505 MB model are
  **not in git**; copy them together with `data/ai-town/models/model.gguf`, or follow
  `DEPLOY.md` to rebuild Rust and download the model. Inference runs on the server
  (Vulkan `llama-server`), never on the phone. ✅ The host and every guest now get
  their own avatar and can descend together; each avatar shows its platform avatar
  (small dot) and name above it. Only the host changes world settings (start/pause,
  weather, inviting villagers); guests are transient and are never written to the host's save.

## Upstream projects and licenses

| Game | Upstream | License | What this repo does |
| --- | --- | --- | --- |
| Noname (Sanguosha) | [libnoname/noname](https://github.com/libnoname/noname) | **GPL-3.0** | Hosts upstream as-is; adds platform login/avatar bridge, mobile shell, relay |
| Werewolf | [hanluolin/wolfcha-custom](https://github.com/hanluolin/wolfcha-custom) | **MIT** (UI) | Only the UI is reused; rules/rooms/accounts/replay are rewritten here |
| Dou Dizhu | [blmz/GODOT-DouDiZhu](https://github.com/blmz/GODOT-DouDiZhu) | **No license declared upstream** | Godot table exported to web; rules/state/online are rewritten here |
| AI Town | [mewamew/my_ai_town](https://github.com/mewamew/my_ai_town) | **PolyForm Noncommercial 1.0.0** | Rust world kernel/manager + TS frontend copied in; platform accounts/invites/rooms, per-account saves, multi-avatar multiplayer, mobile layout, server-side built-in model |
| Monopoly | [FatPaper-1874/mine-monopoly](https://github.com/FatPaper-1874/mine-monopoly) | **GPL-3.0** | Whole web client hosted; WebSocket relay; platform identity injection |
| Lianhua Mahjong | [BestGuo2020/lianhuaguangdongmahjong](https://github.com/BestGuo2020/lianhuaguangdongmahjong) + [backend](https://github.com/BestGuo2020/lianhua-mahjong-backend) | **MIT** | Whole project hosted; Node reverse proxy; platform identity/invites |
| Horizon Racing | [Liyang1145/horizon-racing](https://github.com/Liyang1145/horizon-racing) | **MIT** | Whole 3D world/physics hosted; platform rooms/invites + `/horizon-relay`; start/finish gantries + touch shell |

The three original mini-games (Cannon Goblin / Shell Gambit / BladeSteed)
are MIT-licensed together with the rest of this repository. Horizon's 3D world comes from
upstream (MIT); the platform wiring lives here. **Commercial use is prohibited.**

## Privacy

The published repository does **not** contain:

- `data/` — user database, password hashes, sessions, logs, uploaded avatars;
- `frpc/**/*.local.ini` — tunnel keys, real ports, tunnel IDs;
- real public URLs, visitor IPs, tunnel node details;
- `games/noname-web/` — the ~1.2 GB upstream source/build tree;
- any `.env`, certificate or private key.

All of those are in `.gitignore`. Placeholders such as `<your public address>` are used in docs.

## Development

```powershell
npm test              # 156 Node integration tests (one optional real-model test is skipped), ~19 s
npm run test:browser  # real Chrome end-to-end (platform shell / rooms / games / fullscreen / horizon)
npm run test:ai-town  # AI Town (real manager/host/WS + layout, mock LLM)
npm run test:horizon  # 5 server/relay tests + real-Chrome two-player race
npm run test:mahjong  # needs Python .venv
npm run test:ddz      # Godot table
npm run test:monopoly
npm run test:werewolf
node tools/check-noname.mjs                    # noname hosting checks
node tools/check-tunnel.mjs <public-url> --ws 30  # read-only tunnel probe
```

## Docs

| Topic | File |
| --- | --- |
| Deployment (AI-oriented) | [`DEPLOY.md`](DEPLOY.md) |
| Current state / next steps | [`docs/NEXT.md`](docs/NEXT.md) |
| Architecture and protocols | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Design decisions (D1–D47) | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| Per-game notes | [`docs/GAMES.md`](docs/GAMES.md) |
| Tunnel troubleshooting | [`docs/TUNNEL.md`](docs/TUNNEL.md) |
| Contributor/AI conventions | [`AGENTS.md`](AGENTS.md) |

## License

Original code: **MIT** (see [`LICENSE`](LICENSE)). Upstream projects remain under their own
licenses. **Commercial use is not permitted.**
