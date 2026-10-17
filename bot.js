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
//   DISCORD_AUTHORIZED_USER_ID the Discord user allowed to control it
//   DISCORD_AUTHORIZED_USER_ID_2 (optional) a second account that may also control it

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
// Optional second controller account (e.g. the user's main
// Discord account next to the dedicated control account).
// Both accounts may control the bot, and mention pings go to
// both, so a callout is seen on whichever account is in hand.
const DISCORD_AUTHORIZED_USER_ID_2 = (process.env.DISCORD_AUTHORIZED_USER_ID_2 || '').trim();
const DISCORD_AUTHORIZED_USER_IDS = [DISCORD_AUTHORIZED_USER_ID, DISCORD_AUTHORIZED_USER_ID_2].filter(Boolean);
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
  // One Discord line must become at most one Minecraft chat:
  // collapse runs of whitespace into single spaces.
  return String(content || '').replace(/\s+/g, ' ').trim();
}

// The user often pastes several commands as ONE Discord message
// with line breaks ("dropinv 7\n/shard withdraw 500\n...").
// Each line is its own command/chat, processed in order —
// without this split the whole block used to collapse into one
// garbled chat line and nothing in it worked.
const MAX_BRIDGE_LINES = 10;

function splitBridgeLines(content) {
  return String(content || '')
    .split('\n')
    .map((line) => normalizeDiscordContent(line))
    .filter(Boolean)
    .slice(0, MAX_BRIDGE_LINES);
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
    // An optional rank tag in brackets may sit between the name
    // and the separator ("MOD Name [✦] » text") — this server
    // renders ranked chat exactly like that.
    const m = rest.match(/^\s*(?:\[[^\]]{0,24}\]\s*)?[»>:~-]\s+(\S[\s\S]*)$/) ||
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

// Server (system) lines: the user wants everything the server
// shows the bot to appear in Discord — plugin notices (Vote,
// AuctionHouse, Combat, Teleport, Shards...), command results,
// and even messages sent from the server console. So system
// lines are forwarded raw, minus a small noise/safety list:
// join/leave lines, and anything carrying a /login or /register
// command (AuthMe prompts — and a hard safety rule: a line with
// a login command in it must never be mirrored anywhere).
const SERVER_LINE_NOISE = [
  /joined the game/i,
  /left the game/i,
  /\/(login|register)\b/i,
  // Other players' AFK announcements ("• X is now AFK.") —
  // ambient server events the user does not want mirrored.
  /\bis now AFK\b/i,
  /\bis no longer AFK\b/i,
  // Advancement / goal announcements for other players.
  /\bhas made the advancement\b/i,
  /\bhas reached the goal\b/i,
  /\bhas completed the challenge\b/i,
  /\bhas earned the achievement\b/i,
];

// Death messages ("X was slain by Y", "X was smashed by Z",
// "X died", ...). The user's rule (2026-10-18): who killed
// whom is none of his concern — EXCEPT when the victim is
// the bot itself; that one line comes through.
const DEATH_LINE_PATTERNS = [
  /\bwas slain by\b/i,
  /\bwas (smashed|crushed|obliterated|destroyed|murdered|annihilated|vaporized|fireballed|skewered|pummeled) by\b/i,
  /\bwas killed by\b/i,
  /\bwas shot by\b/i,
  /\bwas blown up\b/i,
  /\bwas impaled\b/i,
  /\bwas squashed\b/i,
  /\btried to swim in lava\b/i,
  /\bhit the ground too hard\b/i,
  /\bfell (out of the world|from a high place)\b/i,
  /\b(drowned|burned to death|went up in flames|starved to death|suffocated|withered away|froze to death|died)\b/i,
];

function isDeathMessage(str) {
  return DEATH_LINE_PATTERNS.some((re) => re.test(str));
}

// Death messages begin with the victim's name, so the bot's
// own death is the line that starts with the bot's username.
function isOwnDeathMessage(str, selfUsername) {
  if (!selfUsername) return false;
  const esc = selfUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}\\b`).test(str);
}

// Categories the user explicitly does NOT want mirrored to
// Discord (confirmed 2026-10-17): Vote, AuctionHouse (AH) and
// Combat plugin lines, in any of their sender shapes
// ("<Vote> ...", "Vote » ...", "[AH] ...").
const EXCLUDED_NOTICE_SENDERS = new Set(['vote', 'ah', 'auctionhouse', 'auction house', 'combat']);

function noticeSenderOf(str) {
  const m = str.match(/^<([^<>]{1,40})>/) ||
    str.match(/^\[([^\[\]]{1,40})\]/) ||
    str.match(/^([A-Za-z][A-Za-z ]{0,30})\s*»/);
  return m ? m[1].trim().toLowerCase() : null;
}

function isExcludedCategoryLine(str) {
  const sender = noticeSenderOf(str);
  return sender !== null && EXCLUDED_NOTICE_SENDERS.has(sender);
}

function shouldForwardRawLine(text, selfUsername) {
  if (!text) return false;
  const str = String(text).trim();
  if (!str) return false;
  if (SERVER_LINE_NOISE.some((re) => re.test(str))) return false;
  if (isExcludedCategoryLine(str)) return false;
  // The server echo of the bot's OWN outgoing whisper
  // ("[me -> Player] hi"): the bridge already knows what it
  // sent, so mirroring the echo back is pure noise — and it
  // used to arrive twice, in two different shapes.
  if (/^\[me\s*->/i.test(str)) return false;
  // Death messages: only the bot's own death comes through.
  if (isDeathMessage(str)) return isOwnDeathMessage(str, selfUsername);
  if (selfUsername) {
    // The bot's own spoken lines never bounce back (loop guard):
    // "<SASUKE_440> ...", "[SASUKE_440] ...", "SASUKE_440 » ...".
    const esc = selfUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^[<\\[\\(]?\\s*${esc}\\b`).test(str)) return false;
  }
  return true;
}

// This server's plugins also deliver their lines as chat-style
// text with an angle-bracket sender: "<Teleport> Teleport
// request sent to MOD X.", "<Shards> Withdrew 500 Shards...",
// "<Combat> You were attacked by X!". The old deployment
// forwarded those to Discord verbatim (the user has screenshots
// from 2026-10-09); on the current protocol they arrive as
// system-position messages instead of 'chat' events, so they
// are recognised and forwarded here. Returns the full line to
// forward, or null. The bot's own bracketed lines are skipped.
function parseAngleBracketNotice(text, selfUsername) {
  if (!text) return null;
  const str = String(text).trim();
  const m = str.match(/^<([^<>]{1,40})>\s+(\S[\s\S]*)$/);
  if (!m) return null;
  if (selfUsername && m[1] === selfUsername) return null;
  // "<me> ..." is the echo of the bot's own outgoing whisper.
  if (m[1].trim().toLowerCase() === 'me') return null;
  if (EXCLUDED_NOTICE_SENDERS.has(m[1].trim().toLowerCase())) return null;
  if (SERVER_LINE_NOISE.some((re) => re.test(str))) return null;
  return str;
}

// Plugin lines reach the bot in two shapes for the SAME
// event: "Shards » Your Balance: ..." and "<Shards> Your
// Balance: ...". Normalising the single-word "»" form into
// the bracket form makes both copies the identical string,
// so the duplicate guard in sendToDiscord keeps exactly one
// — in the "<Name> text" shape the user prefers. Multi-word
// prefixes (ranked player chat, "MOD Name [✦] » ...") are
// left untouched.
function normalizePluginLine(text) {
  const str = String(text).trim();
  const m = str.match(/^([A-Za-z][A-Za-z0-9_]{0,30}) » ([\s\S]*)$/);
  if (!m) return str;
  return `<${m[1]}> ${m[2]}`;
}

// True when a chat text says the bot's name (whole word, any
// case). Used to ping the user in Discord so a message aimed at
// the bot is not missed.
function mentionsBotName(text, selfUsername) {
  if (!text || !selfUsername) return false;
  const esc = selfUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, 'i').test(String(text));
}

// Appends a Discord user mention (the ping) to a forwarded line.
function appendMention(text, userId) {
  return userId ? `${text} <@${userId}>` : text;
}

// Appends pings for every authorized account at once.
function appendMentionsToAll(text, userIds) {
  const ids = (userIds || []).filter(Boolean);
  return ids.length ? `${text} ${ids.map((id) => `<@${id}>`).join(' ')}` : text;
}

function appendAllMentions(text) {
  return appendMentionsToAll(text, DISCORD_AUTHORIZED_USER_IDS);
}

// True when a Discord user id is one of the authorized
// controller accounts (either of them).
function isAuthorizedUser(userId, userIds) {
  return Array.isArray(userIds) && userIds.includes(userId);
}

// Whispers sent TO the bot, in the shapes this server family
// uses: "[Name -> me] text" (Essentials-style) and the vanilla
// "Name whispers to you: text". Returns { username, message }.
function parseWhisperToBot(text, onlineUsernames) {
  if (!text) return null;
  const str = String(text).trim();
  const m = str.match(/^\[([A-Za-z0-9_]{1,16}) -> me\]\s+(\S[\s\S]*)$/) ||
    str.match(/^([A-Za-z0-9_]{1,16}) whispers to you:\s+(\S[\s\S]*)$/i);
  if (!m) return null;
  if (Array.isArray(onlineUsernames) && onlineUsernames.length > 0 && !onlineUsernames.includes(m[1])) return null;
  return { username: m[1], message: m[2].trim() };
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
let discordLastReadyAt = 0; // last time the gateway reported ready
let discordClientCreatedAt = 0; // when the current client was created
let discordWatchdogStarted = false;
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
    // Vote / AH / Combat lines can also surface as pseudo-chat
    // with the plugin name as the "sender" — never forwarded.
    if (EXCLUDED_NOTICE_SENDERS.has(String(username).trim().toLowerCase())) return;
    // If the player said the bot's name, ping the user in
    // Discord so the message is not missed.
    const line = `<${username}> ${message}`;
    void sendToDiscord(mentionsBotName(message, activeBot.username)
      ? appendAllMentions(line)
      : line);
  });

  // Private messages (whispers) to the bot are forwarded like
  // normal chat, always with a ping for the user.
  activeBot.on('whisper', (username, message) => {
    if (!username || username === activeBot.username || !message) return;
    void sendToDiscord(appendAllMentions(`<${username}> ${message}`));
  });

  // Signed player chat (the 1.19+ 'playerChat' event) — same
  // forwarding as 'chat'. If both events fire for one message,
  // the duplicate guard in sendToDiscord keeps it to one copy.
  activeBot.on('playerChat', (data) => {
    if (!data) return;
    const message = data.plainMessage != null ? String(data.plainMessage) : '';
    if (!message) return;
    let username = data.senderName ? String(data.senderName) : null;
    if (!username && data.sender && activeBot.players) {
      const found = Object.values(activeBot.players).find((p) => p && p.uuid === data.sender);
      if (found) username = found.username;
    }
    if (!username || username === activeBot.username) return;
    if (EXCLUDED_NOTICE_SENDERS.has(username.trim().toLowerCase())) return;
    const line = `<${username}> ${message}`;
    void sendToDiscord(mentionsBotName(message, activeBot.username)
      ? appendAllMentions(line)
      : line);
  });

  // Fallback for custom chat formats the 'chat' pattern misses.
  // Only player-chat packets reach this handler (position 'chat');
  // sendToDiscord de-duplicates, so a message the 'chat' event
  // already forwarded is never sent twice.
  activeBot.on('messagestr', (text, position) => {
    // Whisper lines the 'whisper' event may miss (custom chat
    // formats) — forwarded like normal chat, with a ping.
    if (position === 'chat' || position === 'system') {
      const names0 = activeBot.players ? Object.keys(activeBot.players) : [];
      const whisper = parseWhisperToBot(text, names0);
      if (whisper && whisper.username !== activeBot.username) {
        void sendToDiscord(appendAllMentions(`<${whisper.username}> ${whisper.message}`));
        return;
      }
    }
    if (position === 'chat') {
      const names = activeBot.players ? Object.keys(activeBot.players) : [];
      const parsed = parseMessagestrAsPlayerChat(text, names, activeBot.username);
      if (parsed) {
        const line = `<${parsed.username}> ${parsed.message}`;
        void sendToDiscord(mentionsBotName(parsed.message, activeBot.username)
          ? appendAllMentions(line)
          : line);
        return;
      }
      // Plugin lines in "<Teleport> ...", "<Shards> ..." form —
      // the way this server delivered them to the old deployment.
      // (The formatted text matches what the 'chat' event would
      // have sent, so the duplicate guard keeps it to one copy.)
      const notice = parseAngleBracketNotice(text, activeBot.username);
      if (notice) {
        void sendToDiscord(notice);
        return;
      }
      // Unrecognised chat shapes: if the line names the bot,
      // never let it pass silently — forward it raw with the
      // ping, so a message aimed at the bot is not missed.
      const rawChat = String(text).trim();
      if (rawChat && mentionsBotName(rawChat, activeBot.username)) {
        void sendToDiscord(appendAllMentions(rawChat));
      }
      return;
    }
    // System lines: plugin notices (Vote, AuctionHouse, Combat,
    // Teleport, Shards...), command results, console messages —
    // forwarded raw, minus join/leave and AuthMe noise.
    if (position === 'system') {
      if (shouldForwardRawLine(text, activeBot.username)) {
        // One canonical shape per event ("<Shards> ..." rather
        // than "Shards » ...") so the twin copy is recognised
        // as a duplicate. A line naming the bot also carries
        // the ping.
        const rawLine = normalizePluginLine(text);
        void sendToDiscord(mentionsBotName(rawLine, activeBot.username)
          ? appendAllMentions(rawLine)
          : rawLine);
      }
    }
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
  if (!isAuthorizedUser(message.author.id, DISCORD_AUTHORIZED_USER_IDS)) return;

  const lines = splitBridgeLines(message.content);
  if (lines.length === 0) return; // e.g. image-only message

  for (const line of lines) {
    await processBridgeLine(message, line);
  }
}

async function processBridgeLine(message, content) {
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

// If the gateway connection dies and discord.js's own reconnect
// never becomes ready again (seen live: hours of "reconnecting..."
// after one drop, while Discord throttled this host's IP), tear
// the client down and log in fresh instead of waiting forever.
const DISCORD_STUCK_LIMIT_MS = 10 * 60_000; // 10 minutes not-ready

async function restartDiscordClient(reason) {
  log(`Discord: ${reason} — restarting the Discord client for a fresh login...`);
  const old = discordClient;
  discordClient = null;
  discordChannel = null;
  discordReady = false;
  discordLastReadyAt = 0;
  if (old) {
    try { await old.destroy(); } catch { /* already dead */ }
  }
  startDiscord();
}

function startDiscordWatchdog() {
  if (discordWatchdogStarted) return;
  discordWatchdogStarted = true;
  setInterval(() => {
    if (!DISCORD_CONFIGURED || !discordClient || discordReady) return;
    const since = Math.max(discordLastReadyAt, discordClientCreatedAt);
    if (since && Date.now() - since > DISCORD_STUCK_LIMIT_MS) {
      void restartDiscordClient('connection stuck (not ready for over 10 minutes)');
    }
  }, 60_000).unref?.();
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
  discordClientCreatedAt = Date.now();
  startDiscordWatchdog();

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
    discordLastReadyAt = Date.now();
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
  // (The watchdog below steps in when automatic reconnect gets
  // stuck, e.g. the gateway session dies on a throttled host IP
  // and "reconnecting..." loops forever without ever readying.)
  discordClient.on('shardDisconnect', (event, id) => {
    discordReady = false;
    log(`Discord: shard ${id} disconnected (code ${event.code}). Reconnect is automatic.`);
  });
  discordClient.on('shardReconnecting', (id) => log(`Discord: shard ${id} reconnecting...`));
  discordClient.on('shardReady', (id) => {
    discordReady = true;
    discordLastReadyAt = Date.now();
    log(`Discord: shard ${id} ready.`);
  });

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
  splitBridgeLines,
  isPlayerlistMessage,
  parseDropCommand,
  userSlotToWindowSlot,
  nearestPlayerWithin,
  formatPlayerList,
  yawToFace,
  angularDifference,
  isLookingAt,
  parseMessagestrAsPlayerChat,
  shouldForwardRawLine,
  isDeathMessage,
  isOwnDeathMessage,
  parseAngleBracketNotice,
  normalizePluginLine,
  mentionsBotName,
  appendMention,
  appendMentionsToAll,
  isAuthorizedUser,
  parseWhisperToBot,
  getOnlinePlayerNames,
  startHealthServer,
};
