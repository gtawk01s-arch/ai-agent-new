import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { CONFIG } from './src/config.js';
import webhookRouter from './src/webhook.js';
import { pregenerateStaticLines } from './src/tts.js';
import { getGlobalLatencyMetrics, getAllSessions, getOrCreateSession, getSession } from './src/session.js';
import { getProviderCounters } from './src/llm.js';
import { transcribeAudio } from './src/asr.js';
import { processTurn } from './src/engine.js';
import { synthesizeSpeech } from './src/tts.js';
import multer from 'multer';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Structured JSON Logger Middleware
app.use((req, res, next) => {
  const start = Date.now();
  const callId = req.body?.call_id || req.headers['x-call-id'] || 'system';
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api') && req.path !== '/api/health') {
      console.log(JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        call_id: callId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration
      }));
    }
  });
  next();
});

// 1. Healthcheck endpoints
const getHealthPayload = () => {
  const latency = getGlobalLatencyMetrics();
  const providers = getProviderCounters();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: CONFIG.PORT,
    version: '1.0.0',
    providers: {
      gemini_active: Boolean(CONFIG.GEMINI_API_KEY),
      groq_active: Boolean(CONFIG.GROQ_API_KEY && CONFIG.GROQ_API_KEY.startsWith('gsk_')),
      metrics: providers
    },
    latency: {
      target_ms: CONFIG.TIMEOUTS.TOTAL_BUDGET,
      p50_ms: latency.p50,
      p95_ms: latency.p95,
      samples: latency.sample_count
    },
    active_sessions: getAllSessions().filter(s => s.status === 'connected').length
  };
};

app.get('/health', (req, res) => res.json(getHealthPayload()));
app.get('/api/health', (req, res) => res.json(getHealthPayload()));

// 2. Telephony Webhook Contract Router
app.use('/api/webhook', webhookRouter);

// 3. Backward-compatible PBX / Dialer Routes
app.get('/api/dialer/extensions', (req, res) => {
  res.json({
    status: 'success',
    count: CONFIG.EXTENSIONS.length,
    extensions: CONFIG.EXTENSIONS
  });
});

app.post('/api/dialer/call/start', async (req, res) => {
  // Delegate to modular webhook call handler
  const callId = req.body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const direction = req.body.direction === 'outbound' ? 'outbound' : 'inbound';
  const callerId = req.body.caller_id || req.body.From || 'Anonymous';
  const campaignId = req.body.campaign || (direction === 'outbound' ? 'sales' : 'support');

  const session = getOrCreateSession(callId, {
    direction,
    callerId,
    campaignId
  });

  const campaign = CONFIG.CAMPAIGNS[campaignId] || CONFIG.CAMPAIGNS.support;
  const greeting = campaign.greeting;
  session.recordTurn('assistant', greeting);

  const ttsRes = await synthesizeSpeech(greeting, {
    isStatic: true,
    callId
  });

  res.json({
    status: 'success',
    call_id: callId,
    direction,
    call_status: 'connected',
    greeting,
    audio_url: ttsRes.audio_url,
    available_extensions: CONFIG.EXTENSIONS,
    session: {
      callId,
      direction,
      status: session.status,
      campaign: campaign.name
    }
  });
});

app.post('/api/dialer/call/interact', upload.single('audio'), async (req, res) => {
  const callId = req.body.call_id || 'demo-call';
  const session = getOrCreateSession(callId);
  const tempPath = req.file?.path;
  let userText = (req.body.text || '').trim();

  try {
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asr = await transcribeAudio(audioBuffer, { callId, language: session.language });
      userText = asr.text;
    }

    const engineResult = await processTurn(session, userText);
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      voice: req.body.voice || CONFIG.AUDIO.DEFAULT_VOICE,
      callId
    });

    res.json({
      call_id: callId,
      action: engineResult.action === 'transfer' ? 'transfer' : (engineResult.action === 'hangup' ? 'hangup' : 'continue'),
      call_status: session.status,
      transcription: userText,
      response: engineResult.reply,
      audio_url: ttsResult.audio_url,
      disposition: engineResult.disposition,
      transfer: engineResult.transfer ? {
        extension: engineResult.transfer.id,
        name: engineResult.transfer.name,
        department: engineResult.transfer.dept,
        sip_uri: engineResult.transfer.sip,
        phone_number: engineResult.transfer.phone,
        warm_transfer_notes: engineResult.reply
      } : null,
      session: {
        turns: session.turns,
        status: session.status,
        disposition: session.disposition
      }
    });
  } catch (err) {
    console.error(`[Dialer][${callId}] Error:`, err);
    res.status(500).json({ error: err.message || 'Failed to interact' });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
});

app.post('/api/dialer/call/end', (req, res) => {
  const callId = req.body.call_id;
  const session = getSession(callId);
  if (session) {
    session.end(req.body.disposition || 'caller_ended');
  }
  res.json({ status: 'ended', call_id: callId });
});

// 4. Serve generated / cached audio files
app.get('/api/audio/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, safeFilename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }
  const ext = path.extname(safeFilename).toLowerCase();
  const mimeType = ext === '.wav' ? 'audio/wav' : (ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg');
  res.setHeader('Content-Type', mimeType);
  res.sendFile(filePath);
});

// 5. Serve frontend app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`🚀 AI Call Assistant & Telephony Engine running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
  pregenerateStaticLines().catch(err => console.warn('Pregeneration notice:', err.message));
});
