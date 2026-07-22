'use strict';

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// en-US-AriaNeural is advertised by the service but rejected at synthesis
// time; JennyNeural works reliably.
const DEFAULT_VOICE = 'en-US-JennyNeural';

// Used automatically when the text contains Cyrillic characters.
// (ru-RU-DariyaNeural and ru-RU-DmitryNeural are rejected at synthesis time.)
const RUSSIAN_VOICE = 'ru-RU-SvetlanaNeural';

const CYRILLIC = /[Ѐ-ӿ]/;

/** Pick a voice for the text: Russian voice for Cyrillic, fallback otherwise. */
function voiceForText(text, fallback = DEFAULT_VOICE, russian = RUSSIAN_VOICE) {
  return CYRILLIC.test(text) ? russian : fallback;
}

// The SSML is built by string interpolation, so user text must be XML-escaped.
const escapeXml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

let voicesCache = null;

/** Names of all voices the service advertises (cached). */
async function listVoiceNames() {
  if (!voicesCache) {
    const tts = new MsEdgeTTS();
    try {
      voicesCache = (await tts.getVoices()).map((v) => v.ShortName);
    } finally {
      tts.close();
    }
  }
  return voicesCache;
}

async function synthesizeOnce(text, voice) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text));
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
      throw new Error('TTS returned no audio');
    }
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}

/**
 * Synthesize text into an MP3 buffer using the free Edge Read Aloud API.
 *
 * @param {string} text text to speak
 * @param {string} [voice] e.g. "en-US-AriaNeural", "ru-RU-SvetlanaNeural"
 * @returns {Promise<Buffer>} MP3 audio
 */
async function synthesizeSpeech(text, voice = DEFAULT_VOICE) {
  // Retry once: the service occasionally drops the stream mid-synthesis.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await synthesizeOnce(text, voice);
    } catch (err) {
      lastErr = err;
    }
  }

  // Some advertised voices are rejected by the endpoint at synthesis time
  // (e.g. ru-RU-DmitryNeural). Point the user at working alternatives.
  let hint = '';
  try {
    const names = await listVoiceNames();
    const locale = voice.split('-').slice(0, 2).join('-');
    const sameLocale = names.filter((n) => n.startsWith(locale) && n !== voice);
    if (!names.includes(voice)) {
      hint = ` Voice "${voice}" is not in the service's voice list.`;
    } else {
      hint = ` The service lists "${voice}" but rejects it at synthesis time.`;
    }
    if (sameLocale.length > 0) {
      hint += ` Available ${locale} voices: ${sameLocale.join(', ')}`;
    }
  } catch (_) { /* diagnostics are best-effort */ }
  throw new Error(`TTS failed with voice "${voice}": ${lastErr.message}.${hint}`);
}

module.exports = { synthesizeSpeech, listVoiceNames, voiceForText, DEFAULT_VOICE, RUSSIAN_VOICE };
