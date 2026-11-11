# Neutronova Disputes

An AI agent that helps small PayPal sellers **prevent** disputes before they ship and **defend** them when they arrive. Built on the PayPal Agent Toolkit and the PayPal Disputes API.

> Merchants who fight a dispute with evidence win about 54% of the time, but win only about 8% of all disputes, because most are decided before the merchant responds or never get a response. *(Mastercard and Datos Insights, US card chargebacks, via [Chargeback.io](https://chargeback.io/blog/how-often-do-merchants-win-chargeback-disputes).)*

## What it does

**Defend.** When a dispute arrives (PayPal webhook), the agent:

1. Reads the dispute, the transaction and the tracking with **PayPal Agent Toolkit** tools (`get_dispute`, `list_transactions`, `get_shipment_tracking`).
2. Reads the seller's own records (listing, photos, buyer messages, carrier delivery confirmation) with a custom tool, `get_seller_records`.
3. Checks the evidence PayPal needs for that dispute reason. For "item not received" that is tracking, a "delivered" status with date, and delivery to the PayPal ship-to address.
4. Recommends one of three paths: **respond with evidence**, **upload the missing proof**, or **refund now** when the case cannot be won.
5. Drafts the response note for PayPal.
6. After the seller ticks "I approve", sends the evidence with the **Disputes API `provide-evidence`** call, or accepts the claim with the toolkit's `accept_dispute_claim`.

**Prevent.** Before an order ships, it flags what makes disputes hard to win later: a missing street number or ZIP, shipping to an address other than the PayPal ship-to address, no tracking, no item photos, no return address, a late shipment, and high-value orders without a signature. It can add tracking to PayPal with the toolkit's `create_shipment_tracking`.

**Metrics.** Shows only numbers measured in the app: agent run time, a manual-response timer for side-by-side comparison, evidence completeness, and responses sent before the deadline.

## Safety by design

- **Human in the loop.** The agent only reads during analysis. Nothing is sent to PayPal until the seller approves; the server rejects any submit without `approved: true`.
- **No invented evidence.** The evidence checklist is computed by code from tool results. The AI writes the summary and the note, but it can only make the recommendation *more* cautious than the evidence allows, never less (see `src/agent/agent.js`).
- **Honest outcomes.** When the evidence cannot win, the agent says so and recommends a refund, which avoids a lost claim on top of the refund.
- **Sandbox only.** Production mode is not supported in this project.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm start            # http://localhost:3000
npm test
```

With no keys it runs on **simulated PayPal data** with the **rules engine**, so anyone can try it. All names, addresses and numbers in the simulated data are invented.

| Setting in `.env` | Effect |
| --- | --- |
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | Uses the PayPal Sandbox through the Agent Toolkit and the Disputes API |
| `ANTHROPIC_API_KEY` | Claude writes the assessment (default model `claude-haiku-5-5`, the cheapest) |
| `AGENT_STYLE` | `economy` (default): one AI call per case, only when needed. `agent`: full Claude tool-use loop |
| `AI_MAX_CALLS_PER_DAY` | Hard daily cap on AI calls (default 25); past it, the rules engine runs at no cost |
| `PAYPAL_WEBHOOK_ID` | Verifies incoming dispute webhooks with PayPal |

### Connect the PayPal Sandbox

See [docs/SANDBOX_SETUP.md](docs/SANDBOX_SETUP.md). In short: create a Sandbox app, turn on **Customer disputes** for it, buy something with the Sandbox personal account, open a dispute from that account, and the dispute shows up in the app.

### Deploy

`render.yaml` deploys the simulated-data demo to Render. Set `DEMO_USER` and `DEMO_PASSWORD` if you add Sandbox keys to a public deployment.

## Keeping AI costs low

- The PayPal data is always gathered by code with the Agent Toolkit, which costs nothing in AI tokens.
- In `economy` mode Claude is called **once** per case, with compact facts, and only when the rules engine cannot settle it alone. Cases the evidence cannot win (refund) skip the AI entirely.
- The same facts are never paid for twice: results are cached by a hash of the facts.
- A daily cap stops AI calls; the Metrics tab shows calls and tokens used today.
- Without an API key everything still works with the rules engine, free.

## How it is built

```
src/
  server.js          Express API, approval gate, webhooks, server-sent events
  agent/agent.js     Claude tool-use loop (or rules mode) + guardrail
  agent/playbook.js  Evidence checklist per dispute reason, deterministic assessment
  paypal/tools.js    One tool layer: PayPal Agent Toolkit tools + custom tools, mock or Sandbox
  paypal/client.js   Disputes API provide-evidence, webhook verification
  paypal/mock.js     Simulated data shaped like PayPal API responses
  prevent.js         Pre-shipment checks
  metrics.js         Measured metrics only
public/              Single-page UI with AG Grid
test/                node:test suite (mock mode, includes a fake-Claude guardrail test)
```

| PayPal capability | Used for |
| --- | --- |
| Agent Toolkit `get_dispute`, `list_transactions`, `get_shipment_tracking` | Agent investigation |
| Agent Toolkit `accept_dispute_claim` | Refund path, after approval |
| Agent Toolkit `create_shipment_tracking` | Prevent mode |
| Disputes API `provide-evidence` (custom tool) | Send evidence, after approval |
| Webhooks `CUSTOMER.DISPUTE.*` | New dispute alerts |

## Limitations

- PayPal's tracking API stores what the seller uploaded. Where and when the package was delivered comes from the carrier's delivery confirmation, which the seller adds in the app.
- Prevent mode runs on demo orders. A real deployment would read orders from the seller's store.
- The 54% / 8% figures are for US card chargebacks at mid-size and large merchants, not PayPal-specific data. PayPal does not publish seller win rates.

## License

MIT
