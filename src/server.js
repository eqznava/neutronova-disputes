'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const config = require('./config');
const tools = require('./paypal/tools');
const client = require('./paypal/client');
const mock = require('./paypal/mock');
const records = require('./records');
const agent = require('./agent/agent');
const prevent = require('./prevent');
const metrics = require('./metrics');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Optional basic auth for a public deployment (set DEMO_USER and DEMO_PASSWORD).
if (process.env.DEMO_USER && process.env.DEMO_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) return next();
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const [u, p] = Buffer.from(encoded || '', 'base64').toString().split(':');
    if (scheme === 'Basic' && u === process.env.DEMO_USER && p === process.env.DEMO_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="demo"').status(401).send('Authentication required');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/ag-grid', express.static(path.join(__dirname, '..', 'node_modules', 'ag-grid-community', 'dist')));

fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'].includes(file.mimetype)),
});

const analyses = new Map(); // disputeId -> last analysis
const auditLog = []; // actions sent to PayPal

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- server-sent events (webhook -> browser) ----------
const streams = new Set();
function broadcast(event, data) {
  for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
});

// ---------- helpers ----------
async function loadDisputes() {
  if (config.paypalMode === 'mock') return structuredClone(mock.getStore().disputes);
  const list = await tools.call('list_disputes', { page_size: 20 });
  if (list.error) {
    const err = new Error(`PayPal list_disputes failed: ${typeof list.error === 'string' ? list.error : list.error.message || JSON.stringify(list.error)}`);
    err.status = 502;
    throw err;
  }
  const items = list.items || [];
  const full = await Promise.all(items.map((d) => tools.call('get_dispute', { dispute_id: d.dispute_id })));
  return full.filter((d) => d && !d.error);
}

function rowFor(d) {
  const a = analyses.get(d.dispute_id);
  const due = d.seller_response_due_date ? new Date(d.seller_response_due_date) : null;
  return {
    id: d.dispute_id,
    reason: d.reason,
    status: d.status,
    amount: Number(d.dispute_amount?.value || 0),
    currency: d.dispute_amount?.currency_code || 'USD',
    buyer: d.disputed_transactions?.[0]?.buyer?.name || '',
    item: d.disputed_transactions?.[0]?.items?.[0]?.item_description || '',
    transactionId: d.disputed_transactions?.[0]?.seller_transaction_id || '',
    dueDate: due ? due.toISOString() : null,
    daysLeft: due ? Math.ceil((due - Date.now()) / 86_400_000) : null,
    needsResponse: (d.links || []).some((l) => l.rel === 'provide_evidence'),
    recommendation: a?.assessment.recommendation || null,
    completeness: a ? a.assessment.completeness : null,
    created: d.create_time,
  };
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({ appName: config.appName, paypalMode: config.paypalMode, aiMode: config.aiMode, model: config.aiMode === 'claude' ? config.anthropicModel : null });
});

app.get('/api/disputes', wrap(async (req, res) => {
  const rows = (await loadDisputes()).map(rowFor);
  rows.sort((a, b) => (b.needsResponse - a.needsResponse) || ((a.daysLeft ?? 999) - (b.daysLeft ?? 999)));
  res.json({ rows });
}));

app.get('/api/disputes/:id', wrap(async (req, res) => {
  const dispute = await tools.call('get_dispute', { dispute_id: req.params.id });
  if (dispute.error) return res.status(404).json(dispute);
  const txn = dispute.disputed_transactions?.[0]?.seller_transaction_id;
  res.json({ row: rowFor(dispute), dispute, records: records.get(txn), analysis: analyses.get(req.params.id) || null });
}));

app.post('/api/disputes/:id/analyze', wrap(async (req, res) => {
  const result = await agent.analyze(req.params.id);
  analyses.set(req.params.id, result);
  metrics.recordAgentRun(req.params.id, result.ms, result.assessment.completeness);
  res.json(result);
}));

app.post('/api/disputes/:id/records', wrap(async (req, res) => {
  const dispute = await tools.call('get_dispute', { dispute_id: req.params.id });
  const txn = dispute.disputed_transactions?.[0]?.seller_transaction_id;
  if (!txn) return res.status(404).json({ error: 'Dispute not found' });
  res.json(records.update(txn, req.body || {}));
}));

app.post('/api/disputes/:id/files', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, GIF or PDF up to 10 MB.' });
  const dispute = await tools.call('get_dispute', { dispute_id: req.params.id });
  const txn = dispute.disputed_transactions?.[0]?.seller_transaction_id;
  if (!txn) return res.status(404).json({ error: 'Dispute not found' });
  const kind = ['item_photo', 'package_photo', 'customer_approval', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
  res.json(records.addFile(txn, { ...req.file, kind }));
}));

// Human-in-the-loop: the seller must approve before anything is sent to PayPal.
app.post('/api/disputes/:id/submit', wrap(async (req, res) => {
  const { action, approved, note } = req.body || {};
  if (approved !== true) return res.status(400).json({ error: 'The seller must approve before anything is sent to PayPal.' });
  const analysis = analyses.get(req.params.id);
  if (!analysis) return res.status(400).json({ error: 'Run the agent on this dispute first.' });

  const dispute = await tools.call('get_dispute', { dispute_id: req.params.id });
  if (dispute.error) return res.status(404).json(dispute);
  const links = (dispute.links || []).map((l) => l.rel);

  let result;
  if (action === 'evidence') {
    if (!links.includes('provide_evidence')) return res.status(409).json({ error: 'PayPal is not accepting evidence for this dispute right now (no provide_evidence link).' });
    const text = String(note || analysis.response_note || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'The response note is empty.' });
    const type = analysis.assessment.evidence_type === 'PROOF_OF_REFUND' ? 'OTHER' : analysis.assessment.evidence_type;
    const evidence = { evidence_type: type, notes: text };
    if (type === 'PROOF_OF_FULFILLMENT') {
      if (!analysis.assessment.tracking_info.length) return res.status(400).json({ error: 'Proof of fulfillment needs a tracking number.' });
      evidence.evidence_info = { tracking_info: analysis.assessment.tracking_info };
    }
    const files = records.filePaths(analysis.facts.transactionId).filter((f) => fs.existsSync(f.path)).slice(0, 10);
    result = await tools.call('provide_dispute_evidence', { dispute_id: req.params.id, evidences: [evidence], files });
  } else if (action === 'accept') {
    if (!links.includes('accept_claim')) return res.status(409).json({ error: 'This dispute cannot be accepted right now (no accept_claim link).' });
    // The toolkit's note field allows only letters, digits, "-" and "_".
    const safeNote = String(note || 'Seller-accepts-claim-and-refunds-buyer').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 255) || 'Seller-accepts-claim';
    result = await tools.call('accept_dispute_claim', { dispute_id: req.params.id, note: safeNote });
  } else {
    return res.status(400).json({ error: 'action must be "evidence" or "accept".' });
  }

  if (result?.error) return res.status(502).json(result);
  const entry = { time: new Date().toISOString(), mode: config.paypalMode, disputeId: req.params.id, action, onTime: !analysis.facts.dueDate || new Date(analysis.facts.dueDate) > new Date() };
  auditLog.push(entry);
  metrics.recordSubmission(entry);
  broadcast('disputes-changed', { disputeId: req.params.id, reason: action });
  res.json({ ok: true, result, entry });
}));

app.get('/api/orders', wrap(async (req, res) => {
  const orders = mock.getStore().orders.map((o) => ({ ...o, check: prevent.checkOrder(o) }));
  res.json({ orders, note: 'Demo orders. Connect your store or order system to check real orders before shipping.' });
}));

app.post('/api/prevent/check', (req, res) => res.json(prevent.checkOrder(req.body || {})));

app.post('/api/orders/:id/tracking', wrap(async (req, res) => {
  const { transaction_id, tracking_number, carrier } = req.body || {};
  if (!transaction_id || !tracking_number) return res.status(400).json({ error: 'transaction_id and tracking_number are required.' });
  const result = await tools.call('create_shipment_tracking', { transaction_id, tracking_number, carrier: carrier || 'USPS', status: 'SHIPPED' });
  if (result?.error) return res.status(502).json(result);
  const order = mock.getStore().orders.find((o) => o.order_id === req.params.id);
  if (order) order.plan.tracking = true;
  res.json({ ok: true, result });
}));

app.get('/api/metrics', wrap(async (req, res) => {
  const rows = (await loadDisputes()).map(rowFor);
  res.json({ ...metrics.summary(rows), ai: config.aiMode === 'claude' ? agent.getUsage() : null });
}));

app.post('/api/metrics/manual', (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return res.status(400).json({ error: 'minutes must be between 0 and 600' });
  res.json(metrics.recordManualTrial(String(req.body?.dispute_id || ''), minutes));
});

app.get('/api/audit', (req, res) => res.json({ entries: auditLog.filter((e) => e.mode === config.paypalMode).slice(-50).reverse() }));

// ---------- webhooks ----------
const DISPUTE_EVENTS = new Set(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED']);

app.post('/webhooks/paypal', wrap(async (req, res) => {
  const event = req.body || {};
  if (config.paypalMode === 'sandbox') {
    const valid = await client.verifyWebhook(req.headers, event).catch(() => false);
    if (!valid) return res.status(400).json({ error: 'Webhook signature could not be verified.' });
  }
  if (DISPUTE_EVENTS.has(event.event_type)) {
    broadcast('disputes-changed', { event: event.event_type, disputeId: event.resource?.dispute_id });
  }
  res.json({ received: true });
}));

// Demo helpers (mock mode only): simulate the webhook PayPal sends for a new dispute.
app.post('/api/demo/simulate-dispute', (req, res) => {
  if (config.paypalMode !== 'mock') return res.status(400).json({ error: 'Only available in mock mode.' });
  const d = mock.addSimulatedDispute();
  broadcast('disputes-changed', { event: 'CUSTOMER.DISPUTE.CREATED', disputeId: d.dispute_id, simulated: true });
  res.json({ ok: true, dispute_id: d.dispute_id });
});

app.post('/api/demo/reset', (req, res) => {
  if (config.paypalMode !== 'mock') return res.status(400).json({ error: 'Only available in mock mode.' });
  mock.reset(); analyses.clear(); auditLog.length = 0; metrics.reset();
  broadcast('disputes-changed', { reset: true });
  res.json({ ok: true });
});

// ---------- errors ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message, details: err.details });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`${config.appName} running on http://localhost:${config.port}`);
    console.log(`PayPal: ${config.paypalMode} | AI: ${config.aiMode}${config.aiMode === 'claude' ? ` (${config.anthropicModel})` : ' (no ANTHROPIC_API_KEY, using the rules engine)'}`);
  });
}

module.exports = app;
