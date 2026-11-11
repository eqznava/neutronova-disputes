'use strict';

// Thin REST client for the PayPal Sandbox calls the Agent Toolkit does not cover:
// providing dispute evidence and verifying webhook signatures.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  const res = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function request(method, urlPath, { json, form } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // fetch sets the multipart boundary
  const res = await fetch(`${config.paypalBaseUrl}${urlPath}`, { method, headers, body });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${urlPath} failed (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// POST /v1/customer/disputes/{id}/provide-evidence
// multipart: part "input" (JSON with an evidences[] array) + one part per file.
async function provideEvidence(disputeId, evidences, files = []) {
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({ evidences })], { type: 'application/json' }));
  files.forEach((f, i) => {
    const buf = fs.readFileSync(f.path);
    form.append(`file${i + 1}`, new Blob([buf], { type: f.mimetype }), path.basename(f.originalname || f.path));
  });
  return request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, { form });
}

// POST /v1/notifications/verify-webhook-signature
async function verifyWebhook(headers, event) {
  if (!config.paypalWebhookId) return false;
  const data = await request('POST', '/v1/notifications/verify-webhook-signature', {
    json: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypalWebhookId,
      webhook_event: event,
    },
  });
  return data.verification_status === 'SUCCESS';
}

module.exports = { getAccessToken, request, provideEvidence, verifyWebhook };
