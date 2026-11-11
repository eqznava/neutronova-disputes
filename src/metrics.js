'use strict';

// Measured numbers only: agent run times, evidence completeness, manual timing trials
// the seller records, and whether each response went out before the deadline.
// Each entry is tagged with the PayPal mode it was measured in, so simulated runs
// never mix with Sandbox numbers.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const FILE = path.join('data', 'metrics.json');

function blank() { return { agentRuns: [], manualTrials: [], submissions: [] }; }

let state = load();

function load() {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return blank(); }
}
function save() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function recordAgentRun(disputeId, ms, completeness) {
  state.agentRuns.push({ time: new Date().toISOString(), mode: config.paypalMode, disputeId, ms, completeness });
  save();
}

function recordManualTrial(disputeId, minutes) {
  const entry = { time: new Date().toISOString(), mode: config.paypalMode, disputeId, minutes };
  state.manualTrials.push(entry);
  save();
  return entry;
}

function recordSubmission(entry) { state.submissions.push({ ...entry, mode: config.paypalMode }); save(); }

// Clears only the current mode's numbers.
function reset() {
  const keep = (list) => list.filter((e) => (e.mode || 'mock') !== config.paypalMode);
  state = { agentRuns: keep(state.agentRuns), manualTrials: keep(state.manualTrials), submissions: keep(state.submissions) };
  save();
}

// Entries saved before modes were tracked came from the simulated demo.
const current = (list) => list.filter((e) => (e.mode || 'mock') === config.paypalMode);

function summary(rows) {
  const open = rows.filter((r) => r.needsResponse);
  const runs = current(state.agentRuns);
  const trials = current(state.manualTrials);
  const subs = current(state.submissions);
  const agentSeconds = avg(runs.map((r) => r.ms / 1000));
  const manualMinutes = avg(trials.map((t) => t.minutes));
  const latestByDispute = new Map(runs.map((r) => [r.disputeId, r.completeness]));
  return {
    openDisputes: open.length,
    moneyAtStake: open.reduce((s, r) => s + r.amount, 0),
    dueWithin3Days: open.filter((r) => r.daysLeft !== null && r.daysLeft <= 3).length,
    avgCompleteness: latestByDispute.size ? Math.round(avg([...latestByDispute.values()])) : null,
    agentRuns: runs.length,
    avgAgentSeconds: agentSeconds === null ? null : Number(agentSeconds.toFixed(2)),
    manualTrials: trials.length,
    avgManualMinutes: manualMinutes === null ? null : Number(manualMinutes.toFixed(2)),
    submissions: subs.length,
    submittedOnTime: subs.filter((s) => s.onTime).length,
  };
}

module.exports = { recordAgentRun, recordManualTrial, recordSubmission, summary, reset };
