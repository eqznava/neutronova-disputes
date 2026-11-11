# Devpost submission text

## Tagline
An AI agent that helps small PayPal sellers prevent disputes before shipping and answer them on time with the right proof.

## Inspiration
In PayPal's community forum, sellers keep asking the same thing: "My tracking said delivered. Why did I lose?" Research on US card disputes shows merchants who respond with evidence win about 54% of the time, but win only about 8% of all disputes (Mastercard and Datos Insights). The gap is paperwork and deadlines. Small sellers have no dispute team, so they miss the 10-day window, send evidence that does not answer the dispute reason, or ship to an incomplete address and lose before the dispute even starts.

## What it does
- **Defend:** when a dispute webhook arrives, the agent reads the dispute, transaction and tracking with the PayPal Agent Toolkit, reads the seller's own records, checks the evidence PayPal needs for that reason, and recommends: respond with evidence, upload the missing proof, or refund now. It drafts the response note. After the seller approves, it sends the evidence with the Disputes API or accepts the claim.
- **Prevent:** before shipping, it flags orders likely to become lost disputes (missing street number or ZIP, address different from the PayPal ship-to, no tracking, no photos, no return address, late shipment, high value without signature) and adds tracking to PayPal.
- **Metrics:** measures time saved and evidence completeness in the app itself.

## How we built it
Node.js and Express. The agent is a Claude tool-use loop over PayPal Agent Toolkit tools (`get_dispute`, `list_transactions`, `get_shipment_tracking`, `accept_dispute_claim`, `create_shipment_tracking`) plus two custom tools: `get_seller_records` and `provide_dispute_evidence` (Disputes API `provide-evidence`, which the toolkit does not include). PayPal webhooks feed a live dashboard built with AG Grid. A deterministic playbook computes the evidence checklist from tool results.

## Responsible AI
- The agent only reads during analysis; every action that touches PayPal requires explicit seller approval.
- The evidence checklist comes from code, not the model. The model can make a recommendation more cautious, never less.
- When a case cannot be won, it recommends a refund instead of an unfounded fight.

## Challenges
- PayPal's tracking API stores what the seller uploaded, not where the carrier delivered. We added the carrier's delivery confirmation as seller evidence.
- The toolkit has no provide-evidence tool, so we built one on the Disputes API.
- Creating test disputes in Sandbox requires opening them by hand from a Sandbox buyer account.

## What we learned
The hard part of disputes is not writing; it is knowing which proof answers which reason, and doing it before the deadline.

## What's next
Reading orders straight from store platforms, carrier APIs for delivery confirmation, Spanish-language support for Latino small businesses, and "not as described" photo checks at packing time.

## Built with
PayPal Agent Toolkit, PayPal Disputes API, PayPal Webhooks, Claude (Anthropic), Node.js, Express, AG Grid.
