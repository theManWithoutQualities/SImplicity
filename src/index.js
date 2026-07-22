'use strict';

require('dotenv').config({ quiet: true });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { synthesizeSpeech, voiceForText, DEFAULT_VOICE, RUSSIAN_VOICE } = require('./tts');
const { JitsiTTSBot } = require('./bot');

const PORT = Number(process.env.PORT || 3000);
const DOMAIN = process.env.JITSI_DOMAIN || 'meet.jit.si';
const VOICE = process.env.TTS_VOICE || DEFAULT_VOICE;
const VOICE_RU = process.env.TTS_VOICE_RU || RUSSIAN_VOICE;
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

// Session state shown by the UI indicator. One conference at a time:
// disconnected -> connecting -> connected; "lobby" while waiting for a
// moderator to admit the bot, "error" on failure.
const session = {
  bot: null,
  room: null,
  state: 'disconnected',
  error: null,
  speakQueue: Promise.resolve(),
};

function mapEvent(type, data) {
  switch (type) {
    case 'connectionEstablished':
    case 'conferenceJoined':
      session.state = 'connecting';
      break;
    case 'trackAdded':
      session.state = 'connected';
      session.error = null;
      break;
    case 'knocking':
    case 'waitingInLobby':
      session.state = 'lobby';
      break;
    case 'connectionFailed':
    case 'conferenceFailed':
      session.state = 'error';
      session.error = String(data || 'unknown error');
      break;
    case 'connectionDisconnected':
      // May be a transient ICE restart; lib-jitsi-meet reconnects by itself.
      if (session.state !== 'error') {
        session.state = session.bot ? 'connecting' : 'disconnected';
      }
      break;
    case 'error':
      session.error = String(data || 'unknown error');
      break;
    default:
      break;
  }
}

async function connect(room) {
  await disconnect();
  const bot = new JitsiTTSBot({
    domain: DOMAIN,
    room,
    muc: process.env.JITSI_MUC,
    anonymousDomain: process.env.JITSI_ANONYMOUS_DOMAIN
      || (DOMAIN === 'meet.jit.si' ? 'guest.meet.jit.si' : undefined),
    name: process.env.BOT_NAME || 'SImplicity',
    token: process.env.JITSI_TOKEN,
    headful: process.env.HEADFUL === '1',
    debug: process.env.DEBUG === '1',
    onEvent: mapEvent,
  });
  session.bot = bot;
  session.room = bot.config.room;
  session.state = 'connecting';
  session.error = null;
  try {
    await bot.start();
  } catch (err) {
    try { await bot.stop(); } catch (_) { /* ignore */ }
    if (session.bot === bot) {
      session.bot = null;
      session.state = 'error';
      session.error = err.message;
    }
    throw err;
  }
}

async function disconnect() {
  const bot = session.bot;
  session.bot = null;
  session.room = null;
  session.state = 'disconnected';
  session.error = null;
  if (bot) {
    try { await bot.stop(); } catch (_) { /* ignore */ }
  }
}

// Serializes speak requests so two utterances never overlap in the room.
function speak(text) {
  const bot = session.bot;
  if (!bot || session.state !== 'connected') {
    return Promise.reject(new Error('Not connected to a room'));
  }
  session.speakQueue = session.speakQueue.then(async () => {
    const audio = await synthesizeSpeech(text, voiceForText(text, VOICE, VOICE_RU));
    await bot.speak(audio);
  });
  return session.speakQueue;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function statePayload() {
  return {
    state: session.state,
    room: session.room,
    error: session.error,
    domain: DOMAIN,
    defaultRoom: process.env.JITSI_ROOM || null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(INDEX_HTML).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, statePayload());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      const { room } = JSON.parse(await readBody(req) || '{}');
      if (!room || !String(room).trim()) {
        sendJson(res, 400, { error: 'Room name is required' });
        return;
      }
      await connect(String(room));
      sendJson(res, 200, statePayload());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/disconnect') {
      await disconnect();
      sendJson(res, 200, statePayload());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/speak') {
      const { text } = JSON.parse(await readBody(req) || '{}');
      if (!text || !String(text).trim()) {
        sendJson(res, 400, { error: 'Text is required' });
        return;
      }
      await speak(String(text).trim());
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, err.message === 'Not connected to a room' ? 409 : 500, { error: err.message });
  }
});

const shutdown = async () => {
  await disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`SImplicity is running at http://localhost:${PORT} (Jitsi deployment: ${DOMAIN})`);
});
