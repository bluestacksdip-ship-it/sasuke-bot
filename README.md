# sasuke-bot

Minecraft AFK / greeting bot for the Havencraft server, with a Discord bridge.

- **Server:** `mc.havencraft.pro:2566`
- **Bot username:** `SASUKE_440`
- **Mode:** Java, offline (non-premium), AuthMe — the account is already registered, the bot only logs in
- **Hosting:** Render (free Web Service). The repo only stores the code — GitHub Actions is NOT used (the previous account was suspended for 24/7 Actions hosting).

## Features

### In Minecraft (unchanged, plus one addition)
1. Logs in with AuthMe automatically a few seconds after joining. The full login command comes from the `MC_LOGIN_CMD` repository Secret — it is never in the code.
2. Double-crouches (sneak) every 2 minutes.
3. When a player comes within 6 blocks, it looks at them and double-crouches to greet them — at most once per minute for the same player.
4. **New:** if that player then stands still and keeps watching the bot for a full minute, it looks at them and double-crouches again.
5. Looks in a random direction every 30 seconds (anti-AFK).
6. Reconnects 15 seconds after a disconnect. If the server is down / unreachable, it retries every 2 minutes.

### Discord bridge (new)
In **one designated Discord channel**, and **only for the authorized Discord user**:

- A normal message like `Hi` is spoken by the bot in Minecraft chat.
- A message starting with `/` is sent as a Minecraft command, e.g. `/rtp`, `/tp PlayerName`, `/spawn`, `/home`, `/msg PlayerName Hello`.
- Sending `Playerlist` replies in Discord with the real live list, e.g. `Server 10 online: Player1, Player2, ...` — names/count are read from the server at that moment, never hardcoded.
- Sending `Dropinv <number>` (e.g. `Dropinv 8`) drops only that one slot, and replies with what was dropped. Slot numbers use the owner's counting, 1–36 starting at the **bottom-left** of the screen: hotbar **1–9** (left to right), then the bag rows above it **10–18**, **19–27**, and the top row **28–36**. The code converts these to Minecraft window slots internally. There is intentionally **no drop-everything command** (the owner did not want one): sending bare `Dropinv` with no number drops nothing and gets a usage reply. Before dropping, if another player is standing within 6 blocks, the bot first **turns to face the nearest such player** (aiming at mid-body), so the tossed item flies towards them; the Discord reply then says who it was dropped towards. With nobody nearby it drops the item in front of itself as usual. Like `Playerlist`, it is handled by the bot itself and never sent into Minecraft chat.
- Every in-game player chat message is forwarded to Discord in the exact format `<PlayerName> Message`, e.g. `<NAPA_EXTEND> ayyyhay`.

Safety built in: messages from any Discord bot are ignored, each Discord message is processed once, the bot's own Minecraft messages are never forwarded back to Discord (no feedback loops / duplicates), other Discord users in the channel cannot control the bot, messages longer than Minecraft's 256-character limit are rejected with an explanation, and neither the login command nor the Discord token is ever written to the logs. If Discord is down or the token is wrong, the Minecraft bot keeps running and Discord login is retried automatically. The bridge is disabled (Minecraft-only) until all three Discord secrets exist.

---

## Discord setup — do this once

### A. Create the Discord application and bot
1. Go to the Discord Developer Portal: https://discord.com/developers/applications
2. Click **New Application** (top right), name it e.g. `SASUKE_440` / `Havencraft Bot`, and **Create**.
3. In the left menu open **Bot**, then click **Reset Token** → **Yes, do it!**
   Copy the token that appears — this is `DISCORD_TOKEN`. It is shown only when reset/created.
   ⚠️ Treat it like a password: never paste it in chat, in a file, or in a screenshot. In the next section you paste it only into a GitHub Secret.
4. On the same **Bot** page, under **Privileged Gateway Intents**, turn **ON**:
   - **MESSAGE CONTENT INTENT** ← required, or the bot cannot read what you type
   - The other two privileged intents (Presence, Server Members) are **not** needed — leave them off.
5. Also on the **Bot** page, under **Bot Permissions**, the bot needs no special server-wide powers. Leave these off.

### B. Invite the bot to your Discord server
1. In the left menu open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick **bot**.
3. Under **Bot Permissions**, tick only:
   - **View Channel**
   - **Send Messages**
   - **Read Message History**
   - **Add Reactions** (only used for the ✅ acknowledgement)
   
   The Permissions number shown should be **68672**.
4. Copy the generated URL at the bottom, open it in your browser, choose your server, and **Authorize**.
   (Manual form of the same URL: `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=68672&scope=bot` — replace `YOUR_APPLICATION_ID` with the **Application ID** from the **General Information** page.)
5. Open your server in Discord — the bot should now appear in the member list. Discord bots show as offline until the program actually runs, that is normal.
6. Make sure the channel you want to use lets the bot in: channel **Permissions** → the bot/its role needs **View Channel** and **Send Messages** there too. A private channel the bot cannot see will not work.

### C. Get the two IDs
1. In the Discord app: **Settings (gear) → Advanced → Developer Mode: ON**.
2. **Channel ID:** right-click the designated channel's name → **Copy Channel ID**.
3. **Your user ID:** right-click your own name/avatar → **Copy User ID**.

### D. Deploy on Render (free)
1. Put these files in a GitHub repo (code storage only — do NOT add any
   `.github/workflows` file; nothing should run on GitHub).
2. On [render.com](https://render.com): sign up (Google/email is fine),
   then **New → Web Service** and point it at the repo (or paste the
   public repo URL).
   - Build command: `npm install`
   - Start command: `node bot.js`
   - Plan: **Free**
3. In the service's **Environment** tab, add the 4 variables (values are
   entered by the owner in the Render dashboard only — never in chat,
   never in any file):

   | Variable | Value |
   |---|---|
   | `MC_LOGIN_CMD` | the full AuthMe login command (same as the old GitHub Secret) |
   | `DISCORD_TOKEN` | the bot token from step A3 (reset it in the Developer Portal if needed) |
   | `DISCORD_CHANNEL_ID` | the channel ID from step C2 |
   | `DISCORD_AUTHORIZED_USER_ID` | your user ID from step C3 |

4. Deploy. In the Render log you should see: `Health server listening...`
   → `Spawned in server.` → `AuthMe login command sent.` →
   `Discord: logged in as ...` → `Discord: bridge ready.`
5. Free services sleep after 15 minutes without web traffic — keep it
   awake with a free uptime pinger (e.g. UptimeRobot) hitting the
   service's `onrender.com` URL every 5 minutes.
6. Test from the designated Discord channel, as yourself:
   - send `Hi` → the bot says `Hi` in Minecraft
   - send `/spawn` → the bot runs the command
   - send `Playerlist` → Discord reply: `Server N online: ...`

---

## Files in this repo

- `bot.js` — the bot + bridge (includes a tiny health-check web server for Render)
- `package.json` — dependencies: `mineflayer`, `discord.js`
- `bot.test.js` — automated tests for the bridge helpers (run locally with `npm test`)
- `README.md` — this file
- `render.yaml` — Render service definition (free Web Service); env values are NOT in it

## Run locally (optional, for testing)

```bash
npm install
MC_LOGIN_CMD='/login <your-password>' \
DISCORD_TOKEN='<token>' \
DISCORD_CHANNEL_ID='<channel-id>' \
DISCORD_AUTHORIZED_USER_ID='<your-user-id>' \
node bot.js
```

Do not put real values in any file — only in environment variables / the host's environment settings.
