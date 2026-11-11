'use strict';

require('dotenv').config({ quiet: true });

const hasPayPal = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

const config = {
  appName: process.env.APP_NAME || 'Neutronova Disputes',
  port: Number(process.env.PORT || 3000),

  // "mock" runs entirely on simulated data. "sandbox" talks to the PayPal Sandbox.
  // Live (production) mode is intentionally not supported in this project.
  paypalMode: process.env.PAYPAL_MODE || (hasPayPal ? 'sandbox' : 'mock'),
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  paypalBaseUrl: 'https://api-m.sandbox.paypal.com',

  // AI. Without a key the agent runs a deterministic rules engine with the same tools.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', // cheapest model by default
  // "economy": one AI call per case, only when needed. "agent": full tool-use loop (more calls).
  agentStyle: process.env.AGENT_STYLE === 'agent' ? 'agent' : 'economy',
  aiMaxCallsPerDay: Number(process.env.AI_MAX_CALLS_PER_DAY || 25),

  // Prevent mode: orders at or above this value get a signature-confirmation warning.
  signatureThreshold: Number(process.env.SIGNATURE_THRESHOLD || 750),

  uploadDir: process.env.UPLOAD_DIR || 'data/uploads',
  maxUploadBytes: 10 * 1024 * 1024,
};

if (!['mock', 'sandbox'].includes(config.paypalMode)) {
  throw new Error(`PAYPAL_MODE must be "mock" or "sandbox" (got "${config.paypalMode}").`);
}
if (config.paypalMode === 'sandbox' && !hasPayPal) {
  throw new Error('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
}

config.aiMode = config.anthropicApiKey ? 'claude' : 'rules';

module.exports = config;
