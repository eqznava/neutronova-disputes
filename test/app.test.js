'use strict';

// Runs in mock mode with the rules engine (no keys needed).
process.env.PAYPAL_MODE = 'mock';
process.env.ANTHROPIC_API_KEY = '';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const agent = require('../src/agent/agent');
const prevent = require('../src/prevent');
const tools = require('../src/paypal/tools');
const mock = require('../src/paypal/mock');
const app = require('../src/server');

test('agent tool definitions come from the PayPal Agent Toolkit plus our seller-records tool', () => {
  const names = tools.agentToolDefinitions().map((t) => t.name);
  assert.deepEqual(names, ['get_dispute', 'list_transactions', 'get_shipment_tracking', 'get_seller_records']);
  for (const t of tools.agentToolDefinitions()) assert.equal(t.input_schema.$schema, undefined);
});

test('delivered to the ship-to address with tracking -> respond with evidence', async () => {
  mock.reset();
  const r = await agent.analyze('PP-D-1001');
  assert.equal(r.assessment.recommendation, 'FIGHT');
  assert.equal(r.assessment.evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.equal(r.assessment.tracking_info[0].tracking_number, '9400111899223344556677');
  assert.ok(r.response_note.includes('9400111899223344556677'));
});

test('no tracking on a not-received claim -> refund', async () => {
  mock.reset();
  const r = await agent.analyze('PP-D-1002');
  assert.equal(r.assessment.recommendation, 'REFUND');
  assert.equal(r.response_note, '');
});

test('delivered to a different ZIP -> refund, never fight', async () => {
  mock.reset();
  const r = await agent.analyze('PP-D-1004');
  assert.equal(r.assessment.recommendation, 'REFUND');
  assert.ok(r.assessment.blockers[0].includes('Milwaukee'));
});

test('not as described with listing and photos -> evidence type OTHER', async () => {
  mock.reset();
  const r = await agent.analyze('PP-D-1003');
  assert.equal(r.assessment.recommendation, 'FIGHT');
  assert.equal(r.assessment.evidence_type, 'OTHER');
});

test('prevent flags a missing street number, ZIP and tracking', () => {
  const r = prevent.checkOrder({ order_id: 'X', amount: 40, paid_days_ago: 1, ship_to: { line1: 'Oak Street', city: 'Newark', state: 'NJ', postal_code: '', country: 'US' }, plan: { tracking: false, item_photos: true, return_address: true } });
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes('NO_STREET_NUMBER'));
  assert.ok(codes.includes('BAD_POSTAL_CODE'));
  assert.ok(codes.includes('NO_TRACKING'));
  assert.equal(r.risk, 'high');
});

test('prevent passes a clean order', () => {
  const addr = { line1: '17 Garden Pl', city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US' };
  const r = prevent.checkOrder({ order_id: 'Y', amount: 28, paid_days_ago: 0, ship_to: addr, paypal_ship_to: addr, plan: { tracking: true, item_photos: true, return_address: true } });
  assert.equal(r.risk, 'low');
});

test('server refuses to send anything without approval, then sends with approval', async (t) => {
  mock.reset();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  assert.equal((await post('/api/disputes/PP-D-1001/submit', { action: 'evidence', approved: true })).status, 400); // agent not run yet
  assert.equal((await post('/api/disputes/PP-D-1001/analyze')).status, 200);
  assert.equal((await post('/api/disputes/PP-D-1001/submit', { action: 'evidence' })).status, 400); // not approved
  const ok = await post('/api/disputes/PP-D-1001/submit', { action: 'evidence', approved: true });
  assert.equal(ok.status, 200);
  const again = await post('/api/disputes/PP-D-1001/submit', { action: 'evidence', approved: true });
  assert.equal(again.status, 409); // PayPal no longer accepts evidence
});

test('Claude path: tool loop runs, and the guardrail blocks a FIGHT the evidence cannot support', async (t) => {
  mock.reset();
  const config = require('../src/config');
  const sdkPath = require.resolve('@anthropic-ai/sdk');
  const original = require.cache[sdkPath];
  let call = 0;
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async () => {
          call += 1;
          if (call === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'get_dispute', input: { dispute_id: 'PP-D-1004' } }] };
          return { content: [{ type: 'tool_use', id: 't2', name: 'record_case_assessment', input: { recommendation: 'FIGHT', summary: 'Looks winnable.', response_note: 'Delivered.' } }] };
        },
      };
    }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: { default: FakeAnthropic } };
  const saved = { aiMode: config.aiMode, key: config.anthropicApiKey, style: config.agentStyle };
  config.aiMode = 'claude'; config.anthropicApiKey = 'test'; config.agentStyle = 'agent';
  t.after(() => { config.aiMode = saved.aiMode; config.anthropicApiKey = saved.key; config.agentStyle = saved.style; if (original) require.cache[sdkPath] = original; else delete require.cache[sdkPath]; });

  const r = await agent.analyze('PP-D-1004');
  assert.equal(r.mode, 'claude');
  assert.equal(r.steps[0].origin, 'agent');
  assert.equal(r.assessment.recommendation, 'REFUND');
  assert.equal(r.guardrails.length, 1);
});

test('economy mode: one AI call per case, reused for the same facts, skipped when the rules already say refund', async (t) => {
  mock.reset();
  const config = require('../src/config');
  const sdkPath = require.resolve('@anthropic-ai/sdk');
  const original = require.cache[sdkPath];
  let calls = 0;
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async (req) => {
        calls += 1;
        assert.equal(req.tool_choice.name, 'record_case_assessment');
        return { usage: { input_tokens: 900, output_tokens: 150 }, content: [{ type: 'tool_use', id: 'x', name: 'record_case_assessment', input: { recommendation: 'FIGHT', summary: 'Strong case.', response_note: 'Delivered to the PayPal address.' } }] };
      } };
    }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: { default: FakeAnthropic } };
  const saved = { aiMode: config.aiMode, key: config.anthropicApiKey, style: config.agentStyle };
  config.aiMode = 'claude'; config.anthropicApiKey = 'test'; config.agentStyle = 'economy';
  t.after(() => { config.aiMode = saved.aiMode; config.anthropicApiKey = saved.key; config.agentStyle = saved.style; if (original) require.cache[sdkPath] = original; else delete require.cache[sdkPath]; });

  const first = await agent.analyze('PP-D-1001');
  assert.equal(first.mode, 'claude');
  assert.equal(calls, 1);
  const second = await agent.analyze('PP-D-1001');
  assert.equal(calls, 1, 'same facts must not be paid twice');
  assert.ok(second.aiSkipped.includes('reused'));
  const refund = await agent.analyze('PP-D-1004');
  assert.equal(calls, 1, 'a case the rules already mark as refund needs no AI call');
  assert.equal(refund.assessment.recommendation, 'REFUND');
  assert.ok(agent.getUsage().inputTokens >= 900);
});
