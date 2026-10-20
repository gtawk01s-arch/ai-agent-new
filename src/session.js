// In-memory call sessions store
const sessions = new Map();

// Global latency measurements collection for p50 / p95 calculation
const latencyRecords = [];

export class CallSession {
  constructor(callId, options = {}) {
    this.callId = callId;
    this.direction = options.direction || 'inbound';
    this.callerId = options.callerId || 'Anonymous';
    this.calledNumber = options.calledNumber || '';
    this.campaignId = options.campaignId || 'support';
    this.language = options.language || 'en';
    this.outputAudioFormat = options.outputAudioFormat || 'mp3';
    this.status = 'connected'; // 'connected' | 'transferred' | 'completed' | 'failed'
    this.disposition = 'in_progress';
    this.transferredTo = null;
    this.startTime = Date.now();
    this.endTime = null;
    this.turns = 0;
    this.failedUnderstandings = 0;
    this.history = []; // Array of { role: 'user' | 'assistant', content: string, timestamp: number }
    this.turnLatencies = []; // Array of { asr, llm, tts, total }
  }

  recordTurn(role, content) {
    this.history.push({
      role,
      content,
      timestamp: Date.now()
    });
    if (role === 'assistant') {
      this.turns++;
    }
  }

  getRecentHistory(maxTurns = 8) {
    return this.history.slice(-maxTurns);
  }

  recordLatency(timings) {
    this.turnLatencies.push(timings);
    if (timings.total) {
      latencyRecords.push(timings.total);
      if (latencyRecords.length > 500) {
        latencyRecords.shift();
      }
    }
  }

  end(reason = 'normal_clearing') {
    this.endTime = Date.now();
    this.status = this.status === 'transferred' ? 'transferred' : 'completed';
    this.endReason = reason;
  }

  getMetrics() {
    const totalMs = this.turnLatencies.map(t => t.total || 0).sort((a, b) => a - b);
    const p50 = totalMs.length > 0 ? totalMs[Math.floor(totalMs.length * 0.5)] : 0;
    const p95 = totalMs.length > 0 ? totalMs[Math.floor(totalMs.length * 0.95)] : 0;

    return {
      duration_seconds: Math.round(((this.endTime || Date.now()) - this.startTime) / 1000),
      turn_count: this.turns,
      disposition: this.disposition,
      p50_latency_ms: p50,
      p95_latency_ms: p95
    };
  }
}

export function getOrCreateSession(callId, options = {}) {
  if (!sessions.has(callId)) {
    sessions.set(callId, new CallSession(callId, options));
  }
  return sessions.get(callId);
}

export function getSession(callId) {
  return sessions.get(callId);
}

export function deleteSession(callId) {
  return sessions.delete(callId);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

export function getGlobalLatencyMetrics() {
  if (latencyRecords.length === 0) {
    return { p50: 0, p95: 0, sample_count: 0 };
  }
  const sorted = [...latencyRecords].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
    sample_count: sorted.length
  };
}
