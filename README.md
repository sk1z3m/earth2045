# Earth: 2045 — Stage 1 (single-player core)

A turn-based browser nation builder running on Cloudflare's free plan.
Stage 1 covers one nation: turns, economy, exploring, building, training units, tax and demolishing.
Attacks, alliances and the rest come in later stages (see the design doc).

## What's in this folder

| File | What it does |
| --- | --- |
| `src/game.js` | All game rules and numbers. Change balance here. |
| `src/index.js` | The Cloudflare Worker: the API the page talks to, saving to the database, and the AI schedule. |
| `src/bots.js` | The AI nations: their names, play styles and decision-making. |
| `src/auth.js` | Accounts: password hashing, sign-up rules and sign-in limits. |
| `src/admin.js` | The admin API (admin accounts only). |
| `src/http.js` | Small shared helpers for API responses. |
| `public/admin.html` | The admin page. |
| `public/index.html` | The game page players see. |
| `schema.sql` | Creates the database tables. |
| `wrangler.toml` | Cloudflare settings. |
| `test/` | Automatic checks for the rules, the AI nations and accounts. |

## 1. One-time setup on your computer

1. Install **Node.js** (the "LTS" version) from nodejs.org.
2. Open a terminal in this folder and run:

   ```
   npm install
   ```

   This downloads Wrangler, Cloudflare's tool for running and publishing Workers.

## 2. Play it locally

```
npm run db:init:local
npm run dev
```

Open the address it prints (usually http://localhost:8787) and found a nation.
Press `Ctrl+C` in the terminal to stop. Your local game data is kept in a hidden `.wrangler` folder.

To check the rules still work after you change numbers:

```
npm test
```

## 3. Put it online (free)

The online database is already set up in your Cloudflare account, and its ID is in `wrangler.toml`.
You only need to publish the code:

```
npx wrangler login
npm run deploy
```

Wrangler prints your game's address, something like `https://earth2045.<your-name>.workers.dev`.
To publish changes later, run `npm run deploy` again.

## How turns work

Players earn 1 turn every 15 minutes, up to 240. Nothing runs on a timer: when a player loads the page,
the server works out how many turns have built up since last time. Every turn spent runs one cycle of the
economy for that player only (taxes in, food and oil used, people move in, construction moves forward).

## Rules in this build (starting values to tune)

- Start: 250 acres (100 built), 20,000 cash, 5,000 food, 1,000 oil, 3,000 people, 100 turns.
- Buildings take 1 turn to order and finish 8 turns later. Units take 1 turn to order and arrive 4 turns later.
- Exploring: 1 turn per batch; acres per batch and the price per acre change with your size.
- Tax: 10–70%, no turn cost. Demolishing returns 25% of the cost, no turn cost.

## Attacks

**Ground assaults** (Attack tab, or the Attack link in the rankings) send infantry and tanks against the
target's whole defence for 2 turns. You win if your offence, after a random ±5% swing, beats their defence.
Winning takes about 7% of their land, scaled by how much you won by (up to 1.5×), their size compared with
yours, and how often they've already been hit in the last 24 hours. The land arrives 8 turns later with 30%
of its buildings. Winners lose 7% of the units sent and losers 14%; defenders lose 4% when beaten, 2% when
they hold. Each attack uses 8% readiness, which comes back at 1% a turn.

New human players can't be attacked for 72 hours or 200 turns, whichever ends first (attacking ends it early);
the rankings show a **Shield** tag. Nations under 40% of your size can't be attacked. AI nations are never
shielded. All the numbers live in the `WAR` block in `src/game.js`.

## AI nations

Ten computer-run nations play alongside you and are marked **AI** in the rankings. Every 30 minutes
Cloudflare wakes them up (a "Cron Trigger" set in `wrangler.toml`) and each spends up to 4 of the turns
it has earned, using the same actions you do. They are created automatically the first time this runs.

Each has a play style (Builder, Warlord, Turtle, Farmer or Scientist) and a skill level; both are set in the
`ROSTER` list in `src/bots.js`. Add a line there to add another AI nation.

When running locally, `npm run dev` does not fire the schedule by itself. Run
`npx wrangler dev --test-scheduled`, then visit `http://localhost:8787/__scheduled` to wake the AI nations.

## Accounts

Players sign up with a nation name, a username and a password (at least 8 characters), and can then sign in
from any device. Passwords are stored only as salted PBKDF2 hashes. Five wrong passwords in a row lock the
account for 15 minutes. Sessions last 30 days; **Sign out** ends the one on that device.

There's no email yet, so there's no password reset. Email sign-in and recovery need a domain you control
(a `workers.dev` address can't send mail), so they can come once the game has its own domain.

Nations founded before accounts existed are kept: the first time that browser opens the game, it offers
to create an account and attach the old nation to it.

## Admin

Admin accounts see an **Admin** link at the bottom of the game, which opens `/admin.html`. There you can:
see player counts and activity, search every nation and open its full details and action history,
rename nations, unlock or suspend accounts (suspending asks for your password again), give or take turns,
cash, food and oil for testing, run the AI nations immediately, and publish an announcement banner.

Every admin request is checked on the server; anyone without the flag just gets "Not found". Every admin
action goes in the audit log with your username. There is no way to become an admin from the game itself:
the flag is set directly in the database:

```
npx wrangler d1 execute earth2045 --remote --command "UPDATE users SET is_admin = 1 WHERE username = 'NAME'"
```

## Known limits of stage 1

- Spying and ground assaults work; air strikes, raids, sabotage, market, research spending and governments are still to come.
- No email verification or rate limiting yet, so it's for testing with friends, not a public launch.
- Rankings show the top 25 nations by land.
