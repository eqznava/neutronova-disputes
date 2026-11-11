'use strict';

/* global agGrid */

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(n || 0));

const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorized',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid other way',
  CANCELED_RECURRING_BILLING: 'Canceled billing',
  OTHER: 'Other',
};
const REC = {
  FIGHT: { label: 'Respond with evidence', cls: 'good' },
  NEED_INFO: { label: 'Upload missing proof', cls: 'warn' },
  REFUND: { label: 'Refund the buyer', cls: 'bad' },
};
const STATUS = {
  WAITING_FOR_SELLER_RESPONSE: 'Needs your response',
  UNDER_REVIEW: 'PayPal reviewing',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting for buyer',
  RESOLVED: 'Resolved',
  OPEN: 'Open',
};

const ICON_OK = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Have it"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const ICON_MISSING = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="var(--bad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Missing"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';

const state = { status: null, disputeId: null, orderId: null, orders: [], disputes: [], timer: null, timerStart: 0 };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------- grids ----------
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
if (agGrid.ModuleRegistry && agGrid.AllCommunityModule) agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);
let theme = agGrid.themeQuartz.withParams({
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 14,
  accentColor: dark ? '#8fb3e3' : '#1f3a5f',
  borderRadius: 8,
  wrapperBorderRadius: 12,
  headerFontWeight: 600,
  rowHeight: 48,
});
if (dark && agGrid.colorSchemeDarkBlue) theme = theme.withPart(agGrid.colorSchemeDarkBlue);

const pill = (text, cls) => `<span class="pill ${cls}">${esc(text)}</span>`;

const disputeGrid = agGrid.createGrid($('#disputes-grid'), {
  theme,
  rowData: [],
  domLayout: 'autoHeight',
  getRowId: (p) => p.data.id,
  rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
  columnDefs: [
    { headerName: 'Due', field: 'daysLeft', width: 120, sort: null,
      cellRenderer: (p) => {
        if (!p.data.needsResponse) return pill('Done', 'plain');
        const d = p.value;
        if (d === null) return pill('No deadline', 'plain');
        if (d <= 0) return pill('Due today', 'bad');
        return pill(`${d} day${d === 1 ? '' : 's'}`, d <= 3 ? 'bad' : d <= 6 ? 'warn' : 'plain');
      } },
    { headerName: 'Reason', field: 'reason', flex: 1, minWidth: 150, valueFormatter: (p) => REASONS[p.value] || p.value },
    { headerName: 'Amount', field: 'amount', width: 110, type: 'rightAligned', valueFormatter: (p) => money(p.value, p.data.currency) },
    { headerName: 'Buyer', field: 'buyer', width: 140 },
    { headerName: 'Item', field: 'item', flex: 1, minWidth: 170 },
    { headerName: 'Evidence', field: 'completeness', width: 110, valueFormatter: (p) => (p.value === null ? '—' : `${p.value}%`) },
    { headerName: 'Agent says', field: 'recommendation', width: 190, cellRenderer: (p) => (p.value ? pill(REC[p.value].label, REC[p.value].cls) : '<span class="muted">Not run</span>') },
    { headerName: 'Status', field: 'status', width: 170, valueFormatter: (p) => STATUS[p.value] || p.value },
  ],
  defaultColDef: { sortable: true, resizable: true },
  onRowClicked: (e) => openDispute(e.data.id),
});

const orderGrid = agGrid.createGrid($('#orders-grid'), {
  theme,
  rowData: [],
  domLayout: 'autoHeight',
  getRowId: (p) => p.data.order_id,
  rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
  columnDefs: [
    { headerName: 'Risk', field: 'risk', width: 110, cellRenderer: (p) => pill(p.value === 'high' ? 'High' : p.value === 'medium' ? 'Medium' : 'Low', p.value === 'high' ? 'bad' : p.value === 'medium' ? 'warn' : 'good') },
    { headerName: 'Order', field: 'order_id', width: 200, cellClass: 'mono' },
    { headerName: 'Buyer', field: 'buyer', width: 140 },
    { headerName: 'Item', field: 'item', flex: 1, minWidth: 160 },
    { headerName: 'Amount', field: 'amount', width: 110, type: 'rightAligned', valueFormatter: (p) => money(p.value) },
    { headerName: 'Paid', field: 'paid_days_ago', width: 110, valueFormatter: (p) => (p.value === 0 ? 'Today' : `${p.value} d ago`) },
    { headerName: 'Issues', field: 'issues', width: 100 },
  ],
  defaultColDef: { sortable: true, resizable: true },
  onRowClicked: (e) => openOrder(e.data.order_id),
});

// ---------- disputes ----------
async function loadDisputes() {
  const [{ rows }, m] = await Promise.all([api('/api/disputes'), api('/api/metrics')]);
  state.disputes = rows;
  disputeGrid.setGridOption('rowData', rows);
  renderKpis(m);
  renderTrialOptions();
}

function kpi(label, value, sub) {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}

function renderKpis(m) {
  $('#kpis').innerHTML = [
    kpi('Open disputes', m.openDisputes),
    kpi('Money at stake', money(m.moneyAtStake)),
    kpi('Due in 3 days or less', m.dueWithin3Days),
    kpi('Avg. evidence complete', m.avgCompleteness === null ? '—' : `${m.avgCompleteness}%`, 'Disputes the agent has checked'),
  ].join('');
}

async function openDispute(id) {
  state.disputeId = id;
  const panel = $('#detail');
  panel.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api(`/api/disputes/${encodeURIComponent(id)}`);
    renderDispute(data);
  } catch (err) { panel.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}

function renderDispute({ row, dispute, analysis }) {
  const buyerMsg = dispute.messages?.find((m) => m.posted_by === 'BUYER')?.content;
  const due = row.dueDate ? new Date(row.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  $('#detail').innerHTML = `
    <div class="head">
      <div>
        <div class="muted small">${esc(row.id)} · ${esc(REASONS[row.reason] || row.reason)}</div>
        <div class="amount">${money(row.amount, row.currency)}</div>
        <div class="small">${esc(row.item)} · ${esc(row.buyer)}</div>
      </div>
      ${row.needsResponse ? pill(due ? `Respond by ${due}` : 'Needs response', row.daysLeft !== null && row.daysLeft <= 3 ? 'bad' : 'warn') : pill(STATUS[row.status] || row.status, 'plain')}
    </div>
    ${buyerMsg ? `<div class="section"><h3>Buyer says</h3><div class="quote">“${esc(buyerMsg)}”</div></div>` : ''}
    <div class="section">
      <div class="actions" style="margin-top:0">
        <button class="btn primary" id="btn-analyze">${analysis ? 'Run the agent again' : 'Run the agent'}</button>
      </div>
      <div id="analysis">${analysis ? analysisHtml(analysis, row) : ''}</div>
    </div>`;
  $('#btn-analyze').addEventListener('click', () => runAgent(row.id));
  if (analysis) bindAnalysis(analysis, row);
}

async function runAgent(id) {
  const btn = $('#btn-analyze');
  btn.disabled = true; btn.textContent = 'Agent is investigating…';
  $('#analysis').innerHTML = '<p class="muted small" style="margin-top:12px">Reading the dispute, the transaction, the tracking and your records…</p>';
  try {
    await api(`/api/disputes/${encodeURIComponent(id)}/analyze`, { method: 'POST' });
    await Promise.all([openDispute(id), loadDisputes()]);
  } catch (err) {
    toast(err.message);
    btn.disabled = false; btn.textContent = 'Run the agent';
  }
}

function analysisHtml(a, row) {
  const rec = REC[a.assessment.recommendation];
  const steps = a.steps.map((s) => `<li>${s.ok ? ICON_OK : ICON_MISSING}<span class="tool">${esc(s.tool)}</span>${pill(s.source, s.source === 'PayPal Agent Toolkit' ? 'info' : 'plain')}<span class="ms">${s.ms} ms</span></li>`).join('');
  const checklist = a.assessment.checklist.map((c) => `
    <li>${c.status === 'have' ? ICON_OK : ICON_MISSING}
      <div><div class="what">${esc(c.label)}${c.required ? '<span class="req">Required</span>' : ''}</div><div class="detail">${esc(c.detail)}</div></div>
    </li>`).join('');
  const canAct = row.needsResponse;
  const isRefund = a.assessment.recommendation === 'REFUND';
  return `
    <div class="rec ${a.assessment.recommendation}" style="margin-top:14px">
      <div class="title">${esc(rec.label)}</div>
      <p style="margin:4px 0 0">${esc(a.summary)}</p>
    </div>
    ${a.guardrails?.length ? `<div class="notice">${a.guardrails.map(esc).join('<br>')}</div>` : ''}
    ${a.aiError ? `<div class="notice">AI unavailable (${esc(a.aiError)}). Used the rules engine.</div>` : ''}
    ${a.aiSkipped ? `<div class="notice">${esc(a.aiSkipped)}</div>` : ''}

    <div class="section">
      <h3>Evidence check · ${a.assessment.completeness}% complete</h3>
      <ul class="checklist">${checklist}</ul>
    </div>

    ${canAct && !isRefund ? `
    <div class="section">
      <h3>Add proof</h3>
      <form id="upload-form" class="row" enctype="multipart/form-data">
        <label for="up-kind">Type</label>
        <select id="up-kind" name="kind">
          <option value="item_photo">Photo of the item</option>
          <option value="package_photo">Photo of the packed box or label</option>
          <option value="customer_approval">Buyer approval or receipt</option>
          <option value="other">Other document</option>
        </select>
        <label for="up-file" class="sr">File</label>
        <input id="up-file" name="file" type="file" accept="image/jpeg,image/png,image/gif,application/pdf" required>
        <button class="btn" type="submit">Upload</button>
      </form>
      <details>
        <summary class="small">Add the carrier's delivery confirmation</summary>
        <form id="dc-form">
          <div class="row"><label for="dc-date">Delivered on</label><input id="dc-date" type="text" placeholder="YYYY-MM-DD" required></div>
          <div class="row"><label for="dc-city">City</label><input id="dc-city" type="text" required><label for="dc-state">State</label><input id="dc-state" type="text" required></div>
          <div class="row"><label for="dc-zip">ZIP</label><input id="dc-zip" type="text" required><label for="dc-sig">Signed by</label><input id="dc-sig" type="text" placeholder="Optional"></div>
          <button class="btn" type="submit">Save confirmation</button>
        </form>
      </details>
    </div>` : ''}

    ${canAct ? `
    <div class="section">
      ${isRefund ? `
        <h3>Accept the claim</h3>
        <p class="small">PayPal will refund the buyer. This ends the dispute and avoids a decision against you.</p>
      ` : `
        <h3>Response to PayPal</h3>
        <label for="note">Edit before sending. Evidence type: <span class="mono">${esc(a.assessment.evidence_type)}</span>${a.assessment.tracking_info.length ? ` · tracking <span class="mono">${esc(a.assessment.tracking_info[0].tracking_number)}</span>` : ''}</label>
        <textarea id="note" maxlength="2000">${esc(a.response_note)}</textarea>
      `}
      <label class="approve"><input type="checkbox" id="approve"> <span>I reviewed this and approve sending it to PayPal.</span></label>
      <div class="actions">
        ${isRefund
    ? '<button class="btn primary" id="btn-accept" disabled>Accept claim and refund</button>'
    : '<button class="btn primary" id="btn-send" disabled>Send evidence to PayPal</button>'}
        ${!isRefund && row.needsResponse ? '<button class="btn danger" id="btn-accept-alt" disabled>Refund instead</button>' : ''}
      </div>
    </div>` : '<div class="notice">This dispute is not waiting for your response.</div>'}

    <div class="section">
      <h3>What the agent did · ${esc(a.mode === 'claude' ? 'Claude' : 'rules engine')} · ${a.ms < 100 ? '<0.1' : (a.ms / 1000).toFixed(1)} s</h3>
      <ul class="steps">${steps}</ul>
    </div>`;
}

function bindAnalysis(a, row) {
  const approve = $('#approve');
  if (approve) {
    approve.addEventListener('change', () => {
      ['#btn-send', '#btn-accept', '#btn-accept-alt'].forEach((s) => { if ($(s)) $(s).disabled = !approve.checked; });
    });
  }
  $('#btn-send')?.addEventListener('click', () => submit(row.id, 'evidence', $('#note').value));
  $('#btn-accept')?.addEventListener('click', () => submit(row.id, 'accept'));
  $('#btn-accept-alt')?.addEventListener('click', () => submit(row.id, 'accept'));

  $('#upload-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData();
    const file = $('#up-file').files[0];
    if (!file) return toast('Choose a file first.');
    fd.append('kind', $('#up-kind').value);
    fd.append('file', file);
    try {
      await api(`/api/disputes/${encodeURIComponent(row.id)}/files`, { method: 'POST', body: fd });
      toast('Uploaded. Re-checking the evidence…');
      runAgent(row.id);
    } catch (err) { toast(err.message); }
  });

  $('#dc-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { delivery_confirmation: { source: 'Carrier delivery confirmation', delivered_at: $('#dc-date').value, city: $('#dc-city').value, state: $('#dc-state').value, postal_code: $('#dc-zip').value, signature: $('#dc-sig').value } };
    try {
      await api(`/api/disputes/${encodeURIComponent(row.id)}/records`, { method: 'POST', body: JSON.stringify(body) });
      toast('Saved. Re-checking the evidence…');
      runAgent(row.id);
    } catch (err) { toast(err.message); }
  });
}

async function submit(id, action, note) {
  if (!$('#approve')?.checked) return toast('Tick the approval box first.');
  try {
    await api(`/api/disputes/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({ action, approved: true, note }) });
    toast(action === 'accept' ? 'Claim accepted. The buyer will be refunded.' : 'Evidence sent to PayPal.');
    await Promise.all([openDispute(id), loadDisputes()]);
  } catch (err) { toast(err.message); }
}

// ---------- prevent ----------
async function loadOrders() {
  const { orders, note } = await api('/api/orders');
  state.orders = orders;
  $('#orders-note').textContent = note;
  orderGrid.setGridOption('rowData', orders.map((o) => ({ ...o, risk: o.check.risk, issues: o.check.flags.length })));
}

function openOrder(id) {
  state.orderId = id;
  const o = state.orders.find((x) => x.order_id === id);
  if (!o) return;
  const flags = o.check.flags;
  const to = o.ship_to;
  $('#order-detail').innerHTML = `
    <div class="head">
      <div>
        <div class="muted small mono">${esc(o.order_id)}</div>
        <div class="amount">${money(o.amount)}</div>
        <div class="small">${esc(o.item)} · ${esc(o.buyer)}</div>
      </div>
      ${pill(o.check.risk === 'high' ? 'High risk' : o.check.risk === 'medium' ? 'Medium risk' : 'Ready to ship', o.check.risk === 'high' ? 'bad' : o.check.risk === 'medium' ? 'warn' : 'good')}
    </div>
    <div class="section">
      <h3>Shipping to</h3>
      <div class="quote">${esc(to.line1)}, ${esc(to.city)}, ${esc(to.state)} ${esc(to.postal_code || '(no ZIP)')}</div>
    </div>
    <div class="section">
      <h3>${flags.length ? `${flags.length} thing${flags.length === 1 ? '' : 's'} to fix before shipping` : 'Nothing to fix'}</h3>
      ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>${pill(f.level === 'high' ? 'High' : 'Medium', f.level === 'high' ? 'bad' : 'warn')} <span class="what">${esc(f.message)}</span><div class="fix">${esc(f.action)}</div></li>`).join('')}</ul>` : '<p class="small muted">Tracking, address, photos and return address all look right.</p>'}
    </div>
    <div class="section">
      <h3>Add tracking to PayPal</h3>
      <p class="small muted">Uses the Agent Toolkit tool <span class="mono">create_shipment_tracking</span>. Tracking in PayPal is part of what Seller Protection checks.</p>
      <form id="track-form">
        <div class="row"><label for="tr-carrier">Carrier</label>
          <select id="tr-carrier"><option>USPS</option><option>UPS</option><option>FEDEX</option><option>DHL</option></select></div>
        <div class="row"><label for="tr-number">Tracking number</label><input id="tr-number" type="text" required></div>
        <button class="btn primary" type="submit">Add tracking</button>
      </form>
    </div>`;
  $('#track-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/orders/${encodeURIComponent(o.order_id)}/tracking`, { method: 'POST', body: JSON.stringify({ transaction_id: o.order_id, carrier: $('#tr-carrier').value, tracking_number: $('#tr-number').value.trim() }) });
      toast('Tracking added to PayPal.');
      await loadOrders();
      openOrder(o.order_id);
    } catch (err) { toast(err.message); }
  });
}

// ---------- metrics ----------
async function loadMetrics() {
  const [m, audit] = await Promise.all([api('/api/metrics'), api('/api/audit')]);
  $('#metrics-kpis').innerHTML = [
    kpi('Manual response', m.avgManualMinutes === null ? '—' : `${m.avgManualMinutes < 0.1 ? '<0.1' : m.avgManualMinutes.toFixed(1)} min`, `${m.manualTrials} timed trial${m.manualTrials === 1 ? '' : 's'}`),
    kpi('Agent analysis', m.avgAgentSeconds === null ? '—' : `${m.avgAgentSeconds < 0.1 ? '<0.1' : m.avgAgentSeconds.toFixed(1)} s`, `${m.agentRuns} run${m.agentRuns === 1 ? '' : 's'}`),
    kpi('Avg. evidence complete', m.avgCompleteness === null ? '—' : `${m.avgCompleteness}%`),
    kpi('Responses sent on time', m.submissions ? `${m.submittedOnTime} of ${m.submissions}` : '—'),
    m.ai ? kpi('AI calls today', `${m.ai.calls} of ${m.ai.cap}`, `${m.ai.inputTokens.toLocaleString()} in / ${m.ai.outputTokens.toLocaleString()} out tokens · ${m.ai.model}`) : kpi('AI calls today', '0', 'Rules engine only, no AI cost'),
  ].join('');
  $('#audit').innerHTML = audit.entries.length
    ? `<table class="audit"><thead><tr><th>Time</th><th>Dispute</th><th>Action</th><th>Before deadline</th></tr></thead><tbody>${audit.entries.map((e) => `<tr><td>${esc(new Date(e.time).toLocaleString())}</td><td class="mono">${esc(e.disputeId)}</td><td>${e.action === 'accept' ? 'Accepted claim' : 'Sent evidence'}</td><td>${e.onTime ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">Nothing sent yet.</p>';
}

function renderTrialOptions() {
  const sel = $('#trial-dispute');
  const current = sel.value;
  sel.innerHTML = state.disputes.filter((d) => d.needsResponse).map((d) => `<option value="${esc(d.id)}">${esc(d.id)} · ${esc(REASONS[d.reason] || d.reason)} · ${money(d.amount)}</option>`).join('');
  if (current) sel.value = current;
}

$('#trial-start').addEventListener('click', () => {
  state.timerStart = Date.now();
  $('#trial-start').disabled = true; $('#trial-stop').disabled = false;
  $('#trial-msg').textContent = 'Timing… work through the dispute by hand.';
  state.timer = setInterval(() => {
    const s = Math.floor((Date.now() - state.timerStart) / 1000);
    $('#trial-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
});
$('#trial-stop').addEventListener('click', async () => {
  clearInterval(state.timer);
  const minutes = (Date.now() - state.timerStart) / 60000;
  $('#trial-start').disabled = false; $('#trial-stop').disabled = true;
  try {
    await api('/api/metrics/manual', { method: 'POST', body: JSON.stringify({ dispute_id: $('#trial-dispute').value, minutes: Math.max(minutes, 0.01) }) });
    $('#trial-msg').textContent = `Saved: ${minutes.toFixed(1)} minutes. Now run the agent on the same dispute.`;
    loadMetrics();
  } catch (err) { $('#trial-msg').textContent = err.message; }
});

// ---------- navigation, status, live updates ----------
function show(view) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tab').forEach((t) => { if (t.dataset.view === view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  if (view === 'prevent') loadOrders().catch((e) => toast(e.message));
  if (view === 'metrics') loadMetrics().catch((e) => toast(e.message));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));

$('#btn-refresh').addEventListener('click', () => loadDisputes().catch((e) => toast(e.message)));
$('#btn-simulate').addEventListener('click', () => api('/api/demo/simulate-dispute', { method: 'POST' }).catch((e) => toast(e.message)));
$('#btn-reset').addEventListener('click', async () => {
  await api('/api/demo/reset', { method: 'POST' }).catch((e) => toast(e.message));
  state.disputeId = null;
  $('#detail').innerHTML = '<div class="empty"><p class="empty-title">Demo reset</p><p>Pick a dispute to start again.</p></div>';
});

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('disputes-changed', async (e) => {
    const data = JSON.parse(e.data || '{}');
    await loadDisputes().catch(() => {});
    if (data.event === 'CUSTOMER.DISPUTE.CREATED') {
      toast(`New dispute ${data.disputeId || ''} received${data.simulated ? ' (simulated webhook)' : ''}.`);
      if (data.disputeId) { disputeGrid.getRowNode(data.disputeId)?.setSelected(true); openDispute(data.disputeId); }
    }
  });
}

(async function init() {
  try {
    state.status = await api('/api/status');
    document.title = state.status.appName;
    $('#app-name').textContent = state.status.appName;
    $('#modes').innerHTML = [
      pill(state.status.paypalMode === 'sandbox' ? 'PayPal Sandbox' : 'Simulated PayPal data', state.status.paypalMode === 'sandbox' ? 'info' : 'warn'),
      pill(state.status.aiMode === 'claude' ? `AI: ${state.status.model}` : 'AI: rules engine', 'plain'),
    ].join('');
    if (state.status.paypalMode === 'mock') { $('#btn-simulate').hidden = false; $('#btn-reset').hidden = false; }
    await loadDisputes();
    connectEvents();
  } catch (err) { toast(err.message); }
})();
