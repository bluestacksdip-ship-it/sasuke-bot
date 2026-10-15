'use strict';

// Automated tests for the pure helpers in bot.js.
// Run with: npm test   (uses Node's built-in test runner)
// These tests need no network, no Minecraft server and no
// Discord token — importing bot.js does not start the bots.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
  startHealthServer,
} = require('./bot.js');

test('formatPlayerList uses the real names and count, in the required shape', () => {
  assert.equal(formatPlayerList(['Player1', 'Player2']), 'Server 2 online: Player1, Player2');
  assert.equal(formatPlayerList(['SASUKE_440']), 'Server 1 online: SASUKE_440');
  assert.equal(formatPlayerList([]), 'Server 0 online: ');
});

test('isPlayerlistMessage matches only the word Playerlist', () => {
  assert.equal(isPlayerlistMessage('Playerlist'), true);
  assert.equal(isPlayerlistMessage('  playerlist  '), true);
  assert.equal(isPlayerlistMessage('PLAYERLIST'), true);
  assert.equal(isPlayerlistMessage('Playerlist please'), false);
  assert.equal(isPlayerlistMessage('/playerlist'), false);
  assert.equal(isPlayerlistMessage('Hi'), false);
});

test('normalizeDiscordContent collapses newlines so one Discord message = one MC chat', () => {
  assert.equal(normalizeDiscordContent('Hi\nthere\r\nfriend'), 'Hi there friend');
  assert.equal(normalizeDiscordContent('  spaced   out  '), 'spaced out');
  assert.equal(normalizeDiscordContent(''), '');
  assert.equal(normalizeDiscordContent(null), '');
});

test('RecentKeys lets a key through once, then blocks duplicates inside the window', () => {
  const keys = new RecentKeys(3_000);
  assert.equal(keys.firstTime('abc', 1_000), true);
  assert.equal(keys.firstTime('abc', 2_000), false); // duplicate
  assert.equal(keys.firstTime('xyz', 2_000), true); // different key
  assert.equal(keys.firstTime('abc', 5_001), true); // window passed
});

test('yawToFace + isLookingAt: facing the bot counts, facing away does not', () => {
  const playerPos = { x: 0, y: 64, z: 0 };
  const botPos = { x: 3, y: 64, z: -4 };
  const facingBot = { position: playerPos, yaw: yawToFace(playerPos, botPos) };
  assert.equal(isLookingAt(facingBot, botPos), true);
  const facingAway = { position: playerPos, yaw: yawToFace(playerPos, botPos) + Math.PI };
  assert.equal(isLookingAt(facingAway, botPos), false);
  assert.equal(isLookingAt({ position: playerPos }, botPos), false); // no yaw known
});

test('angularDifference wraps around at 2*pi', () => {
  assert.ok(angularDifference(0.1, Math.PI * 2 - 0.1) < 0.21);
  assert.ok(Math.abs(angularDifference(0, Math.PI) - Math.PI) < 1e-9);
});

test('parseMessagestrAsPlayerChat accepts real chat formats', () => {
  const online = ['NAPA_EXTEND', 'Steve', 'SASUKE_440'];
  assert.deepEqual(
    parseMessagestrAsPlayerChat('<NAPA_EXTEND> ayyyhay', online, 'SASUKE_440'),
    { username: 'NAPA_EXTEND', message: 'ayyyhay' });
  assert.deepEqual(
    parseMessagestrAsPlayerChat('Steve: hello there', online, 'SASUKE_440'),
    { username: 'Steve', message: 'hello there' });
  assert.deepEqual(
    parseMessagestrAsPlayerChat('[VIP] Steve » ranked hello', online, 'SASUKE_440'),
    { username: 'Steve', message: 'ranked hello' });
});

test('userSlotToWindowSlot counts 1-36 from the bottom-left, going up', () => {
  // User's inventory photo: hotbar sword = 1, ender pearl = 8,
  // top-left ice = 28, top-right arrows = 36.
  assert.equal(userSlotToWindowSlot(1), 36); // hotbar left -> window 36
  assert.equal(userSlotToWindowSlot(8), 43); // ender pearl
  assert.equal(userSlotToWindowSlot(9), 44); // hotbar right
  assert.equal(userSlotToWindowSlot(10), 27); // row above hotbar, left
  assert.equal(userSlotToWindowSlot(18), 35);
  assert.equal(userSlotToWindowSlot(19), 18);
  assert.equal(userSlotToWindowSlot(28), 9); // top-left ice
  assert.equal(userSlotToWindowSlot(36), 17); // top-right
  assert.equal(userSlotToWindowSlot(0), null);
  assert.equal(userSlotToWindowSlot(37), null);
});

test('parseDropCommand: a slot number is required — bare Dropinv drops nothing', () => {
  assert.deepEqual(parseDropCommand('Dropinv'), { mode: 'invalid' });
  assert.deepEqual(parseDropCommand('  DROPINV '), { mode: 'invalid' });
});

test('parseDropCommand: with a user slot number it drops that one slot', () => {
  assert.deepEqual(parseDropCommand('Dropinv 1'), { mode: 'slot', userSlot: 1, windowSlot: 36 });
  assert.deepEqual(parseDropCommand('Dropinv 8'), { mode: 'slot', userSlot: 8, windowSlot: 43 });
  assert.deepEqual(parseDropCommand('dropinv 28'), { mode: 'slot', userSlot: 28, windowSlot: 9 });
  assert.deepEqual(parseDropCommand('Dropinv 36'), { mode: 'slot', userSlot: 36, windowSlot: 17 });
});

test('parseDropCommand: out-of-range slots and bad arguments are invalid, other text is not a drop command', () => {
  assert.deepEqual(parseDropCommand('Dropinv 0'), { mode: 'invalid' });
  assert.deepEqual(parseDropCommand('Dropinv 37'), { mode: 'invalid' });
  assert.deepEqual(parseDropCommand('Dropinv 45'), { mode: 'invalid' });
  assert.deepEqual(parseDropCommand('Dropinv abc'), { mode: 'invalid' });
  assert.deepEqual(parseDropCommand('Dropinv 8 please'), { mode: 'invalid' });
  assert.equal(parseDropCommand('Dropinventory please'), null);
  assert.equal(parseDropCommand('Hi'), null);
  assert.equal(parseDropCommand('Playerlist'), null);
});

test('nearestPlayerWithin picks the closest other player in range, nobody else', () => {
  const pos = (x, z) => ({
    x, y: 64, z,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.z - other.z); },
  });
  const me = pos(0, 0);
  const entities = [
    { type: 'player', username: 'SASUKE_440', position: pos(0, 0) }, // the bot itself
    { type: 'player', username: 'FarPlayer', position: pos(20, 0) }, // out of range
    { type: 'player', username: 'NearPlayer', position: pos(3, 0) },
    { type: 'player', username: 'NearerPlayer', position: pos(1, 1) },
    { type: 'mob', username: 'Zombie', position: pos(1, 0) }, // not a player
  ];
  assert.equal(nearestPlayerWithin(me, entities, 6, 'SASUKE_440').username, 'NearerPlayer');
  assert.equal(nearestPlayerWithin(me, entities.slice(0, 2), 6, 'SASUKE_440'), null);
  assert.equal(nearestPlayerWithin(me, [], 6, 'SASUKE_440'), null);
  assert.equal(nearestPlayerWithin(null, entities, 6, 'SASUKE_440'), null);
});

test('parseMessagestrAsPlayerChat rejects system lines, strangers and the bot itself', () => {
  const online = ['Steve', 'SASUKE_440'];
  assert.equal(parseMessagestrAsPlayerChat('Steve joined the game', online, 'SASUKE_440'), null);
  assert.equal(parseMessagestrAsPlayerChat('Welcome to Havencraft!', online, 'SASUKE_440'), null);
  assert.equal(parseMessagestrAsPlayerChat('<Stranger> hi', online, 'SASUKE_440'), null);
  assert.equal(parseMessagestrAsPlayerChat('<SASUKE_440> my own words', online, 'SASUKE_440'), null);
});

test('startHealthServer answers 200 on its port (Render web-service check)', async () => {
  const server = startHealthServer(0); // 0 = any free port
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /SASUKE_440 bot is running/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
