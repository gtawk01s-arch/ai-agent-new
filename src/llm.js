import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { CONFIG } from './config.js';

// Provider metrics and rate limits
const providerCounters = {
  gemini: { requests: 0, successes: 0, failures: 0, rate_limited: 0 },
  groq: { requests: 0, successes: 0, failures: 0, rate_limited: 0 },
  fallback: { requests: 0, successes: 0 }
};

let groqDisabledPermanently = false;

/**
 * Format conversation turns for Gemini (alternating user and model roles)
 */
function formatForGemini(messages) {
  const cleanTurns = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const lastTurn = cleanTurns[cleanTurns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += ' ' + msg.content;
    } else {
      cleanTurns.push({ role, parts: [{ text: msg.content }] });
    }
  }

  while (cleanTurns.length > 0 && cleanTurns[0].role !== 'user') {
    cleanTurns.shift();
  }

  if (cleanTurns.length === 0) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    cleanTurns.push({ role: 'user', parts: [{ text: lastUser?.content || 'Hello' }] });
  }

  return cleanTurns;
}

/**
 * Gemini Provider Adapter
 */
async function callGemini(messages, systemInstruction, timeoutMs, callId) {
  const geminiKey = CONFIG.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('No Gemini API key available');

  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const contents = formatForGemini(messages);

  for (const model of CONFIG.GEMINI_MODELS) {
    providerCounters.gemini.requests++;
    const t0 = Date.now();
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.6,
            maxOutputTokens: 500
          }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs))
      ]);

      const text = (response.text || '').trim();
      if (text) {
        providerCounters.gemini.successes++;
        return {
          content: text,
          provider: `gemini/${model}`,
          latency_ms: Date.now() - t0
        };
      }
    } catch (err) {
      providerCounters.gemini.failures++;
      providerCounters.gemini.last_error = `${model}: ${err.message}`;
      if (err.status === 429 || err.message?.includes('429')) {
        providerCounters.gemini.rate_limited++;
      }
      console.warn(`[LLM][${callId}] Gemini (${model}) failed in ${Date.now() - t0}ms:`, err.message);
    }
  }

  throw new Error('All Gemini models exhausted');
}

/**
 * Groq Provider Adapter
 */
async function callGroq(messages, systemInstruction, timeoutMs, callId) {
  if (groqDisabledPermanently || !CONFIG.GROQ_API_KEY || !CONFIG.GROQ_API_KEY.startsWith('gsk_')) {
    throw new Error('Groq disabled or invalid key');
  }

  const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
  const groqMessages = [
    { role: 'system', content: systemInstruction },
    ...messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  for (const model of CONFIG.GROQ_MODELS) {
    providerCounters.groq.requests++;
    const t0 = Date.now();
    try {
      const completion = await Promise.race([
        groq.chat.completions.create({
          model,
          messages: groqMessages,
          temperature: 0.6,
          max_tokens: 180
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs))
      ]);

      const text = (completion.choices[0]?.message?.content || '').trim();
      if (text) {
        providerCounters.groq.successes++;
        return {
          content: text,
          provider: `groq/${model}`,
          latency_ms: Date.now() - t0
        };
      }
    } catch (err) {
      providerCounters.groq.failures++;
      if (err.status === 401 || err.message?.includes('401')) {
        groqDisabledPermanently = true;
        throw new Error('Groq 401 unauthorized');
      }
      if (err.status === 429 || err.message?.includes('429')) {
        providerCounters.groq.rate_limited++;
      }
      console.warn(`[LLM][${callId}] Groq (${model}) failed in ${Date.now() - t0}ms:`, err.message);
    }
  }

  throw new Error('All Groq models exhausted');
}

/**
 * Unified generate interface with automatic multi-provider fallback
 */
export async function generate(messages, options = {}) {
  const {
    systemInstruction = 'You are an AI voice phone agent. Answer in 1-2 spoken sentences.',
    timeoutMs = CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId = 'turn'
  } = options;

  // 1. Try Gemini first (primary multimodal LLM)
  try {
    return await callGemini(messages, systemInstruction, timeoutMs, callId);
  } catch (geminiErr) {
    console.warn(`[LLM][${callId}] Gemini primary failed, falling back to secondary:`, geminiErr.message);
  }

  // 2. Try Groq fallback
  try {
    return await callGroq(messages, systemInstruction, timeoutMs, callId);
  } catch (groqErr) {
    console.warn(`[LLM][${callId}] Groq fallback failed:`, groqErr.message);
  }

  // 3. Resilient conversational safety net
  providerCounters.fallback.requests++;
  providerCounters.fallback.successes++;
  const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const lower = lastUserText.toLowerCase();

  let fallbackReply = "I can certainly help you with that. Could you share a few more details so I can look that right up for you?";
  if (lower.includes('who are you') || lower.includes('your name')) {
    fallbackReply = "I am Alex, your automated AI phone assistant, and I am right here with you on the line. How can I assist you today?";
  } else if (lower.includes('hours') || lower.includes('open') || lower.includes('close')) {
    fallbackReply = "Our automated service is available 24/7, and our specialist extensions are open Monday through Friday from 9 AM to 6 PM EST.";
  }

  return {
    content: fallbackReply,
    provider: 'local/resilient-fallback',
    latency_ms: 10
  };
}

export function getProviderCounters() {
  return { ...providerCounters };
}
