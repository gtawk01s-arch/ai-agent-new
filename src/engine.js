import { generate } from './llm.js';
import { CONFIG, getCampaign } from './config.js';

// Clean spoken text: strip markdown, asterisks, hashtags, code blocks, emojis
export function cleanSpokenText(text) {
  if (!text) return '';
  return text
    .replace(/\*+/g, '')
    .replace(/#+/g, '')
    .replace(/[_`~]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if the caller is visibly angry or demanding escalation
 */
function isAngryCaller(text) {
  const angryPatterns = [
    /angry/i, /furious/i, /unacceptable/i, /lawyer/i, /sue\b/i,
    /bullshit/i, /ridiculous/i, /terrible service/i, /worst company/i,
    /get me your manager/i, /talk to your manager/i, /supervisor right now/i,
    /human supervisor/i, /escalate this/i
  ];
  return angryPatterns.some(p => p.test(text));
}

/**
 * Check if caller demanded Do Not Call (DNC)
 */
function isDncRequest(text) {
  const dncPatterns = [
    /don't call me/i, /dont call me/i, /do not call/i, /stop calling/i,
    /remove my number/i, /take me off (your|the) list/i, /lose my number/i,
    /delete my number/i, /never call/i
  ];
  return dncPatterns.some(p => p.test(text));
}

/**
 * Check if caller asked for an explicit extension
 */
function findRequestedExtension(text) {
  const lower = text.toLowerCase();
  for (const ext of CONFIG.EXTENSIONS) {
    if (
      lower.includes(`extension ${ext.id}`) ||
      lower.includes(`ext ${ext.id}`) ||
      lower.includes(`ext. ${ext.id}`) ||
      new RegExp(`\\bext\\s*${ext.id}\\b`, 'i').test(lower)
    ) {
      return ext;
    }
  }

  // Check department keywords if explicit transfer phrasing was used
  const transferPhrases = [
    'transfer me', 'transfer my call', 'transfer to', 'speak with', 'speak to',
    'talk to an agent', 'talk to a human', 'representative', 'live agent', 'live person'
  ];
  const wantsTransfer = transferPhrases.some(p => lower.includes(p));
  if (wantsTransfer) {
    for (const ext of CONFIG.EXTENSIONS) {
      if (ext.keywords.some(kw => lower.includes(kw))) {
        return ext;
      }
    }
    return CONFIG.EXTENSIONS[0]; // Default to general support
  }

  return null;
}

/**
 * Process a conversation turn through the structured engine
 */
export async function processTurn(session, userText, options = {}) {
  const t0 = Date.now();
  const campaign = getCampaign(session.campaignId);
  const cleanInput = (userText || '').trim();

  // 1. HARD RULE: DNC (Do Not Call) Request -> Immediate DNC disposition and hangup
  if (isDncRequest(cleanInput)) {
    const farewell = "Understood. I have recorded your request and removed your phone number from our call list. Have a good day. Goodbye.";
    session.recordTurn('user', cleanInput);
    session.recordTurn('assistant', farewell);
    session.disposition = 'DNC';
    session.status = 'completed';

    return {
      action: 'hangup',
      intent: 'do_not_call',
      reply: farewell,
      disposition: 'DNC',
      confidence: 1.0,
      transfer: null,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // 2. HARD RULE: Angry Caller -> Immediate Escalation to Supervisor (Extension 200)
  if (isAngryCaller(cleanInput)) {
    const supervisorExt = CONFIG.EXTENSIONS.find(e => e.id === '200') || CONFIG.EXTENSIONS[0];
    const reply = `I sincerely apologize for your frustration. I am escalating your call immediately to our Management Supervisor on extension ${supervisorExt.id}. Please hold.`;
    session.recordTurn('user', cleanInput);
    session.recordTurn('assistant', reply);
    session.disposition = 'escalated_supervisor';
    session.status = 'transferred';
    session.transferredTo = supervisorExt;

    return {
      action: 'transfer',
      intent: 'angry_escalation',
      reply,
      disposition: 'escalated_supervisor',
      confidence: 1.0,
      transfer: supervisorExt,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // 3. HARD RULE: Explicit Extension or Transfer Request
  const explicitExt = findRequestedExtension(cleanInput);
  if (explicitExt) {
    const reply = `Certainly! I am transferring your call to ${explicitExt.name} on extension ${explicitExt.id}. Please stay on the line while I connect you.`;
    session.recordTurn('user', cleanInput);
    session.recordTurn('assistant', reply);
    session.disposition = 'transferred';
    session.status = 'transferred';
    session.transferredTo = explicitExt;

    return {
      action: 'transfer',
      intent: 'transfer_request',
      reply,
      disposition: 'transferred',
      confidence: 1.0,
      transfer: explicitExt,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // 4. HARD RULE: Check failed understandings in a row
  if (!cleanInput) {
    session.failedUnderstandings = (session.failedUnderstandings || 0) + 1;
    if (session.failedUnderstandings >= 2) {
      const supportExt = CONFIG.EXTENSIONS[0];
      const reply = `I am having trouble hearing your audio clearly. Let me connect you directly to our Customer Support desk on extension ${supportExt.id}.`;
      session.recordTurn('assistant', reply);
      session.status = 'transferred';
      session.transferredTo = supportExt;

      return {
        action: 'transfer',
        intent: 'fallback_transfer',
        reply,
        disposition: 'audio_failed_transfer',
        confidence: 0.9,
        transfer: supportExt,
        timing_ms: { engine: Date.now() - t0 }
      };
    }

    const noSpeechReply = "I am sorry, I did not catch that. Could you please say that again?";
    session.recordTurn('assistant', noSpeechReply);
    return {
      action: 'speak_and_listen',
      intent: 'no_speech',
      reply: noSpeechReply,
      disposition: 'in_progress',
      confidence: 0.5,
      transfer: null,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // Reset failed understandings counter on successful speech
  session.failedUnderstandings = 0;

  // Check hangup phrases
  const lowerInput = cleanInput.toLowerCase();
  if (lowerInput === 'bye' || lowerInput === 'goodbye' || lowerInput === 'bye bye' || lowerInput.includes('hang up')) {
    const farewell = "Thank you for calling. Have a great day! Goodbye.";
    session.recordTurn('user', cleanInput);
    session.recordTurn('assistant', farewell);
    session.status = 'completed';
    session.disposition = 'resolved';

    return {
      action: 'hangup',
      intent: 'farewell',
      reply: farewell,
      disposition: 'resolved',
      confidence: 1.0,
      transfer: null,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // Build Context: Keep only last 6-8 turns
  session.recordTurn('user', cleanInput);
  const recentHistory = session.getRecentHistory(8);

  // Construct System Instruction for Campaign
  const systemInstruction = `You are ${campaign.persona} on a live telephone call for "${campaign.name}".
Goal: ${campaign.goal}
Language: ${campaign.language}

Campaign FAQ & Knowledge:
${campaign.faqSnippet}

Instructions:
- Speak naturally, warmly, and concisely like a professional human telephone agent.
- Keep answers strictly to 1 to 2 spoken sentences (max 25-30 words total).
- Answer ANY caller inquiry factually and directly (e.g. general knowledge, science, account queries, recommendations).
- If the caller asks if you are an AI, bot, or virtual assistant, honestly admit: "Yes, I am an automated AI voice assistant named Alex, and I am right here on the line to help you."
- Never use emojis, asterisks, bullet points, formatting, or code blocks. Spoken plain English only.

You MUST respond strictly in valid JSON format with this exact structure:
{
  "reply": "Spoken answer in 1-2 concise sentences",
  "intent": "short_intent_slug",
  "action": "continue",
  "disposition": "in_progress",
  "confidence": 0.95
}`;

  const tLlm0 = Date.now();
  const llmResult = await generate(recentHistory, {
    systemInstruction,
    timeoutMs: CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId: session.callId
  });
  const llmLatency = Date.now() - tLlm0;

  // Parse structured output
  let parsed = null;
  let rawReply = '';
  let intent = 'general_query';
  let action = 'speak_and_listen';
  let disposition = 'in_progress';
  let confidence = 0.95;

  const rawContent = (llmResult.content || '').trim();

  // Try direct or markdown-stripped JSON parsing
  try {
    let cleanJson = rawContent;
    if (cleanJson.includes('```json')) {
      cleanJson = cleanJson.split('```json')[1].split('```')[0].trim();
    } else if (cleanJson.includes('```')) {
      cleanJson = cleanJson.split('```')[1].split('```')[0].trim();
    }
    const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (parseErr) {
    // If regular JSON.parse fails, extract fields with regex
  }

  if (parsed && parsed.reply) {
    rawReply = parsed.reply;
    if (parsed.intent) intent = parsed.intent;
    if (parsed.action) action = parsed.action;
    if (parsed.disposition) disposition = parsed.disposition;
    if (typeof parsed.confidence === 'number') confidence = parsed.confidence;
  } else {
    // Regex fallback for truncated or loosely formatted JSON: "reply": "..."
    const replyMatch = rawContent.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (replyMatch) {
      try {
        rawReply = JSON.parse(`"${replyMatch[1]}"`);
      } catch (_) {
        rawReply = replyMatch[1];
      }
    } else {
      // If no reply key, strip any JSON artifact brackets/headers
      rawReply = rawContent
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```$/g, '')
        .replace(/^\{[\s\S]*?"reply"\s*:\s*"?/i, '')
        .replace(/[}"]\s*,\s*"intent"[\s\S]*$/i, '')
        .replace(/^json\s*\{?/i, '')
        .trim();
    }
  }

  // Final cleanup of spoken text
  let reply = cleanSpokenText(rawReply);
  if (!reply || reply === 'json {' || reply.startsWith('{')) {
    reply = "I'm right here with you. Could you please repeat that question for me?";
  }

  action = action === 'transfer' ? 'transfer' : (action === 'hangup' ? 'hangup' : 'speak_and_listen');

  session.recordTurn('assistant', reply);

  return {
    action,
    intent,
    reply,
    disposition,
    confidence,
    transfer: null,
    timing_ms: {
      llm: llmLatency,
      total_engine: Date.now() - t0
    },
    provider: llmResult.provider
  };
}
