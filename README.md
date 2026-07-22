# SImplicity

A small web app that joins a [Jitsi Meet](https://jitsi.org/) room as a bot and
speaks any text you type into the conference, using text-to-speech.

The web interface lets you:

- enter a Jitsi room name and connect/disconnect with one button,
- see the current connection state (disconnected / connecting / waiting in
  lobby / connected / error) on a live indicator,
- type text and send it — the app converts it to speech and publishes the
  audio into the room.

## How it works

lib-jitsi-meet needs a real browser environment (WebRTC, WebAudio, DOM), so the
app runs it inside headless Chrome, driven from Node.js via Puppeteer:

```
web UI → Node server → msedge-tts (MP3) → WebAudio buffer → fake microphone → lib-jitsi-meet → conference
```

- lib-jitsi-meet is loaded from the target deployment itself
  (`https://<domain>/libs/lib-jitsi-meet.min.js`), so the client version always
  matches the server.
- The bot's "microphone" is a `MediaStreamAudioDestinationNode` that stays
  silent until synthesized audio is played into it.
- TTS uses the free Microsoft Edge Read Aloud API.

## Setup

```sh
npm install
cp .env.example .env   # optional, edit as needed
```

Requires Node.js >= 18. On Apple Silicon Macs the Node must be an **arm64**
build — an x64 Node runs under Rosetta and drags Chrome into translation with
it. `npm start` goes through `start.sh`, which auto-selects an arm64 Node
installed via fnm. To install one:

```sh
fnm install 24 --arch arm64
```

## Usage

```sh
npm start
```

Then open http://localhost:3000, type a room name, press **Connect**, wait for
the indicator to turn green, type text and press **Send**.

Everything (port, Jitsi deployment, TTS voice, JWT, …) can be set in `.env` —
see `.env.example`.

## Notes and limitations

- **meet.jit.si requires authentication** to *create* a room (since Aug 2023).
  The bot connects as an anonymous guest via `guest.meet.jit.si`, so the room
  must already be open before the bot joins:
  1. Open `https://meet.jit.si/<your-room>` in your browser and sign in when
     asked — this makes you the moderator and opens the room.
  2. Connect to `<your-room>` from the SImplicity UI.
  3. If you enabled the lobby, admit "SImplicity" when it knocks (the indicator
     shows "Waiting in lobby…" meanwhile).
- Other deployments with secure-domain auth: set `JITSI_ANONYMOUS_DOMAIN` to
  their guest domain, or provide a JWT via `JITSI_TOKEN` (then no guest domain
  is needed).
- Custom/self-hosted deployments with a non-standard MUC domain: set `JITSI_MUC`.
- Voices: any Edge neural voice, e.g. `en-US-AriaNeural`, `en-GB-SoniaNeural`,
  `de-DE-ConradNeural`, `fr-FR-DeniseNeural`. Set `TTS_VOICE` in `.env`.
- The bot is audio-only; video constraints are rejected by design.

## Project layout

- `src/index.js` — web server (`node:http`): serves the UI and the JSON API
  (`/api/connect`, `/api/disconnect`, `/api/speak`, `/api/state`)
- `public/index.html` — the web interface (vanilla JS, no build step)
- `src/bot.js` — Puppeteer + lib-jitsi-meet glue (`JitsiTTSBot` class, in-page API)
- `src/tts.js` — text → MP3 buffer via `msedge-tts`
- `src/cli.js` — the original terminal interface (`npm run cli -- --help`)

To use the bot as a library:

```js
const { JitsiTTSBot } = require('./src/bot');
const { synthesizeSpeech } = require('./src/tts');

const bot = new JitsiTTSBot({ domain: 'meet.jit.si', room: 'my-room' });
await bot.start();
await bot.speak(await synthesizeSpeech('Hello!'));
await bot.stop();
```
