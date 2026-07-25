'use strict';
// Debug join against a real Telemost room: performs the auto-join flow
// manually, logging every probe and dumping the UI at each stage.
const puppeteer = require('puppeteer');
const { resolveExecutablePath } = require('../src/bot');
const { installFakeMic, probePage } = require('../src/telemost');

const URL = process.argv[2];
const NAME = process.argv[3] || 'SImplicity';
if (!URL) { console.error('usage: node scripts/debug-telemost.js <room-url> [name]'); process.exit(1); }

function dumpUI() {
  const vis = (el) => el.offsetParent !== null;
  return {
    buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => ({
      text: (b.innerText || '').trim().slice(0, 50),
      aria: b.getAttribute('aria-label'),
    })).filter((b) => b.text || b.aria),
    inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({
      type: i.type, placeholder: i.placeholder, value: i.value,
    })),
  };
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveExecutablePath(),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=ru-RU'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(installFakeMic);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  let shot = 0;
  let lastStage = '';
  for (let i = 0; i < 60; i++) {
    const probe = await page.evaluate(probePage).catch((e) => ({ status: 'evalError', error: e.message }));
    console.log(`t=${i}s`, JSON.stringify(probe));
    if (probe.status !== lastStage && probe.status !== 'loading') {
      lastStage = probe.status;
      console.log('UI:', JSON.stringify(await page.evaluate(dumpUI)));
      await page.screenshot({ path: `/tmp/tm-${shot++}-${probe.status}.png` });
    }
    if (probe.status === 'inConference') break;
    if (probe.status === 'preJoin') {
      if (probe.hasNameInput && probe.nameValue !== NAME) {
        await page.evaluate((name) => {
          const input = [...document.querySelectorAll('input')]
            .find((x) => x.offsetParent && (!x.type || x.type === 'text'));
          if (!input) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, NAME);
        console.log('  -> filled name');
      }
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.offsetParent && /войти|подключиться|присоединиться|продолжить|join|continue/i.test(b.innerText || ''));
        if (btn) btn.click();
      });
      console.log('  -> clicked join-ish button');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (lastStage === 'inConference') {
    console.log('JOINED. Testing TTS playback into the fake mic...');
    const { synthesizeSpeech, voiceForText } = require('../src/tts');
    const audio = await synthesizeSpeech('Проверка связи. Бот работает.', voiceForText('Проверка связи. Бот работает.'));
    await page.evaluate((b64) => window.__ttsSpeak(b64), audio.toString('base64'));
    console.log('TTS playback finished.');
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
