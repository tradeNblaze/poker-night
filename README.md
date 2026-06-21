# Kitchen Table Hold'em — Live

Real Texas Hold'em, played live, with each person on their own phone or laptop.
The server deals every hand and only ever sends each player their own hole cards —
nobody can see anyone else's hand by peeking at a screen or inspecting the browser.

No npm packages needed. No database. Just Node.js.

---

## Option A — Play tonight (fastest, no accounts)

You'll run the game on your own laptop and get a temporary public link to text to
everyone. The link works for as long as your laptop stays on and connected — perfect
for one game night. It's free and needs no sign-up.

**1. Install Node.js** (skip if you already have it): https://nodejs.org — download
the "LTS" version and install it like any app.

**2. Open a terminal in this folder.**
- Mac: right-click the folder → "New Terminal at Folder" (or open Terminal and `cd` into it)
- Windows: open the folder in File Explorer, type `cmd` in the address bar and hit Enter

**3. Start the server:**
```
node server.js
```
You should see: `Kitchen Table Hold'em LIVE server running on port 3000`
Leave this terminal window open for the whole game.

**4. Get a public link.** Open a *second* terminal window in the same folder and run:

- **Mac** (one-time install): `brew install cloudflared` then:
  ```
  cloudflared tunnel --url http://localhost:3000
  ```
- **Windows**: download `cloudflared.exe` from
  https://github.com/cloudflare/cloudflared/releases/latest (grab the `windows-amd64.exe`
  file), then in the terminal:
  ```
  cloudflared.exe tunnel --url http://localhost:3000
  ```

After a few seconds you'll see a box with a URL like
`https://random-words-here.trycloudflare.com` — **that's your live link.** Text it to
everyone playing. They open it on their phone, no app or account needed.

When you're done for the night, close both terminal windows. The link stops working,
which is fine — it was only ever meant to last for tonight.

---

## Option B — A permanent link (deploy once, play anytime)

Use **[Render](https://render.com)** — free web hosting, no credit card, and it doesn't
expire or surprise-bill you like some other free tiers do. The only tradeoff: if
nobody's used the link in 15 minutes, it "naps" and takes ~30-60 seconds to wake up on
the next visit. For a once-in-a-while family game night, that's a non-issue.

**1. Put this folder on GitHub** (Render deploys from a Git repo):
   - Create a free account at https://github.com if you don't have one
   - Click the **+** in the top right → **New repository** → name it anything (e.g.
     `kitchen-table-holdem`) → **Create repository**
   - On the new repo's page, click **uploading an existing file**, then drag in every
     file and folder from this project (keep the `public` folder structure intact)
   - Click **Commit changes**

**2. Deploy it on Render:**
   - Create a free account at https://render.com (sign in with GitHub is easiest)
   - Click **New → Web Service**, pick the repo you just created
   - Leave the defaults — Render auto-detects Node.js. Build command can stay blank;
     start command should be `node server.js` (it's already set in `package.json`)
   - Click **Create Web Service** and wait a minute or two for the first deploy

**3. Get your link:** once it says "Live," your URL is shown right at the top of the
page, something like `https://kitchen-table-holdem.onrender.com`. That's your
permanent link — share it with the family anytime you want to play. Bookmark it.

*(If you don't mind handing over a card and possibly paying a few dollars eventually,
Railway is a faster alternative with a CLI-only deploy that skips GitHub entirely —
`npm install -g @railway/cli`, `railway login`, `railway init`, `railway up` — but its
free trial credit runs out and then either nags you to pay or shuts the app down, which
isn't great for something you want to just stay live indefinitely.)*

---

## How to play

1. Whoever's hosting opens the link and taps **Create a Table** — they get a 4-letter
   room code.
2. Everyone else opens the *same* link, taps **Join a Table**, enters their name and
   that code.
3. In the lobby, add bots if you're short a player, set your starting chips and
   blinds, then **Shuffle Up & Deal**.
4. Each person always sees their own two cards at the bottom of their own screen.
   Action buttons appear there automatically when it's your turn — everyone else
   just watches the table update live.
5. If someone's connection drops mid-hand, their seat waits ~30 seconds for them to
   reconnect before auto-folding them, so the table never gets stuck.

## What's actually inside

- `server.js` — the whole multiplayer server: rooms, turns, reconnection
- `engine.js` / `logic.js` — the poker rules engine (hand evaluation, betting,
  side pots) — this is the same engine from the single-device version, already
  tested against thousands of simulated hands
- `bot-ai.js` — simple bot opponents to fill empty seats
- `ws-server.js` — a small WebSocket server written from scratch (no `ws` package
  needed, so there's nothing to `npm install` — it just runs)
- `public/index.html` — everything players see in their browser
