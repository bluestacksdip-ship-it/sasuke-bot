'use strict';

// Havencraft AFK / greeting bot + Discord bridge — SASUKE_440
//
// Secrets are read ONLY from environment variables (the host's
// environment settings in production — e.g. Render Environment
// variables; originally GitHub Actions Secrets). Nothing secret
// is written in this file,
// and neither the AuthMe login command nor the Discord token is
// ever printed to the logs:
//   MC_LOGIN_CMD               full AuthMe login command
//   DISCORD_TOKEN              Discord bot token
//   DISCORD_CHANNEL_ID         the one Discord channel the bridge uses
//   DISCORD_AUTHORIZED_USER_ID the only Discord user allowed to control it

const http = require('http');
const mineflayer = require('mineflayer');

let Discord = null;
try {
  Discord = require('discord.js');
} catch {
  // discord.js not installed — the Minecraft bot still runs, the
  // Discord bridge simply stays disabled (a warning is logged).
  Discord = null;
}

// ---------------------------------------------------------------- config

const HOST = process.env.MC_HOST || 'mc.havencraft.pro';
const PORT = parseInt(process.env.MC_PORT || '2566', 10);
const USERNAME = process.env.MC_USERNAME || 'SASUKE_440';
// Leave MC_VERSION unset so mineflayer negotiates the version
// with the server automatically. Set it only if the server
// requires one exact version string.
const VERSION = process.env.MC_VERSION || false;
const LOGIN_CMD = (process.env.MC_LOGIN_CMD || '').trim();

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const DISCORD_CHANNEL_ID = (process.env.DISCORD_CHANNEL_ID || '').trim();
const DISCORD_AUTHORIZED_USER_ID = (process.env.DISCORD_AUTHORIZED_USER_ID || '').trim();
const DISCORD_CONFIGURED = Boolean(DISCORD_TOKEN && DISCORD_CHANNEL_ID && DISCORD_AUTHORIZED_USER_ID);

const RECONNECT_AFTER_DISCONNECT_MS = 15_000; // was online, dropped
const RETRY_WHEN_SERVER_DOWN_MS = 120_000; // could not connect at all
const RANDOM_LOOK_EVERY_MS = 30_000;
const DOUBLE_CROUCH_EVERY_MS = 120_000;
const PLAYER_SCAN_EVERY_MS = 1_000;
const GREET_RANGE_BLOCKS = 6;
const GREET_COOLDOWN_MS = 60_000;
const WATCH_GREET_AFTER_MS = 60_000; // still + watching continuously
const STILL_MAX_MOVE_BLOCKS = 0.25; // movement below this = standing still
const LOOK_TOLERANCE_RAD = 0.55; // ~31 degrees counts as "looking at the bot"
const MC_CHAT_MAX_LENGTH = 256; // Minecraft chat/command hard limit
const DISCORD_LOGIN_RETRY_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------- pure helpers
// (exported at the bottom so bot.test.js can verify them)

class RecentKeys {
  constructor(windowMs, maxEntries = 500) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.seen = new Map(); // key -> timestamp
  }

  // Returns true the first time a key is seen inside the window,
  // false for a duplicate. Callers forward only on `true`.
  firstTime(key, now = Date.now()) {
    for (const [k, t] of this.seen) {
      if (now - t > this.windowMs) this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value);
    }
    return true;
  }
}

function normalizeDiscordContent(content) {
  // One Discord message must become at most one Minecraft chat:
  // collapse line breaks / runs of whitespace into single spaces.
  return String(content || '').replace(/\s+/g, ' ').trim();
}

function isPlayerlistMessage(content) {
  return normalizeDiscordContent(content).toLowerCase() === 'playerlist';
}

// The user's own slot numbering for the Dropinv command, chosen
// by the user: counting starts at the BOTTOM-LEFT of the screen
// (the hotbar's leftmost slot is 1) and goes up row by row:
//   user  1-9   = hotbar        (window 36-44)
//   user 10-18  = bag row above hotbar (window 27-35)
//   user 19-27  = next bag row  (window 18-26)
//   user 28-36  = top bag row   (window  9-17)
const USER_ROW_WINDOW_STARTS = [36, 27, 18, 9];

function userSlotToWindowSlot(userSlot) {
  if (!Number.isInteger(userSlot) || userSlot < 1 || userSlot > 36) return null;
  const row = Math.floor((userSlot - 1) / 9); // 0 = hotbar (bottom)
  const col = (userSlot - 1) % 9;
  return USER_ROW_WINDOW_STARTS[row] + col;
}

// Parses the custom Discord command for dropping inventory items.
// There is deliberately NO drop-everything mode (the user said
// they do not want one) — a slot number is always required:
//   "Dropinv 8"    -> { mode: 'slot', userSlot: 8, windowSlot: 43 }
//   "Dropinv"      -> { mode: 'invalid' } (number missing)
//   "Dropinv xyz"  -> { mode: 'invalid' } (starts like the command)
//   anything else  -> null (not a drop command)
function parseDropCommand(content) {
  const text = normalizeDiscordContent(content);
  const mSlot = text.match(/^dropinv\s+(\d{1,2})$/i);
  if (mSlot) {
    const userSlot = parseInt(mSlot[1], 10);
    const windowSlot = userSlotToWindowSlot(userSlot);
    if (windowSlot !== null) return { mode: 'slot', userSlot, windowSlot };
    return { mode: 'invalid' };
  }
  if (/^dropinv(\s|$)/i.test(text)) return { mode: 'invalid' };
  return null;
}

function formatPlayerList(usernames) {
  const names = Array.isArray(usernames) ? usernames : [];
  return `Server ${names.length} online: ${names.join(', ')}`;
}

// Yaw (radians, mineflayer convention) an entity at `fromPos`
// would need in order to face `toPos` horizontally.
function yawToFace(fromPos, toPos) {
  return Math.atan2(-(toPos.x - fromPos.x), -(toPos.z - fromPos.z));
}

function angularDifference(a, b) {
  let diff = (a - b) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff);
}

// Fallback parser for servers whose chat format mineflayer's
// built-in 'chat' pattern does not recognise. It only accepts a
// message when a KNOWN online player's name appears near the
// start of the string, followed by a chat separator — so system
// lines like "Steve joined the game" are never forwarded.
// Returns { username, message } or null.
function parseMessagestrAsPlayerChat(text, onlineUsernames, selfUsername) {
  if (!text || !Array.isArray(onlineUsernames)) return null;
  const str = String(text);
  for (const username of onlineUsernames) {
    if (!username || username === selfUsername) continue;
    const idx = str.indexOf(username);
    if (idx < 0 || idx > 32) continue;
    const before = idx === 0 ? '' : str[idx - 1];
    if (before && /[A-Za-z0-9_]/.test(before)) continue;
    const rest = str.slice(idx + username.length);
    // A real chat separator is required — a bare space is not
    // enough, which is what keeps "Steve joined the game" out.
    const m = rest.match(/^\s*[»>:~-]\s+(\S[\s\S]*)$/) ||
      rest.match(/^>\s+(\S[\s\S]*)$/);
    if (m) return { username, message: m[1].trim() };
  }
  return null;
}

function isLookingAt(entity, targetPos) {
  if (!entity || !entity.position || typeof entity.yaw !== 'number' || !targetPos) return false;
  const needed = yawToFace(entity.position, targetPos);
  return angularDifference(entity.yaw, needed) <= LOOK_TOLERANCE_RAD;
}

// ------------------------------------------------------------ state

let bot = null; // current Minecraft bot instance (null while reconnecting)
let timers = [];
let reconnectTimer = null;
let reconnectScheduled = false;
let crouching = false;
const lastGreetedAt = new Map(); // username -> last greet timestamp
// username -> { inside, anchorPos, stillSince, lookingSince }
const playerWatchState = new Map();

let dropping = false; // one drop operation at a time

let discordClient = null;
let discordChannel = null;
let discordReady = false;
const discordInboundProcessed = new RecentKeys(10 * 60_000, 500); // by message id
const discordOutboundSent = new RecentKeys(3_000, 200); // by exact text

// --------------------------------------------------- Minecraft side

function addTimer(fn, ms) {
  const t = setInterval(fn, ms);
  timers.push(t);
  return t;
}

function clearTimers() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

async function doubleCrouch(activeBot) {
  if (crouching || !activeBot || !activeBot.entity) return;
  crouching = true;
  try {
    for (let i = 0; i < 2; i++) {
      activeBot.setControlState('sneak', true);
      await sleep(350);
      activeBot.setControlState('sneak', false);
      await sleep(250);
    }
  } catch {
    // Bot disconnected mid-crouch — the reconnect handler takes over.
  } finally {
    crouching = false;
    try { activeBot.setControlState('sneak', false); } catch {}
  }
}

function randomLook(activeBot) {
  if (!activeBot.entity) return;
  const yaw = Math.random() * Math.PI * 2 - Math.PI;
  const pitch = Math.random() * 0.8 - 0.4; // -0.4 .. +0.4 rad
  activeBot.look(yaw, pitch, true).catch(() => {});
}

async function lookAndCrouch(activeBot, player) {
  try {
    const height = typeof player.height === 'number' ? player.height : 1.62;
    await activeBot.lookAt(player.position.offset(0, height, 0), true);
  } catch {}
  await doubleCrouch(activeBot);
}

// Preserved behaviour, refined by the current spec:
//  - a player ENTERING the 6-block range is greeted once
//    (look + double-crouch), at most once per minute per player;
//  - a player who then stands still and keeps watching the bot
//    for a full minute is greeted again (look + double-crouch),
//    and that minute starts over after each such greeting.
async function scanNearbyPlayers(activeBot) {
  if (!activeBot.entity || crouching) return;
  const now = Date.now();
  const myPos = activeBot.entity.position;

  const nearby = Object.values(activeBot.entities)
    .filter((e) =>
      e &&
      e.type === 'player' &&
      e.username &&
      e.username !== activeBot.username &&
      e.position &&
      myPos.distanceTo(e.position) <= GREET_RANGE_BLOCKS)
    .sort((a, b) => myPos.distanceTo(a.position) - myPos.distanceTo(b.position));

  const nearbyNames = new Set(nearby.map((p) => p.username));

  // Forget players who left the range, so coming back in counts
  // as a fresh entry (still subject to the 1-minute cooldown).
  for (const name of Array.from(playerWatchState.keys())) {
    if (!nearbyNames.has(name)) playerWatchState.delete(name);
  }

  for (const player of nearby) {
    let state = playerWatchState.get(player.username);

    if (!state) {
      // Fresh entry into range.
      state = {
        anchorPos: player.position.clone(),
        stillSince: now,
        lookingSince: isLookingAt(player, myPos) ? now : null,
      };
      playerWatchState.set(player.username, state);

      const last = lastGreetedAt.get(player.username) || 0;
      if (now - last >= GREET_COOLDOWN_MS) {
        lastGreetedAt.set(player.username, now);
        log(`Player nearby: ${player.username} — greeting`);
        await lookAndCrouch(activeBot, player);
      }
      continue;
    }

    // Track standing still: any real move restarts the anchor.
    if (player.position.distanceTo(state.anchorPos) > STILL_MAX_MOVE_BLOCKS) {
      state.anchorPos = player.position.clone();
      state.stillSince = now;
    }

    // Track watching continuously.
    if (isLookingAt(player, myPos)) {
      if (state.lookingSince === null) state.lookingSince = now;
    } else {
      state.lookingSince = null;
    }

    const watchedFor = state.lookingSince === null
      ? 0
      : Math.min(now - state.stillSince, now - state.lookingSince);

    if (watchedFor >= WATCH_GREET_AFTER_MS) {
      state.stillSince = now;
      state.lookingSince = now;
      lastGreetedAt.set(player.username, now);
      log(`Player watching for 1 minute: ${player.username} — greeting`);
      await lookAndCrouch(activeBot, player);
      break; // one greeting per scan
    }
  }
}

function scheduleReconnect(wasSpawned) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  clearTimers();
  playerWatchState.clear();

  const delay = wasSpawned ? RECONNECT_AFTER_DISCONNECT_MS : RETRY_WHEN_SERVER_DOWN_MS;
  log(`Reconnecting in ${Math.round(delay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectScheduled = false;
    createBot();
  }, delay);
}

// Finds the nearest other player within `range` blocks of
// `myPos` from a list of entities (pure — unit tested).
// Returns the entity, or null when nobody is that close.
function nearestPlayerWithin(myPos, entities, range, selfUsername) {
  if (!myPos || !Array.isArray(entities)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const e of entities) {
    if (!e || e.type !== 'player' || !e.username || e.username === selfUsername || !e.position) continue;
    const d = myPos.distanceTo(e.position);
    if (d <= range && d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

// Drops inventory items for the Dropinv command. Returns a
// human-readable result string for the Discord reply, with the
// real counts/names read from the live inventory — or null when
// the bot is not in the game.
async function dropInventory(dropCmd) {
  if (!bot || !bot.entity || !bot.inventory) return null;
  if (dropping) return 'A drop is already in progress — wait for it to finish.';
  dropping = true;
  try {
    const item = bot.inventory.slots[dropCmd.windowSlot];
    if (!item) return `Slot ${dropCmd.userSlot} is empty — nothing to drop.`;
    const label = `${item.displayName || item.name} x${item.count}`;

    // If a player is standing nearby (within 6 blocks), face
    // them first: a tossed item flies in the direction the bot
    // is looking, so it lands towards that player. Aim a little
    // low (mid-body) so the item does not sail over their head.
    let facedName = null;
    const nearby = nearestPlayerWithin(
      bot.entity.position,
      Object.values(bot.entities || {}),
      GREET_RANGE_BLOCKS,
      bot.username);
    if (nearby) {
      try {
        await bot.lookAt(nearby.position.offset(0, 1.0, 0), true);
        await sleep(250); // let the server register the new facing
        facedName = nearby.username;
      } catch {}
    }

    await bot.tossStack(item);
    log(`Dropinv: dropped user slot ${dropCmd.userSlot} (window ${dropCmd.windowSlot}, ${label})${facedName ? ` towards ${facedName}` : ''}.`);
    return facedName
      ? `Dropped slot ${dropCmd.userSlot}: ${label} (towards ${facedName}).`
      : `Dropped slot ${dropCmd.userSlot}: ${label}.`;
  } finally {
    dropping = false;
  }
}

function getOnlinePlayerNames() {
  if (!bot || !bot.players) return null;
  return Object.keys(bot.players);
}

function createBot() {
  if (!LOGIN_CMD) {
    log('WARNING: MC_LOGIN_CMD is not set. The bot will join but cannot log in with AuthMe.');
  }

  log(`Connecting to ${HOST}:${PORT} as ${USERNAME} (offline mode)...`);
  let spawned = false;
  const activeBot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: 'offline',
    version: VERSION,
    hideErrors: false,
  });
  bot = activeBot;

  // Minecraft chat -> Discord, exact format: "<PlayerName> Message"
  // The bot's own messages are never forwarded. That also breaks
  // the feedback loop: everything the bridge sends into Minecraft
  // is said by the bot account itself, so it can never bounce back.
  activeBot.on('chat', (username, message) => {
    if (!username || username === activeBot.username) return;
    if (!message) return;
    void sendToDiscord(`<${username}> ${message}`);
  });

  // Fallback for custom chat formats the 'chat' pattern misses.
  // Only player-chat packets reach this handler (position 'chat');
  // sendToDiscord de-duplicates, so a message the 'chat' event
  // already forwarded is never sent twice.
  activeBot.on('messagestr', (text, position) => {
    if (position !== 'chat') return;
    const names = activeBot.players ? Object.keys(activeBot.players) : [];
    const parsed = parseMessagestrAsPlayerChat(text, names, activeBot.username);
    if (parsed) void sendToDiscord(`<${parsed.username}> ${parsed.message}`);
  });

  activeBot.once('spawn', async () => {
    spawned = true;
    log('Spawned in server.');

    // AuthMe login a few seconds after spawn, so the server
    // is ready to accept the command.
    await sleep(3_000);
    if (LOGIN_CMD && bot === activeBot) {
      try {
        activeBot.chat(LOGIN_CMD); // value comes from the Secret, never logged
        log('AuthMe login command sent.');
      } catch (err) {
        log('Could not send login command:', err.message);
      }
    }

    addTimer(() => randomLook(activeBot), RANDOM_LOOK_EVERY_MS);
    addTimer(() => { doubleCrouch(activeBot); }, DOUBLE_CROUCH_EVERY_MS);
    addTimer(() => { scanNearbyPlayers(activeBot); }, PLAYER_SCAN_EVERY_MS);
  });

  activeBot.on('kicked', (reason) => {
    log('Kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason));
  });

  activeBot.on('error', (err) => {
    log('Minecraft error:', err && err.message ? err.message : err);
  });

  activeBot.once('end', (reason) => {
    log('Disconnected:', reason || 'connection ended');
    const wasSpawned = spawned;
    if (bot === activeBot) bot = null;
    scheduleReconnect(wasSpawned);
  });
}

// ------------------------------------------------------ Discord side

async function resolveDiscordChannel() {
  if (!discordClient) return null;
  if (discordChannel) return discordChannel;
  try {
    const ch = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch && ch.isTextBased()) discordChannel = ch;
  } catch (err) {
    log('Discord: could not fetch the configured channel:', err.message);
  }
  return discordChannel;
}

async function sendToDiscord(text) {
  if (!DISCORD_CONFIGURED || !discordReady) return false;
  // Duplicate guard: the same text inside a few seconds is sent once.
  if (!discordOutboundSent.firstTime(text)) return false;
  const channel = await resolveDiscordChannel();
  if (!channel) return false;
  try {
    await channel.send(text);
    return true;
  } catch (err) {
    log('Discord: send failed:', err.message);
    discordChannel = null; // re-fetch on the next attempt
    return false;
  }
}

async function handleDiscordMessage(message) {
  // Loop / duplicate protection, in order:
  //  - never react to any bot (including this Discord bot itself)
  //  - never process the same Discord message twice
  //  - only the one configured channel
  //  - only the one authorized user may control the bot
  if (!message || !message.author || message.author.bot) return;
  if (!discordInboundProcessed.firstTime(message.id)) return;
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  if (message.author.id !== DISCORD_AUTHORIZED_USER_ID) return;

  const content = normalizeDiscordContent(message.content);
  if (!content) return; // e.g. image-only message

  // "Playerlist" is answered in Discord and never sent to Minecraft.
  if (isPlayerlistMessage(content)) {
    const names = getOnlinePlayerNames();
    try {
      if (!names) {
        await message.reply('Bot is not connected to Minecraft right now — it reconnects automatically, try again in a moment.');
      } else {
        await message.reply(formatPlayerList(names));
      }
    } catch (err) {
      log('Discord: Playerlist reply failed:', err.message);
    }
    return;
  }

  // "Dropinv" / "Dropinv <slot>" is handled by the bot itself
  // and never sent into Minecraft chat.
  const dropCmd = parseDropCommand(content);
  if (dropCmd) {
    try {
      if (dropCmd.mode === 'invalid') {
        await message.reply('Usage: `Dropinv <number>` drops one slot — a number is required, e.g. `Dropinv 8`. Slots count 1-36 from the bottom-left: hotbar 1-9, then the rows above it 10-18, 19-27, 28-36.');
      } else {
        const result = await dropInventory(dropCmd);
        await message.reply(result === null
          ? 'Bot is not connected to Minecraft right now — it reconnects automatically, try again in a moment.'
          : result);
      }
    } catch (err) {
      log('Discord: Dropinv failed:', err.message);
      try { await message.reply('Dropping failed — the bot may have just disconnected.'); } catch {}
    }
    return;
  }

  if (!bot || !bot.entity) {
    try {
      await message.reply('Bot is not connected to Minecraft right now — it reconnects automatically, try again in a moment.');
    } catch {}
    return;
  }

  if (content.length > MC_CHAT_MAX_LENGTH) {
    try {
      await message.reply(`That is too long for Minecraft chat (max ${MC_CHAT_MAX_LENGTH} characters) — nothing was sent.`);
    } catch {}
    return;
  }

  try {
    // One mechanism covers both cases in Minecraft:
    //  - text starting with "/" is executed by the server as a
    //    command (/rtp, /tp Name, /spawn, /home, /msg Name Hi)
    //  - anything else ("Hi") is spoken as normal chat.
    // The content itself is never logged: it could be a command
    // carrying something private.
    bot.chat(content);
    log(`Discord -> Minecraft: forwarded one ${content.startsWith('/') ? 'command' : 'chat message'} (${content.length} chars).`);
    try { await message.react('✅'); } catch {} // ack is optional
  } catch (err) {
    log('Discord -> Minecraft: send failed:', err.message);
    try {
      await message.reply('Could not send that to Minecraft — the bot may have just disconnected.');
    } catch {}
  }
}

async function loginDiscord() {
  if (!discordClient) return;
  // Length only — the token value itself is never logged. A real
  // bot token is ~70 characters; a much shorter/longer value in
  // the log means the wrong thing was pasted into the secret.
  log(`Discord: attempting login (token length ${DISCORD_TOKEN.length})...`);
  let settled = false;
  const watchdog = setTimeout(() => {
    if (!settled) {
      log('Discord: login still pending after 45s — the connection to Discord may be blocked or very slow from this host.');
    }
  }, 45_000);
  watchdog.unref?.();
  try {
    await discordClient.login(DISCORD_TOKEN); // token from Secret, never logged
    settled = true;
    clearTimeout(watchdog);
    log('Discord: login accepted, waiting for the gateway ready event...');
  } catch (err) {
    settled = true;
    clearTimeout(watchdog);
    // Most likely an invalid token or a network problem.
    // Keep the Minecraft bot alive and try Discord again later.
    log('Discord: login failed, will retry:', err.message);
    setTimeout(() => { void loginDiscord(); }, DISCORD_LOGIN_RETRY_MS).unref?.();
  }
}

function startDiscord() {
  if (!Discord) {
    log('Discord: discord.js is not installed — bridge disabled, Minecraft bot continues.');
    return;
  }
  if (!DISCORD_CONFIGURED) {
    const missing = [
      !DISCORD_TOKEN && 'DISCORD_TOKEN',
      !DISCORD_CHANNEL_ID && 'DISCORD_CHANNEL_ID',
      !DISCORD_AUTHORIZED_USER_ID && 'DISCORD_AUTHORIZED_USER_ID',
    ].filter(Boolean);
    log(`Discord: bridge disabled — missing secret(s): ${missing.join(', ')}. Minecraft bot continues.`);
    return;
  }

  discordClient = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.MessageContent, // privileged, enable in the Developer Portal
    ],
  });

  // Events.ClientReady resolves to the correct event name for
  // the installed discord.js version ('clientReady' in current v14).
  discordClient.once(Discord.Events.ClientReady, async () => {
    discordReady = true;
    log(`Discord: logged in as ${discordClient.user.tag}. Bridge channel resolving...`);
    await resolveDiscordChannel();
    log(discordChannel ? 'Discord: bridge ready.' : 'Discord: bridge ready, channel will be retried on first use.');
  });

  discordClient.on('messageCreate', (message) => {
    void handleDiscordMessage(message);
  });

  discordClient.on('error', (err) => log('Discord client error:', err.message));
  discordClient.on('shardError', (err, id) => log(`Discord: shard ${id} error:`, err.message));
  discordClient.on('warn', (info) => log('Discord warning:', String(info)));
  // discord.js reconnects shards automatically; we only observe.
  discordClient.on('shardDisconnect', (event, id) => log(`Discord: shard ${id} disconnected (code ${event.code}). Reconnect is automatic.`));
  discordClient.on('shardReconnecting', (id) => log(`Discord: shard ${id} reconnecting...`));
  discordClient.on('shardReady', (id) => { discordReady = true; log(`Discord: shard ${id} ready.`); });

  // One-line connectivity probe, so a silent login hang can be
  // told apart from a bad token: discord.com's gateway endpoint
  // needs no auth and the result reveals nothing secret.
  void (async () => {
    try {
      const res = await fetch('https://discord.com/api/v10/gateway', {
        signal: AbortSignal.timeout(10_000),
      });
      log(`Discord: API reachable (HTTP ${res.status}).`);
    } catch (err) {
      log('Discord: API NOT reachable from this host:', err.message);
    }
  })();

  void loginDiscord();
}

// ------------------------------------------------------------- main

// Tiny health-check web server. Hosts like Render's free Web
// Service plan expect the app to listen on a web port (the PORT
// environment variable); without it the service is treated as
// broken, and with it an uptime pinger can keep the service
// awake. It serves one plain line and exposes no bot controls
// and no secrets. Returns the server (used by tests).
function startHealthServer(port) {
  const listenPort = port === undefined
    ? parseInt(process.env.PORT || '10000', 10)
    : port;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SASUKE_440 bot is running.\n');
  });
  server.on('error', (err) => log('Health server error:', err.message));
  server.listen(listenPort, () => {
    log(`Health server listening on port ${listenPort}.`);
  });
  return server;
}

function main() {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  startHealthServer();
  createBot();
  startDiscord();
}

if (require.main === module) {
  main();
}

module.exports = {
  RecentKeys,
  normalizeDiscordContent,
  isPlayerlistMessage,
  parseDropCommand,
  userSlotToWindowSlot,
  nearestPlayerWithin,
  formatPlayerList,
  yawToFace,
  angularDifference,
  isLookingAt,
  parseMessagestrAsPlayerChat,
  getOnlinePlayerNames,
  startHealthServer,
};
