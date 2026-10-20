import { Communicate } from 'edge-tts-universal';
import { CONFIG } from './config.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Memory and file cache for static audio lines
const audioCache = new Map();

// Ensure audio cache directory exists
if (!fs.existsSync(CONFIG.AUDIO.CACHE_DIR)) {
  fs.mkdirSync(CONFIG.AUDIO.CACHE_DIR, { recursive: true });
}

/**
 * Generate a SHA256 cache key for static lines
 */
function getCacheKey(text, voice, format = 'mp3') {
  return crypto.createHash('sha256').update(`${text}_${voice}_${format}`).digest('hex');
}

/**
 * Split text into individual spoken sentences for fast streaming
 */
export function chunkIntoSentences(text) {
  if (!text) return [];
  // Split on sentence boundaries: period, question mark, exclamation mark followed by space or end
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text];
  return sentences.map(s => s.trim()).filter(Boolean);
}

/**
 * Synthesize speech audio with Edge-TTS or retrieve from cache
 */
export async function synthesizeSpeech(text, options = {}) {
  const t0 = Date.now();
  const {
    voice = CONFIG.AUDIO.DEFAULT_VOICE,
    format = 'mp3',
    isStatic = false,
    callId = 'tts'
  } = options;

  if (!text || !text.trim()) {
    return { audio_url: null, audio_buffer: null, latency_ms: 0, cached: false };
  }

  const cacheKey = getCacheKey(text, voice, format);

  // Check cache
  if (audioCache.has(cacheKey)) {
    const cachedFile = audioCache.get(cacheKey);
    const fullPath = path.join(CONFIG.AUDIO.CACHE_DIR, cachedFile);
    if (fs.existsSync(fullPath)) {
      return {
        audio_url: `/api/audio/${cachedFile}`,
        audio_buffer: fs.readFileSync(fullPath),
        latency_ms: Date.now() - t0,
        cached: true,
        format
      };
    }
  }

  // Generate audio via Edge-TTS with strict non-blocking timeout
  try {
    const ttsTask = (async () => {
      try {
        const communicate = new Communicate(text, { voice });
        const chunks = [];
        for await (const chunk of communicate.stream()) {
          if (chunk.type === 'audio' && chunk.data) {
            chunks.push(Buffer.from(chunk.data));
          }
        }
        if (chunks.length > 0) {
          const buffer = Buffer.concat(chunks);
          const filename = isStatic ? `static-${cacheKey.slice(0, 16)}.${format}` : `reply-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${format}`;
          const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, filename);
          fs.writeFileSync(filePath, buffer);

          audioCache.set(cacheKey, filename);

          return {
            audio_url: `/api/audio/${filename}`,
            audio_buffer: buffer,
            latency_ms: Date.now() - t0,
            cached: false,
            format
          };
        }
      } catch (err) {
        // Edge TTS streaming network error or unavailable
      }
      return null;
    })();

    const timeoutTask = new Promise((resolve) => setTimeout(() => resolve(null), CONFIG.TIMEOUTS.TTS_EDGE));
    const result = await Promise.race([ttsTask, timeoutTask]);

    if (result) return result;
  } catch (err) {
    console.warn(`[TTS][${callId}] Generation failed:`, err.message);
  }

  // Graceful fallback: return null audio_url, client browser will instantly speak with Web Speech
  return {
    audio_url: null,
    audio_buffer: null,
    latency_ms: Date.now() - t0,
    cached: false,
    format
  };
}

/**
 * Pre-generate static lines at startup
 */
export async function pregenerateStaticLines() {
  console.log('[TTS] Pre-generating static campaign audio lines...');
  const lines = [
    { text: "Thank you for calling Customer Support. I am Alex, your automated AI voice agent. What can I help you with today?", id: "support_greeting" },
    { text: "Certainly! I am transferring your call to Billing & Payments on extension 102. Please stay on the line.", id: "transfer_102" },
    { text: "Thank you for calling. Have a great day! Goodbye.", id: "goodbye" },
    { text: "Understood. I have recorded your request and removed your phone number from our call list. Goodbye.", id: "dnc" }
  ];

  for (const line of lines) {
    try {
      await synthesizeSpeech(line.text, { isStatic: true });
    } catch (e) {
      // ignore
    }
  }
  console.log('[TTS] Static lines cache populated');
}
