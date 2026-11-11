'use strict';

// One tool layer for the agent and the server.
// Tool definitions come from the PayPal Agent Toolkit. In "sandbox" mode calls go
// to PayPal through the toolkit; in "mock" mode the same tools answer from mock.js.
// Two tools are our own because the toolkit does not include them:
// get_seller_records (the seller's own proof) and provide_dispute_evidence (Disputes API).

const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');
const config = require('../config');
const mock = require('./mock');
const client = require('./client');
const records = require('../records');

const TOOLKIT_ACTIONS = {
  disputes: { list: true, get: true, create: true }, // "create" exposes accept_dispute_claim
  shipment: { create: true, get: true },
  transactions: { list: true },
};

// The toolkit only builds tool definitions in its constructor, so in mock mode
// placeholder credentials are enough to read the schemas. No network call is made.
const toolkit = new PayPalAgentToolkit({
  clientId: config.paypalClientId || 'mock-client-id',
  clientSecret: config.paypalClientSecret || 'mock-client-secret',
  configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } },
});

const toolkitTools = Object.fromEntries(toolkit.getTools().map((t) => [t.function.name, t.function]));

// Clean JSON Schemas so every model provider accepts them.
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if (k === 'anyOf' && Array.isArray(v)) {
      const kept = v.filter((s) => !(s && s.not && Object.keys(s.not).length === 0));
      if (kept.length === 1) { Object.assign(out, cleanSchema(kept[0])); continue; }
      out.anyOf = cleanSchema(kept);
      continue;
    }
    out[k] = cleanSchema(v);
  }
  return out;
}

// Read-only tools the agent may call on its own while investigating.
const AGENT_TOOL_NAMES = ['get_dispute', 'list_transactions', 'get_shipment_tracking'];

const customTools = {
  get_seller_records: {
    name: 'get_seller_records',
    description: 'Get the records the seller keeps outside PayPal for a transaction: listing text, uploaded files (photos, proofs, approvals), messages with the buyer, and return policy. Use it to find evidence PayPal does not have.',
    parameters: {
      type: 'object',
      properties: { transaction_id: { type: 'string', description: 'The seller transaction ID from the dispute.' } },
      required: ['transaction_id'],
      additionalProperties: false,
    },
  },
};

function agentToolDefinitions() {
  const defs = AGENT_TOOL_NAMES.map((n) => toolkitTools[n]).concat(Object.values(customTools));
  return defs.map((f) => ({ name: f.name, description: f.description.trim(), input_schema: cleanSchema(f.parameters) }));
}

// ---------- execution ----------

async function callToolkit(name, args) {
  const result = await toolkit.handleToolCall({
    id: `call_${Date.now()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  });
  const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  try { return JSON.parse(content); } catch { return { result: content }; }
}

const mockHandlers = {
  list_disputes(args = {}) {
    let items = mock.getStore().disputes;
    if (args.dispute_state) items = items.filter((d) => d.dispute_state === args.dispute_state);
    if (args.disputed_transaction_id) items = items.filter((d) => d.disputed_transactions[0].seller_transaction_id === args.disputed_transaction_id);
    return { items: items.map(summaryOf) };
  },
  get_dispute({ dispute_id }) {
    const d = mock.getStore().disputes.find((x) => x.dispute_id === dispute_id);
    if (!d) return { error: `Dispute ${dispute_id} not found` };
    return structuredClone(d);
  },
  list_transactions({ transaction_id } = {}) {
    const all = mock.getStore().transactions;
    if (transaction_id) {
      const t = all[transaction_id];
      return t ? { transaction_details: [mockTxnDetails(t)] } : { transaction_details: [] };
    }
    return { transaction_details: Object.values(all).map(mockTxnDetails) };
  },
  get_shipment_tracking({ transaction_id }) {
    const t = mock.getStore().tracking[transaction_id];
    if (!t) return { trackers: [], note: 'No tracking was added to PayPal for this transaction.' };
    return { trackers: [{ transaction_id, ...structuredClone(t) }] };
  },
  accept_dispute_claim({ dispute_id, note }) {
    const d = mock.getStore().disputes.find((x) => x.dispute_id === dispute_id);
    if (!d) return { error: `Dispute ${dispute_id} not found` };
    d.status = 'RESOLVED';
    d.dispute_state = 'RESOLVED';
    d.dispute_outcome = { outcome_code: 'RESOLVED_BUYER_FAVOUR', note };
    d.links = mock.disputeLinks(d.dispute_id, d.status);
    d.update_time = new Date().toISOString();
    return { links: [{ rel: 'self', href: `/v1/customer/disputes/${dispute_id}` }] };
  },
  create_shipment_tracking({ transaction_id, tracking_number, carrier, status = 'SHIPPED' }) {
    mock.getStore().tracking[transaction_id] = { carrier: carrier || 'OTHER', tracking_number, status };
    return { tracker_identifiers: [{ transaction_id, tracking_number }] };
  },
};

function mockTxnDetails(t) {
  return {
    transaction_info: { transaction_id: t.transaction_id, paypal_reference_id: t.order_id, transaction_initiation_date: t.date, transaction_amount: { currency_code: 'USD', value: t.amount }, transaction_status: 'S' },
    shipping_info: { address: t.shipping_address },
  };
}

function summaryOf(d) {
  return {
    dispute_id: d.dispute_id, reason: d.reason, status: d.status, dispute_state: d.dispute_state,
    dispute_amount: d.dispute_amount, create_time: d.create_time, update_time: d.update_time,
    dispute_life_cycle_stage: d.dispute_life_cycle_stage,
  };
}

// Our own tool: evidence the seller holds.
async function getSellerRecords({ transaction_id }) {
  return records.get(transaction_id) || { listing: null, files: [], messages: [], return_policy: null };
}

// Our own tool: Disputes API provide-evidence. Only called after the seller approves.
async function provideDisputeEvidence({ dispute_id, evidences, files = [] }) {
  if (config.paypalMode === 'mock') {
    const d = mock.getStore().disputes.find((x) => x.dispute_id === dispute_id);
    if (!d) return { error: `Dispute ${dispute_id} not found` };
    if (!d.links.some((l) => l.rel === 'provide_evidence')) return { error: 'PayPal is not accepting evidence for this dispute right now.' };
    d.status = 'UNDER_REVIEW';
    d.dispute_state = 'UNDER_PAYPAL_REVIEW';
    d.links = mock.disputeLinks(d.dispute_id, d.status);
    d.update_time = new Date().toISOString();
    d.evidence_submitted = { evidences, files: files.map((f) => f.originalname) };
    return { links: [{ rel: 'self', href: `/v1/customer/disputes/${dispute_id}` }] };
  }
  return client.provideEvidence(dispute_id, evidences, files);
}

async function call(name, args) {
  if (name === 'get_seller_records') return getSellerRecords(args);
  if (name === 'provide_dispute_evidence') return provideDisputeEvidence(args);
  if (!toolkitTools[name]) throw new Error(`Unknown tool: ${name}`);
  if (config.paypalMode === 'mock') return mockHandlers[name](args || {});
  return callToolkit(name, args);
}

module.exports = { call, agentToolDefinitions, toolkitToolNames: Object.keys(toolkitTools), cleanSchema };
