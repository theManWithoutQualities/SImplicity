'use strict';

const puppeteer = require('puppeteer');
const { resolveExecutablePath } = require('./bot');

const TELEMOST_ORIGIN = 'https://telemost.yandex.ru';

/**
 * Telemost rooms live at https://telemost.yandex.ru/j/<id>. Accepts a full
 * link, a /j/<id> path, or a bare numeric id; returns the canonical URL.
 */
function roomUrlFrom(input) {
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s)) return s;
  const m = s.match(/(?:j\/)?(\d{8,})/);
  if (!m) throw new Error('Cannot extract a Telemost room id from the input');
  return `${TELEMOST_ORIGIN}/j/${m[1]}`;
}

/**
 * Serialized into the page via evaluateOnNewDocument, before any site script
 * runs. Replaces the microphone with a WebAudio destination that stays silent
 * until window.__ttsSpeak() plays a synthesized MP3 into it. Must be fully
 * self-contained: no references to Node-scope variables.
 */
function installFakeMic() {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const audioDest = audioCtx.createMediaStreamDestination();

  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => {
    if (constraints && constraints.audio) {
      if (audioCtx.state !== 'running') {
        audioCtx.resume().catch(() => {});
      }
      return Promise.resolve(audioDest.stream);
    }
    // Video (if ever requested): the fake device from
    // --use-fake-device-for-media-stream handles it.
    return origGetUserMedia(constraints);
  };

  // Plays a base64-encoded MP3 through the fake microphone; resolves when
  // playback has finished.
  window.__ttsSpeak = async (b64) => {
    if (audioCtx.state !== 'running') {
      await audioCtx.resume();
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
    await new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioDest);
      src.onended = resolve;
      src.start();
    });
  };
}

/**
 * Runs inside the page; inspects the current UI state.
 */
function probePage() {
  const vis = (el) => {
    if (!el.offsetParent) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const bodyText = document.body ? document.body.innerText : '';

  if (/Такой встречи не существует/i.test(bodyText)) return { status: 'noSuchRoom' };
  if (/passport\.yandex\./.test(location.href)) return { status: 'loginWall' };

  // In-conference: control bar with mic / leave buttons is present.
  const controls = [...document.querySelectorAll('button')].filter(vis);
  const inConference = controls.some((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`;
    return /микрофон|покинуть|завершить|microphone|leave|hang ?up/i.test(label);
  });
  if (inConference) return { status: 'inConference' };

  // Pre-join screen: a visible name input and/or a join button.
  const nameInput = [...document.querySelectorAll('input')]
    .find((i) => vis(i) && (!i.type || i.type === 'text'));
  const joinButton = controls.find((b) => /войти|подключиться|присоединиться|продолжить|join|continue/i.test(b.innerText || ''));
  if (joinButton) {
    return {
      status: 'preJoin',
      hasNameInput: Boolean(nameInput),
      nameValue: nameInput ? nameInput.value : null,
    };
  }
  return { status: 'loading', text: bodyText.replace(/\s+/g, ' ').slice(0, 120) };
}

class TelemostBot {
  /**
   * @param {object} config
   * @param {string} config.room  Telemost link, /j/<id> path, or bare room id
   * @param {string} [config.name] display name (default "SImplicity")
   * @param {boolean} [config.headful] show the browser window (debugging)
   * @param {boolean} [config.debug] verbose page logging
   * @param {function} [config.onEvent] called with (type, data), same event
   *        names as JitsiTTSBot so the server can reuse its state mapping
   */
  constructor(config) {
    if (!config.room) throw new Error('TelemostBot requires "room"');
    this.config = { name: 'SImplicity', headful: false, debug: false, ...config };
    this.url = roomUrlFrom(config.room);
    this.browser = null;
    this.page = null;
  }

  _emit(type, data) {
    if (typeof this.config.onEvent === 'function') {
      try {
        this.config.onEvent(type, data);
      } catch (_) { /* listener errors must not break the bot */ }
    }
  }

  /** probePage with a timeout: a hung evaluate must not stall the join loop. */
  async _probe() {
    try {
      return await Promise.race([
        this.page.evaluate(probePage),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 5000)),
      ]);
    } catch (err) {
      return { status: 'loading', probeError: err.message };
    }
  }

  async start() {
    this.browser = await puppeteer.launch({
      headless: !this.config.headful,
      executablePath: resolveExecutablePath(),
      timeout: 120000,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-dev-shm-usage',
        '--lang=ru-RU',
      ],
    });
    this.page = await this.browser.newPage();
    this.page.on('pageerror', (err) => console.error('[page error]', err.message));
    // Dismiss any JS dialogs (alerts/confirms) — they block page.evaluate.
    this.page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    if (this.config.debug) {
      this.page.on('console', (msg) => console.log('[page]', msg.text().slice(0, 300)));
    }
    this.dead = false;
    // Renderer crash (WebRTC calls in headless Chrome can crash the tab).
    this.page.on('error', (err) => {
      this.dead = true;
      this._emit('conferenceFailed', `telemost.pageCrashed: ${err.message}`);
    });
    this.page.on('close', () => {
      this.dead = true;
      this._emit('connectionDisconnected', 'page closed');
    });
    this.browser.on('disconnected', () => {
      this.dead = true;
      this._emit('connectionDisconnected', 'browser closed');
    });

    await this.page.evaluateOnNewDocument(installFakeMic);
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    this._emit('connectionEstablished');

    // Poll the page: handle the pre-join screen, detect errors and the
    // in-conference state.
    const deadline = Date.now() + 90000;
    let joined = false;
    while (Date.now() < deadline && !joined) {
      const probe = await this._probe();
      if (this.config.debug) console.log('[telemost] probe:', JSON.stringify(probe));
      switch (probe.status) {
        case 'noSuchRoom':
          this._emit('conferenceFailed', 'telemost.noSuchRoom');
          throw new Error('Telemost says this room does not exist');
        case 'loginWall':
          this._emit('conferenceFailed', 'telemost.loginRequired');
          throw new Error('Telemost redirected to a Yandex login page');
        case 'inConference':
          joined = true;
          break;
        case 'preJoin': {
          this._emit('conferenceJoined');
          if (probe.hasNameInput && probe.nameValue !== this.config.name) {
            await this._fillName();
            // Let the app process the input event before clicking join,
            // otherwise the old name ("Гость") is used.
            await new Promise((r) => setTimeout(r, 400));
          }
          await this._clickJoin();
          break;
        }
        default:
          break; // still loading
      }
      if (!joined) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!joined) {
      this._emit('conferenceFailed', 'telemost.joinTimeout');
      try {
        const shot = `/tmp/telemost-timeout-${Date.now()}.png`;
        await this.page.screenshot({ path: shot });
        console.error(`[telemost] join timed out; screenshot saved to ${shot}`);
      } catch (_) { /* ignore */ }
      throw new Error('Timed out waiting to join the Telemost room');
    }
    this._emit('trackAdded'); // fake mic is what getUserMedia hands out
  }

  async _fillName() {
    await this.page.evaluate((name) => {
      const vis = (el) => el.offsetParent !== null;
      const input = [...document.querySelectorAll('input')]
        .find((i) => vis(i) && (!i.type || i.type === 'text'));
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, this.config.name);
  }

  async _clickJoin() {
    await this.page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const btn = [...document.querySelectorAll('button')]
        .find((b) => vis(b) && /войти|подключиться|присоединиться|продолжить|join|continue/i.test(b.innerText || ''));
      if (btn) btn.click();
    });
  }

  /** Plays an MP3 buffer into the conference; resolves when playback ends. */
  async speak(mp3Buffer) {
    if (!this.page || this.dead) throw new Error('Bot browser is gone — reconnect');
    await this.page.evaluate((b64) => window.__ttsSpeak(b64), mp3Buffer.toString('base64'));
  }

  async stop() {
    try {
      if (this.browser) await this.browser.close();
    } catch (_) { /* ignore */ }
    this.browser = null;
    this.page = null;
  }
}

module.exports = { TelemostBot, roomUrlFrom, installFakeMic, probePage };
