'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const readline = require('node:readline');
const { synthesizeSpeech, listVoiceNames, DEFAULT_VOICE } = require('./tts');
const { JitsiTTSBot } = require('./bot');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: npm start -- [options]

Options:
  --domain <host>   Jitsi deployment (env JITSI_DOMAIN, default meet.jit.si)
  --room <name>     conference room (env JITSI_ROOM, default: random)
  --muc <host>      MUC domain (default conference.<domain>)
  --name <name>     bot display name (env BOT_NAME, default "TTS Bot")
  --anonymous-domain <host>  guest domain for anonymous login
                    (env JITSI_ANONYMOUS_DOMAIN, auto: guest.meet.jit.si for meet.jit.si)
  --voice <voice>   TTS voice (env TTS_VOICE, default ${DEFAULT_VOICE})
  --list-voices [prefix]  list available TTS voices and exit
  --say "<text>"    speak once and leave (instead of interactive REPL)
  --headful         show the browser window for debugging
  --help            show this help

Authentication: set JITSI_TOKEN in .env for deployments that require a JWT.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args['list-voices']) {
    const filter = typeof args['list-voices'] === 'string' ? args['list-voices'].toLowerCase() : '';
    const names = await listVoiceNames();
    console.log(names.filter((n) => n.toLowerCase().includes(filter)).join('\n'));
    return;
  }

  const domain = args.domain || process.env.JITSI_DOMAIN || 'meet.jit.si';
  const rawRoom = args.room ||
    process.env.JITSI_ROOM ||
    `tts-bot-${crypto.randomBytes(3).toString('hex')}`;

  const room = String(rawRoom).trim().toLowerCase();
  const voice = args.voice || process.env.TTS_VOICE || DEFAULT_VOICE;

  const bot = new JitsiTTSBot({
    domain,
    room,
    muc: args.muc || process.env.JITSI_MUC,
    anonymousDomain: args['anonymous-domain'] || process.env.JITSI_ANONYMOUS_DOMAIN
      || (domain === 'meet.jit.si' ? 'guest.meet.jit.si' : undefined),
    name: args.name || process.env.BOT_NAME,
    token: args.token || process.env.JITSI_TOKEN,
    headful: Boolean(args.headful) || process.env.HEADFUL === '1',
    debug: Boolean(args.debug) || process.env.DEBUG === '1',
  });

  console.log(`[bot] Joining https://${domain}/${room} as "${bot.config.name}"...`);
  await bot.start();
  console.log(`[bot] Others can join at https://${domain}/${room}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const speak = async (text) => {
    process.stdout.write('[bot] synthesizing... ');
    const audio = await synthesizeSpeech(text, voice);
    process.stdout.write('speaking... ');
    await bot.speak(audio);
    console.log('done');
  };

  if (args.say) {
    await speak(String(args.say));
    await stop();
    return;
  }

  console.log('[bot] Type text and press Enter to speak it. /q to quit.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'speak> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (text === '/q' || text === '/quit') {
      rl.close();
      return;
    }
    if (text) {
      try {
        await speak(text);
      } catch (err) {
        console.error('\n[bot] speak failed:', err.message);
      }
    }
    rl.prompt();
  });
  rl.on('close', stop);
}

main().catch((err) => {
  console.error('[bot] Fatal:', err.message);
  process.exit(1);
});
