'use strict';

require('dotenv').config({ quiet: true });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { synthesizeSpeech, voiceForText, DEFAULT_VOICE, RUSSIAN_VOICE } = require('./tts');
const { JitsiTTSBot } = require('./bot');
const { TelemostBot } = require('./telemost');

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
  service: null, // 'jitsi' | 'telemost'
  roomUrl: null, // link to the room shown in the UI
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
      // A dead browser (Telemost) is final; a Jitsi XMPP disconnect may be a
      // transient ICE restart that lib-jitsi-meet recovers from by itself.
      if (session.bot && session.bot.dead) {
        session.state = 'error';
        session.error = `Connection lost: ${data || 'browser closed'}`;
      } else if (session.state !== 'error') {
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

/** Telemost input: a link to telemost.yandex.ru, a /j/<id> path, or a bare numeric room id. */
function isTelemostRoom(input) {
  const s = String(input).trim();
  return /telemost\.yandex\./i.test(s) || /^(\/?j\/)?\d{8,}$/.test(s);
}

function makeBot(room, name) {
  const common = {
    name: name || process.env.BOT_NAME || 'SImplicity',
    headful: process.env.HEADFUL === '1',
    debug: process.env.DEBUG === '1',
    onEvent: mapEvent,
  };
  if (isTelemostRoom(room)) {
    const bot = new TelemostBot({ ...common, room });
    return { bot, displayRoom: bot.url.replace(/^https?:\/\//, ''), roomUrl: bot.url, service: 'telemost' };
  }
  const bot = new JitsiTTSBot({
    ...common,
    domain: DOMAIN,
    room,
    muc: process.env.JITSI_MUC,
    anonymousDomain: process.env.JITSI_ANONYMOUS_DOMAIN
      || (DOMAIN === 'meet.jit.si' ? 'guest.meet.jit.si' : undefined),
    token: process.env.JITSI_TOKEN,
  });
  return {
    bot,
    displayRoom: bot.config.room,
    roomUrl: `https://${DOMAIN}/${bot.config.room}`,
    service: 'jitsi',
  };
}

async function connect(room, name) {
  // Set the state synchronously (before any await) so the 202 response to
  // /api/connect already reports "connecting".
  session.state = 'connecting';
  session.room = String(room).trim().toLowerCase();
  session.service = null;
  session.roomUrl = null;
  session.error = null;
  await disconnect(false);
  const { bot, displayRoom, roomUrl, service } = makeBot(room, name);
  session.bot = bot;
  session.room = displayRoom;
  session.roomUrl = roomUrl;
  session.service = service;
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

async function disconnect(resetState = true) {
  const bot = session.bot;
  session.bot = null;
  if (resetState) {
    session.room = null;
    session.service = null;
    session.roomUrl = null;
    session.state = 'disconnected';
    session.error = null;
  }
  if (bot) {
    try { await bot.stop(); } catch (_) { /* ignore */ }
  }
}

// Synthesizes the audio, then queues playback so utterances never overlap.
// Resolves after synthesis: playback of long texts can take a while, and an
// HTTP request held open that long is killed by proxies (e.g. Cloudflare).
async function speak(text) {
  const bot = session.bot;
  if (!bot || session.state !== 'connected') {
    throw new Error('Not connected to a room');
  }
  const audio = await synthesizeSpeech(text, voiceForText(text, VOICE, VOICE_RU));
  session.speakQueue = session.speakQueue.then(() => bot.speak(audio));
  session.speakQueue.catch((err) => {
    console.error('[server] playback failed:', err.message);
    // If the bot's browser died, the session is over — say so in the UI.
    if (session.bot === bot && (bot.dead || /Target closed|browser is gone/i.test(err.message))) {
      session.state = 'error';
      session.error = `Playback failed: ${err.message}. Please reconnect.`;
    }
  });
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
    service: session.service,
    roomUrl: session.roomUrl,
    error: session.error,
    domain: DOMAIN,
    defaultRoom: process.env.JITSI_ROOM || null,
    defaultName: process.env.BOT_NAME || 'SImplicity',
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
      const { room, name } = JSON.parse(await readBody(req) || '{}');
      if (!room || !String(room).trim()) {
        sendJson(res, 400, { error: 'Room name is required' });
        return;
      }
      // Join in the background and answer immediately: joining takes tens of
      // seconds, and proxies kill HTTP requests held open that long. The UI
      // polls /api/state for progress and errors.
      connect(String(room), name && String(name).trim()).catch((err) => console.error('[server] connect failed:', err.message));
      sendJson(res, 202, statePayload());
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
