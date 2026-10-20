import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: true });

function getGeminiKey() {
  const k = process.env.GEMINI_API_KEY || '';
  if (k && k !== 'MY_GEMINI_API_KEY' && k.length > 20) {
    return k;
  }
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/GEMINI_API_KEY=([^\r\n]+)/);
      if (match && match[1] && match[1].length > 20 && match[1] !== 'MY_GEMINI_API_KEY') {
        return match[1].trim();
      }
    }
  } catch (e) {}
  return k;
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ENV: process.env.NODE_ENV || 'development',

  // Providers & Keys
  GEMINI_API_KEY: getGeminiKey(),
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',

  // Fallback Models Chain
  GEMINI_MODELS: [
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite'
  ],
  GROQ_MODELS: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b'
  ],

  // Timeouts (ms)
  TIMEOUTS: {
    LLM_PER_PROVIDER: 9000,
    ASR_GEMINI: 9000,
    TTS_EDGE: 1500,
    TOTAL_BUDGET: 1500
  },

  // Audio configuration
  AUDIO: {
    CACHE_DIR: path.join(ROOT_DIR, 'audio_cache'),
    TEMP_DIR: path.join(os.tmpdir(), 'ai-call-assistant-temp'),
    DEFAULT_OUTPUT_FORMAT: 'mp3', // 'mp3' | 'wav' | 'mulaw_8k'
    DEFAULT_VOICE: 'en-US-JennyNeural',
    SAMPLE_RATE: 16000
  },

  // Directory of PBX Extensions for Call Transfers
  EXTENSIONS: [
    {
      id: '101',
      name: 'General Customer Support',
      dept: 'Customer Support',
      sip: 'sip:101@pbx.local',
      phone: '+18005550101',
      keywords: ['support', 'general', 'help', 'representative', 'agent', 'person', 'human']
    },
    {
      id: '102',
      name: 'Billing & Payments',
      dept: 'Billing & Accounting',
      sip: 'sip:102@pbx.local',
      phone: '+18005550102',
      keywords: ['bill', 'billing', 'payment', 'pay', 'invoice', 'charge', 'due', 'balance', 'refund']
    },
    {
      id: '103',
      name: 'Technical Support Escalations',
      dept: 'Technical Services',
      sip: 'sip:103@pbx.local',
      phone: '+18005550103',
      keywords: ['technical', 'tech', 'broken', 'error', 'bug', 'device', 'hardware', 'troubleshoot', 'offline']
    },
    {
      id: '104',
      name: 'Sales & New Accounts',
      dept: 'Sales',
      sip: 'sip:104@pbx.local',
      phone: '+18005550104',
      keywords: ['sales', 'buy', 'purchase', 'new account', 'pricing', 'quote', 'upgrade', 'order', 'deal']
    },
    {
      id: '200',
      name: 'Human Supervisor / Tier 2 Escalation',
      dept: 'Executive Escalations',
      sip: 'sip:200@pbx.local',
      phone: '+18005550200',
      keywords: ['supervisor', 'manager', 'escalate', 'tier 2', 'complaint', 'dispute', 'angry', 'unacceptable']
    }
  ],

  // Production Campaigns with realistic persona, goals, dos/don'ts, and FAQ snippets
  CAMPAIGNS: {
    support: {
      id: 'support',
      name: 'General Customer Care',
      persona: 'Alex, Senior Customer Care Voice Specialist',
      goal: 'Resolve customer questions efficiently, accurately, and courteously, transferring to specialist departments when required.',
      language: 'en',
      greeting: 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. What can I help you with today?',
      faqSnippet: `
        - Return Policy: Full refund within 30 days with receipt, or store credit if receipt is missing.
        - Support Hours: 24/7 automated line; live specialist extensions available Monday-Friday 9 AM - 6 PM EST.
        - Account Verification: Verify with last 4 digits of phone number or order number.
      `,
      dos: [
        'Give clear, factual answers in 1-2 spoken sentences (max 25-30 words).',
        'Speak in natural, warm spoken English.',
        'Admit you are an automated AI agent if asked directly.'
      ],
      donts: [
        'Do not use emojis, markdown, bullet points, or code blocks.',
        'Do not give answers longer than 3 sentences.',
        'Do not invent fictional tracking numbers or personal details.'
      ]
    },
    billing: {
      id: 'billing',
      name: 'Billing & Invoice Inquiries',
      persona: 'Jordan, Billing Services Specialist',
      goal: 'Assist callers with balances, payment methods, due dates, and receipts.',
      language: 'en',
      greeting: 'Thank you for calling Billing and Accounts. I am Jordan, your virtual billing assistant. How can I help with your account today?',
      faqSnippet: `
        - Due Dates: Invoices are net-30 days from billing date.
        - Accepted Payment: Visa, MasterCard, Amex, ACH bank transfer, and online portal.
        - Late Fees: $15 fee applied after a 7-day grace period.
      `,
      dos: [
        'Prompt for invoice or account number if needed.',
        'Transfer to Extension 102 if caller disputes a charge or wants manual processing.'
      ],
      donts: [
        'Never ask for or store full credit card numbers or CVV.'
      ]
    },
    sales: {
      id: 'sales',
      name: 'Inbound Sales & Solutions',
      persona: 'Morgan, Solutions Advisor',
      goal: 'Qualify inbound caller interest, provide high-level pricing, and connect to a sales executive.',
      language: 'en',
      greeting: 'Thanks for calling Sales. I am Morgan, your AI solutions advisor. Are you looking to start a new service or upgrade an existing plan?',
      faqSnippet: `
        - Starter Plan: $29/month per seat, unlimited voice calls.
        - Pro Plan: $79/month per seat with dedicated dialer CRM integration.
        - Enterprise: Custom SLA with multi-trunk PBX routing.
      `,
      dos: [
        'Highlight the core benefits and offer connection to Extension 104 for a live quote.'
      ],
      donts: [
        'Do not hard-sell or press callers.'
      ]
    }
  }
};

export function getCampaign(campaignId) {
  return CONFIG.CAMPAIGNS[campaignId] || CONFIG.CAMPAIGNS.support;
}
