'use strict';

// The dispute agent. The app always gathers the data with the PayPal Agent Toolkit
// tools (free), then decides whether an AI call is worth paying for:
// - "economy" style (default): ONE Claude call with the gathered facts, only when the
//   rules engine cannot settle the case alone, never twice for the same facts, and
//   never past the daily cap (AI_MAX_CALLS_PER_DAY).
// - "agent" style: a full Claude tool-use loop (several calls). Use it for the demo video.
// Without a key, or when skipped, the rules engine writes the result. Either way:
// - it only reads data on its own (no money moves during analysis);
// - the evidence checklist is computed by code from tool results (guardrail);
// - nothing is sent to PayPal until the seller approves (see server.js).

const config = require('../config');
const tools = require('../paypal/tools');
const playbook = require('./playbook');

const TOOLKIT = new Set(tools.toolkitToolNames);

const FINAL_TOOL = {
  name: 'record_case_assessment',
  description: 'Record your final assessment of the dispute. Call this exactly once, after you have gathered the evidence.',
  input_schema: {
    type: 'object',
    properties: {
      recommendation: { type: 'string', enum: ['FIGHT', 'NEED_INFO', 'REFUND'], description: 'FIGHT = respond with evidence now. NEED_INFO = ask the seller for specific missing proof first. REFUND = accept the claim; the evidence cannot support a defense.' },
      summary: { type: 'string', description: 'Two or three plain sentences for the seller: what happened, how strong the case is, and what to do next.' },
      response_note: { type: 'string', maxLength: 2000, description: 'The note to send to PayPal with the evidence. Factual, polite, in English, only facts returned by the tools. Empty if recommendation is REFUND.' },
    },
    required: ['recommendation', 'summary', 'response_note'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You help a small online seller respond to a PayPal dispute.
Investigate with the tools, then call record_case_assessment once.

Steps: get_dispute for the reason, amount, deadline and the seller transaction ID; list_transactions with that transaction_id for the PayPal ship-to address; get_shipment_tracking with that transaction_id; get_seller_records with that transaction_id.

What PayPal needs:
- Item not received: online verifiable tracking, "delivered" status with date, and a delivery address that matches the PayPal ship-to address (city/state or ZIP). Evidence type PROOF_OF_FULFILLMENT.
- Not as described: the original listing, photos taken before shipping, buyer messages, the return policy. Evidence type OTHER (notes and documents).
- Unauthorized: proof of delivery to the PayPal ship-to address, signature if any, proof the account holder interacted with the order.

Rules:
- Use only facts the tools returned. Never invent, guess or embellish evidence, dates, tracking numbers or quotes.
- If delivery went to a different address, or there is no tracking for a non-delivery claim, recommend REFUND and say so plainly.
- If a key proof exists but is not uploaded yet, recommend NEED_INFO and say exactly what to upload.
- The seller reviews and approves everything before it is sent. Write the response note for PayPal, not for the seller.`;

async function traced(steps, name, args, origin) {
  const t0 = Date.now();
  try {
    const result = await tools.call(name, args);
    steps.push({ tool: name, source: TOOLKIT.has(name) ? 'PayPal Agent Toolkit' : 'Custom tool', args, ms: Date.now() - t0, ok: !result?.error, origin });
    return result;
  } catch (err) {
    steps.push({ tool: name, source: TOOLKIT.has(name) ? 'PayPal Agent Toolkit' : 'Custom tool', args, ms: Date.now() - t0, ok: false, error: err.message, origin });
    return { error: err.message, details: err.details };
  }
}

// Gathers any data the model did not fetch, so the guardrail always has facts.
async function gather(steps, disputeId, cache, origin = 'verification') {
  cache.dispute ||= await traced(steps, 'get_dispute', { dispute_id: disputeId }, origin);
  if (cache.dispute?.error) throw new Error(`Could not load dispute ${disputeId}: ${cache.dispute.error}`);
  const txn = cache.dispute.disputed_transactions?.[0]?.seller_transaction_id;
  if (txn) {
    cache.transactions ||= await traced(steps, 'list_transactions', { transaction_id: txn }, origin);
    cache.tracking ||= await traced(steps, 'get_shipment_tracking', { transaction_id: txn }, origin);
    cache.records ||= await traced(steps, 'get_seller_records', { transaction_id: txn }, origin);
  }
  return cache;
}

function rulesSummary(facts, a) {
  const label = facts.reasonLabel.toLowerCase();
  if (a.recommendation === 'REFUND') return `This ${label} claim is hard to defend: ${a.blockers.join(' ')} Refunding now avoids a lost claim on top of the refund.`;
  if (a.recommendation === 'NEED_INFO') return `This ${label} case can be defended, but proof is missing: ${a.missing_from_seller.join('; ')}. Upload it before the deadline, then approve the response.`;
  return `${a.strength === 'strong' ? 'Strong' : 'Solid'} case. The evidence covers what PayPal needs for this ${label} claim${a.missing_from_seller.length ? `; optional extras: ${a.missing_from_seller.join('; ')}` : ''}. Review the response and approve to send it.`;
}

const ECONOMY_PROMPT = `You help a small online seller respond to a PayPal dispute.
You get facts gathered from PayPal and the seller's records, plus a checklist computed by code.
Call record_case_assessment once. Use only the facts given; never invent evidence, dates, tracking numbers or quotes.
Be at least as cautious as the checklist's recommendation. Keep the summary to 2-3 sentences and the response note under 900 characters, in English, written for PayPal.`;

// Compact facts for the single economy call (fewer tokens = lower cost).
function compactFacts(facts, assessment) {
  return JSON.stringify({
    reason: facts.reasonLabel, amount: `${facts.amount} ${facts.currency}`, item: facts.item, buyer_says: facts.buyerMessage,
    ship_to: facts.shipTo ? `${facts.shipTo.city}, ${facts.shipTo.state || facts.shipTo.admin_area_1} ${facts.shipTo.postal_code || ''}`.trim() : null,
    tracking: facts.tracker, delivery_confirmation: facts.delivery, listing: facts.listing,
    files: facts.allFiles.map((f) => `${f.name} (${f.kind})`), buyer_messages: facts.messages, return_policy: facts.returnPolicy,
    checklist: assessment.checklist.map((c) => `${c.status === 'have' ? 'HAVE' : 'MISSING'}${c.required ? ' (required)' : ''}: ${c.label} - ${c.detail}`),
    rules_recommendation: assessment.recommendation,
  });
}

const aiCache = new Map(); // hash of facts -> AI result (same facts never paid twice)
const usage = { day: '', calls: 0, inputTokens: 0, outputTokens: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function budgetLeft() {
  if (usage.day !== today()) Object.assign(usage, { day: today(), calls: 0, inputTokens: 0, outputTokens: 0 });
  return config.aiMaxCallsPerDay - usage.calls;
}
function countUsage(res) {
  usage.calls += 1;
  usage.inputTokens += res?.usage?.input_tokens || 0;
  usage.outputTokens += res?.usage?.output_tokens || 0;
}
function getUsage() { budgetLeft(); return { ...usage, cap: config.aiMaxCallsPerDay, model: config.anthropicModel, style: config.agentStyle }; }

function client() {
  const Anthropic = require('@anthropic-ai/sdk').default;
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

async function runEconomy(facts, assessment) {
  const res = await client().messages.create({
    model: config.anthropicModel, max_tokens: 600, system: ECONOMY_PROMPT,
    tools: [FINAL_TOOL], tool_choice: { type: 'tool', name: FINAL_TOOL.name },
    messages: [{ role: 'user', content: compactFacts(facts, assessment) }],
  });
  countUsage(res);
  return res.content.find((b) => b.type === 'tool_use' && b.name === FINAL_TOOL.name)?.input || null;
}

async function runClaude(steps, disputeId, cache) {
  const anthropic = client();
  const toolDefs = [...tools.agentToolDefinitions(), FINAL_TOOL];
  const messages = [{ role: 'user', content: `Assess PayPal dispute ${disputeId}.` }];

  for (let turn = 0; turn < 6 && budgetLeft() > 0; turn++) {
    const res = await anthropic.messages.create({
      model: config.anthropicModel, max_tokens: 900, system: SYSTEM_PROMPT, tools: toolDefs, messages,
    });
    countUsage(res);
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;

    const results = [];
    for (const use of uses) {
      if (use.name === FINAL_TOOL.name) return use.input;
      const out = await traced(steps, use.name, use.input, 'agent');
      if (use.name === 'get_dispute' && !out.error) cache.dispute = out;
      if (use.name === 'list_transactions' && !out.error) cache.transactions = out;
      if (use.name === 'get_shipment_tracking' && !out.error) cache.tracking = out;
      if (use.name === 'get_seller_records' && !out.error) cache.records = out;
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out).slice(0, 6000), is_error: Boolean(out?.error) });
    }
    messages.push({ role: 'user', content: results });
  }
  return null;
}

const ORDER = { FIGHT: 0, NEED_INFO: 1, REFUND: 2 };

async function analyze(disputeId) {
  const t0 = Date.now();
  const steps = [];
  const cache = {};
  let ai = null; let aiError = null; let aiSkipped = null;
  const fullAgent = config.aiMode === 'claude' && config.agentStyle === 'agent' && budgetLeft() > 0;

  if (fullAgent) {
    try { ai = await runClaude(steps, disputeId, cache); } catch (err) { aiError = err.message; }
  }
  await gather(steps, disputeId, cache, fullAgent ? 'verification' : 'app');

  const facts = playbook.extractFacts({ dispute: cache.dispute, transactions: cache.transactions, tracking: cache.tracking, records: cache.records });
  const assessment = playbook.assess(facts);
  const guardrails = [];

  if (config.aiMode === 'claude' && !fullAgent && !aiError) {
    const key = require('node:crypto').createHash('sha256').update(compactFacts(facts, assessment)).digest('hex');
    if (aiCache.has(key)) { ai = aiCache.get(key); aiSkipped = 'Same facts as before: reused the earlier AI answer (no cost).'; }
    else if (assessment.recommendation === 'REFUND') aiSkipped = 'The evidence cannot win this case, so no AI call was needed (no cost).';
    else if (budgetLeft() <= 0) aiSkipped = `Daily AI limit reached (${config.aiMaxCallsPerDay} calls). Used the rules engine (no cost).`;
    else {
      try { ai = await runEconomy(facts, assessment); if (ai) aiCache.set(key, ai); } catch (err) { aiError = err.message; }
    }
  }

  let recommendation = assessment.recommendation;
  let summary = rulesSummary(facts, assessment);
  let responseNote = playbook.draftNote(facts, assessment);

  if (ai) {
    // The model may be more cautious than the rules, never less.
    if (ORDER[ai.recommendation] >= ORDER[assessment.recommendation]) recommendation = ai.recommendation;
    else guardrails.push(`The AI suggested ${ai.recommendation}, but the evidence on file supports only ${assessment.recommendation}.`);
    summary = ai.summary || summary;
    if (ai.response_note) responseNote = ai.response_note.slice(0, 2000);
  }

  return {
    disputeId,
    mode: ai ? 'claude' : 'rules',
    aiError,
    aiSkipped,
    ms: Date.now() - t0,
    steps,
    facts: {
      reason: facts.reason, reasonLabel: facts.reasonLabel, status: facts.status, amount: facts.amount, currency: facts.currency,
      dueDate: facts.dueDate, buyer: facts.buyer, item: facts.item, buyerMessage: facts.buyerMessage, transactionId: facts.transactionId,
      canProvideEvidence: facts.canProvideEvidence, canAcceptClaim: facts.canAcceptClaim,
    },
    assessment: { ...assessment, recommendation },
    summary,
    response_note: recommendation === 'REFUND' ? '' : responseNote,
    guardrails,
  };
}

module.exports = { analyze, getUsage, SYSTEM_PROMPT };
