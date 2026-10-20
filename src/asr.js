import { GoogleGenAI } from '@google/genai';
import { CONFIG } from './config.js';
import fs from 'fs';

// Known hallucinations produced by ASR models on low-energy or background noise
const HALLUCINATION_PATTERNS = [
  /^thank you(\s+very\s+much)?[.!]?$/i,
  /^thanks for watching[.!]?$/i,
  /^you[.!]?$/i,
  /^bye[.!]?$/i,
  /^subscribe[.!]?$/i,
  /^[.?!, ]+$/
];

/**
 * Detect MIME type from buffer magic bytes
 */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return 'audio/webm';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav';
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mp3';
  if (buffer.length >= 8 && buffer.slice(4, 8).toString() === 'ftyp') return 'audio/mp4';
  return 'audio/webm';
}

/**
 * Check if audio buffer is too tiny (< 400 bytes) or essentially silence
 */
export function isAudioTrivial(buffer) {
  if (!buffer || buffer.length < 500) return true;
  return false;
}

/**
 * Transcribe caller audio with Gemini Multimodal ASR with hallucination filter
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const t0 = Date.now();
  const { mimeType: inputMime, language = 'en', callId = 'turn' } = options;

  if (isAudioTrivial(audioBuffer)) {
    return { text: '', latency_ms: Date.now() - t0, is_silence: true };
  }

  const mimeType = inputMime || detectMimeType(audioBuffer);
  const base64Audio = audioBuffer.toString('base64');
  const geminiKey = CONFIG.GEMINI_API_KEY;

  if (!geminiKey) {
    console.warn(`[ASR][${callId}] No Gemini API key available for ASR`);
    return { text: '', latency_ms: Date.now() - t0, is_silence: true };
  }

  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const asrModels = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.8-flash'];

  for (const model of asrModels) {
    try {
      const promptText = `Transcribe the caller's spoken words verbatim in ${language}. 
Output ONLY the spoken words. If there is only silence, background noise, or no human speech, output NO_SPEECH.`;

      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio
                  }
                },
                { text: promptText }
              ]
            }
          ]
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ASR timeout')), CONFIG.TIMEOUTS.ASR_GEMINI))
      ]);

      let text = (response.text || '').trim().replace(/^["']|["']$/g, '');

      // Check for silence indicator
      if (!text || text.toUpperCase() === 'NO_SPEECH' || text.toUpperCase() === 'NO SPEECH') {
        return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: model };
      }

      // Check hallucination filter
      const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
      if (isHallucination && audioBuffer.length < 3500) {
        console.log(`[ASR][${callId}] Filtered ASR hallucination "${text}" on short audio`);
        return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: model };
      }

      const latency_ms = Date.now() - t0;
      console.log(`[ASR][${callId}] Transcribed (${model}, ${latency_ms}ms): "${text}"`);
      return { text, latency_ms, is_silence: false, provider: model };
    } catch (err) {
      console.warn(`[ASR][${callId}] Model ${model} failed:`, err.message);
    }
  }

  return { text: '', latency_ms: Date.now() - t0, is_silence: true, error: 'All ASR models exhausted' };
}
