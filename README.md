# Fortune's Gambit duel server

Runs on Altare at **https://gambit.martinsnelling.com**. Two players share an invite link and play one board of Fortune's Gambit against each other. The server is the referee: it checks every move and rolls every battle, so nobody can cheat by editing the page.

## Files

| File | What it does |
|---|---|
| `server.js` | The web server and live connections: rooms, invite codes, reconnecting, who is allowed to connect |
| `duel.js` | The referee for one duel: turns, legal moves, battles, blessings, wins, resigning, rematches |
| `rules.js` | **An exact copy of the game's `rules.js`.** When you change a rule in the game, copy the new `rules.js` here too |
| `index.html` | A bare 2D test page, so you can play a duel in two browser tabs |
| `tests/` | Automatic checks. Run `npm test` |

## Trying it

1. Open https://gambit.martinsnelling.com and press **Create a duel**.
2. Copy the invite link into a second tab or another device, and open it.
3. Play. Click a piece, then a green dot to move, or a red ring to see the odds and attack.

Each browser tab is its own player, so two tabs on one computer can play each other.

## Rules of a plain duel

- Both sides have the standard army, with no relics and no Momentum.
- The server picks the sides at random.
- All the normal battle rules apply, including the Bishop's Blessing.
- A battle uses the turn, whether it is won or lost.
- **The duel ends** when a king is slain, by checkmate, by resigning, by a draw, or if a player is gone for more than 60 seconds.
- **Rematch** needs both players to ask, and then the sides swap.
- Each duel has its own dice seed, which is shown at the end so the duel can be replayed.

## Draft duels

- `create` can carry `mode`: `'draft'` or `'plain'`. Anything else (including no mode, like the 2D test page) is a plain duel.
- In a draft, the duel's seed deals 3 boons from `DUEL_BOONS` in `rules.js`. Each player sends `{type:'pick', boons:[two of them], id}` once. Moves are refused, and the turn timer waits, until both have picked.
- Each `state` has `mode`, `draft: {offer, picked, picks}` (you only see your own picks until both have chosen) and `momentum` (Battle Fervour streaks).
- The boons act like relics in the battle odds, so the server and both browsers always agree.
- Each `state` also has `summary`: moves, battles and battles won for each side, for the end-of-duel screen.

## Turn timer

- `create` can carry `timer`: 0 (off), 30, 60 or 120 seconds per turn. Anything else means off.
- The clock starts when the second player sits down, and restarts after every move or attack. Each `state` includes `timer` and `turnLeft` (milliseconds left, or null).
- Run out and the turn passes to the other side (recorded as a `timeout` action). Run out 3 turns in a row and you lose. A rematch keeps the timer.

## Watchers and rejoining

- The first two people with a duel code play. Anyone after that joins as a **watcher** (up to 20 per duel): they get every board update and battle, and can send quick reactions, but anything else they send is ignored. Every `state` message includes `watchers`, the number watching.
- A new tab can send `resume: [keys]` (seat keys its device remembers). If one of those seats isn't connected, it gets that seat back; if they're all in use, the server replies `resume-failed` so the tab can join as someone new.

## Messages

- **Browser to server:**
  - `create`
  - `join {room, key}`
  - `move {from, to, id}`
  - `challenge {from, to, id}`
  - `bless {from, to, id}`
  - `resign {id}`
  - `rematch`
  - `ping`
- **Server to browser:**
  - `created`
  - `joined`
  - `state`: the whole board, with legal moves and odds
  - `battle`
  - `error`
  - `pong`

Every action carries a unique `id`. The server ignores an id it has already seen, so a double-tap or a resend after lag can never make two moves.

## Settings (optional, on Altare)

- `PORT` is set by Altare.
- `ALLOWED_ORIGINS`: extra web addresses allowed to connect, comma-separated. These are always allowed:
  - martinsnelling.com (with and without www)
  - gambit.martinsnelling.com
  - localhost
