'use strict';

const fs = require('node:fs');
const puppeteer = require('puppeteer');

// Prefer the installed Google Chrome on macOS: it is a native arm64 build,
// while the Chrome for Testing that Puppeteer downloads matches Node's arch
// (x64 Node on Apple Silicon would run Chrome through Rosetta, which breaks
// or slows WebRTC).
const MACOS_SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return undefined; // Puppeteer honors the env var itself
  if (process.platform === 'darwin' && fs.existsSync(MACOS_SYSTEM_CHROME)) return MACOS_SYSTEM_CHROME;
  return undefined; // fall back to the bundled Chrome for Testing
}

/**
 * This function is serialized and executed inside headless Chrome.
 * It must be fully self-contained: no references to Node-scope variables.
 * It installs window.__join / window.__speak / window.__leave / window.__audioLevel.
 *
 * lib-jitsi-meet is loaded from the target deployment itself
 * (https://<domain>/libs/lib-jitsi-meet.min.js), so the client version
 * always matches the server.
 */
function installPageAPI(cfg) {
  const emit = (type, data) => window.__botEvent(type, data === undefined || data === null ? null : String(data));

  let audioCtx = null;
  let audioDest = null;
  let connection = null;
  let room = null;
  let localTrack = null;
  let knocking = false;

  window.__join = () => {
    JitsiMeetJS.setLogLevel(cfg.debug ? JitsiMeetJS.logLevels.DEBUG : JitsiMeetJS.logLevels.ERROR);
    JitsiMeetJS.init({});

    // The bot's "microphone": a WebAudio destination. It stays silent
    // until we play a synthesized AudioBuffer into it.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    audioDest = audioCtx.createMediaStreamDestination();

    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.audio) {
        return Promise.resolve(audioDest.stream);
      }
      return Promise.reject(new Error('AudioBot supports audio only'));
    };

    const options = {
      hosts: {
        domain: cfg.domain,
        muc: cfg.muc,
        // Anonymous guest domain (e.g. "guest.meet.jit.si"). lib-jitsi-meet
        // connects through it automatically when no credentials are supplied.
        ...(cfg.anonymousDomain ? { anonymousdomain: cfg.anonymousDomain } : {}),
      },
      serviceUrl: `wss://${cfg.domain}/xmpp-websocket?room=${cfg.room}`,
      clientNode: 'http://jitsi.org/jitsimeet',
    };

    connection = new JitsiMeetJS.JitsiConnection(null, cfg.token || null, options);
    const connEv = JitsiMeetJS.events.connection;

    connection.addEventListener(connEv.CONNECTION_ESTABLISHED, () => {
      emit('connectionEstablished');

      room = connection.initJitsiConference(cfg.room, {});
      const confEv = JitsiMeetJS.events.conference;

      room.on(confEv.CONFERENCE_JOINED, async () => {
        emit('conferenceJoined');
        try {
          const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
          localTrack = tracks[0];
          await room.addTrack(localTrack);
          emit('trackAdded');
        } catch (e) {
          emit('error', (e && e.message) || e);
        }
      });
      room.on(confEv.USER_JOINED, (id, user) => emit('userJoined', (user && user.getDisplayName && user.getDisplayName()) || id));
      room.on(confEv.USER_LEFT, (id, user) => emit('userLeft', (user && user.getDisplayName && user.getDisplayName()) || id));
      room.on(confEv.CONFERENCE_FAILED, async (err) => {
        const errStr = String(err);
        // Members-only room (or meet.jit.si's waiting-for-moderator lobby):
        // knock and wait — lib-jitsi-meet joins the main room automatically
        // once a moderator approves (INVITE_MESSAGE_RECEIVED -> mainRoom.join()).
        if (errStr === 'conference.connectionError.membersOnly' && !knocking) {
          knocking = true;
          emit('knocking');
          try {
            await room.joinLobby(cfg.name);
            emit('waitingInLobby');
          } catch (e) {
            emit('conferenceFailed', `${errStr} (failed to join the lobby: ${(e && e.message) || e})`);
          }
          return;
        }
        emit('conferenceFailed', errStr);
      });
      room.on(confEv.CONFERENCE_ERROR, (err) => emit('conferenceError', err));

      if (cfg.debug) {
        for (const evtName of Object.values(confEv)) {
          if (typeof evtName === 'string') {
            room.on(evtName, (...args) => emit(`confEvent:${evtName}`, args.map((a) => String(a)).join(',').slice(0, 200)));
          }
        }
      }

      room.setDisplayName(cfg.name);
      room.join();
    });
    connection.addEventListener(connEv.CONNECTION_FAILED, (err) => emit('connectionFailed', err));
    connection.addEventListener(connEv.CONNECTION_DISCONNECTED, (msg) => emit('connectionDisconnected', msg));

    connection.connect();
  };

  // Plays a base64-encoded MP3 through the fake microphone and resolves
  // when playback has finished.
  window.__speak = async (b64) => {
    if (!audioCtx || !audioDest) {
      throw new Error('Bot has not joined a conference yet');
    }
    if (audioCtx.state !== 'running') {
      await audioCtx.resume();
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
    // Measure the peak level of what goes into the published track (debugging aid).
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    const samples = new Float32Array(analyser.fftSize);
    window.__lastPeak = 0;
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (v > window.__lastPeak) window.__lastPeak = v;
      }
    }, 100);
    await new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(analyser);
      analyser.connect(audioDest);
      src.onended = resolve;
      src.start();
    });
    clearInterval(meter);
  };

  window.__leave = async () => {
    try { if (localTrack) await localTrack.dispose(); } catch (_) { /* ignore */ }
    try { if (room) await room.leave(); } catch (_) { /* ignore */ }
    try { if (connection) connection.disconnect(); } catch (_) { /* ignore */ }
  };

  window.__audioLevel = () => {
    try {
      return localTrack ? localTrack.getAudioLevel() : -1;
    } catch (_) {
      return -1;
    }
  };
}

class JitsiTTSBot {
  /**
   * @param {object} config
   * @param {string} config.domain   e.g. "meet.jit.si" or your self-hosted deployment
   * @param {string} config.room     conference room name
   * @param {string} [config.muc]    MUC domain, defaults to "conference.<domain>"
   * @param {string} [config.anonymousDomain] guest domain for anonymous access,
   *        e.g. "guest.meet.jit.si" (required for meet.jit.si)
   * @param {string} [config.name]   display name in the conference
   * @param {string} [config.token]  JWT for deployments with authentication
   * @param {boolean} [config.headful] show the browser window (debugging)
   * @param {function} [config.onEvent] called with (type, data) for every bot event
   */
  constructor(config) {
    if (!config.domain || !config.room) {
      throw new Error('JitsiTTSBot requires "domain" and "room"');
    }
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
    this.config = {
      name: 'TTS Bot',
      token: null,
      headful: false,
      ...clean,
    };
    if (!this.config.muc) {
      this.config.muc = `conference.${this.config.domain}`;
    }
    // XMPP MUC node names are lowercase; lib-jitsi-meet throws on anything else.
    this.config.room = this.config.room.toLowerCase();
    this.browser = null;
    this.page = null;
    this.waiters = new Map();
  }

  _waitFor(event, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: setTimeout(() => {
          this.waiters.delete(event);
          reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for "${event}"`));
        }, timeoutMs),
      };
      waiter.resolve = (data) => { clearTimeout(waiter.timer); resolve(data); };
      waiter.reject = (err) => { clearTimeout(waiter.timer); reject(err); };
      this.waiters.set(event, waiter);
    });
  }

  /** Suspends the timeout of a pending waiter (e.g. while parked in the lobby). */
  _clearWaiterTimeout(event) {
    const waiter = this.waiters.get(event);
    if (waiter) {
      clearTimeout(waiter.timer);
    }
  }

  _handleEvent(type, data) {
    if (typeof this.config.onEvent === 'function') {
      try {
        this.config.onEvent(type, data);
      } catch (_) { /* listener errors must not break the bot */ }
    }
    switch (type) {
      case 'connectionEstablished': console.log('[bot] XMPP connection established'); break;
      case 'conferenceJoined': console.log('[bot] Joined the conference'); break;
      case 'trackAdded': console.log('[bot] Audio track published'); break;
      case 'userJoined': console.log(`[bot] Participant joined: ${data}`); break;
      case 'userLeft': console.log(`[bot] Participant left: ${data}`); break;
      case 'knocking': console.log('[bot] Room requires moderator approval — knocking...'); this._clearWaiterTimeout('trackAdded'); break;
      case 'waitingInLobby': console.log('[bot] Waiting in the lobby. Admit the bot in the meeting UI, or open the room first as moderator (Ctrl+C to abort).'); break;
      case 'connectionDisconnected': console.log(`[bot] Connection disconnected: ${data || ''}`); break;
      case 'connectionFailed': console.error(`[bot] Connection failed: ${data || ''}`); break;
      case 'conferenceFailed': {
        const hints = {
          'conference.authenticationRequired': 'the room is waiting for an authenticated moderator — open it in your browser first and sign in, then re-run the bot',
          'conference.connectionError.membersOnly': 'the room requires a moderator and the bot could not join the lobby',
          'conference.connectionError.accessDenied': 'a moderator denied the bot access to the room',
        };
        console.error(`[bot] Conference failed: ${data || ''}${hints[data] ? ` (${hints[data]})` : ''}`);
        break;
      }
      case 'conferenceError': console.error(`[bot] Conference error: ${data || ''}`); break;
      default: console.error(`[bot] ${type}: ${data || ''}`);
    }

    const waiter = this.waiters.get(type);
    if (waiter) {
      this.waiters.delete(type);
      waiter.resolve(data);
    }
    if (type === 'connectionFailed' || type === 'conferenceFailed' || type === 'error') {
      for (const [, w] of this.waiters) {
        w.reject(new Error(`${type}: ${data || 'unknown error'}`));
      }
      this.waiters.clear();
    }
  }

  async start() {
    const cfg = this.config;
    this.browser = await puppeteer.launch({
      headless: !cfg.headful,
      executablePath: resolveExecutablePath(),
      timeout: 120000,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-dev-shm-usage',
      ],
    });
    this.page = await this.browser.newPage();
    this.page.on('pageerror', (err) => console.error('[page error]', err.message));
    if (cfg.debug) {
      this.page.on('console', (msg) => console.log('[page]', msg.text().slice(0, 300)));
    }

    await this.page.exposeFunction('__botEvent', (type, data) => this._handleEvent(type, data));

    await this.page.goto(`https://${cfg.domain}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.addScriptTag({ url: `https://${cfg.domain}/libs/lib-jitsi-meet.min.js` });

    await this.page.evaluate(installPageAPI, {
      domain: cfg.domain,
      muc: cfg.muc,
      anonymousDomain: cfg.anonymousDomain,
      room: cfg.room,
      name: cfg.name,
      token: cfg.token,
    });

    const ready = this._waitFor('trackAdded', 60000);
    await this.page.evaluate(() => window.__join());
    await ready;
  }

  /** Plays an MP3 buffer into the conference; resolves when playback ends. */
  async speak(mp3Buffer) {
    await this.page.evaluate((b64) => window.__speak(b64), mp3Buffer.toString('base64'));
  }

  /** Current mic level of the published track (0..1), -1 if unavailable. */
  async getAudioLevel() {
    return this.page.evaluate(() => window.__audioLevel());
  }

  /** Peak sample amplitude of the last speak() call, measured at the track source. */
  async getLastPeak() {
    return this.page.evaluate(() => (typeof window.__lastPeak === 'number' ? window.__lastPeak : -1));
  }

  async stop() {
    try {
      if (this.page) await this.page.evaluate(() => window.__leave());
    } catch (_) { /* page may already be gone */ }
    try {
      if (this.browser) await this.browser.close();
    } catch (_) { /* ignore */ }
  }
}

module.exports = { JitsiTTSBot, resolveExecutablePath };
