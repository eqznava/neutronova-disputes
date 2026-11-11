# Demo video script (target 2:45, limit 3:00)

Record the screen at 1440 px wide. No copyrighted music, no third-party logos. Fill in the [brackets] with numbers you measured.

| Time | On screen | Voice |
| --- | --- | --- |
| 0:00–0:20 | Defend tab, dispute list | "Small sellers lose PayPal disputes they could win. Research on US card disputes shows merchants who respond with evidence win about 54% of the time, but they win only about 8% of all disputes. Most cases are lost on paperwork and deadlines, not on the facts." (Show source on screen: Mastercard and Datos Insights.) |
| 0:20–0:35 | Point at the badges and the KPI row | "This is Neutronova Disputes, an agent built on the PayPal Agent Toolkit. It does two things: it defends disputes, and it prevents them." |
| 0:35–0:50 | Click "Simulate new dispute (webhook)" (or open a real Sandbox dispute) | "A buyer says their order never arrived. PayPal's webhook brings the dispute in, with the deadline." |
| 0:50–1:20 | Click "Run the agent", scroll to "What the agent did" | "The agent reads the dispute, the transaction and the tracking with Agent Toolkit tools, then the seller's own records. It checks exactly what PayPal needs for this reason: tracking, a delivered status, and delivery to the PayPal ship-to address." |
| 1:20–1:45 | Checklist and draft note; tick approve; send | "Everything is here, so it drafts the response. Nothing goes to PayPal until I approve. One click, and the evidence is sent through the Disputes API." |
| 1:45–2:05 | Open PP-D-1004 and run the agent | "It is also honest. Here the carrier delivered to a different ZIP code. The agent will not fight a case it cannot win; it recommends a refund before the claim is lost. Even if the AI disagrees, a code guardrail blocks it." |
| 2:05–2:25 | Prevent tab, open the high-risk order | "Most lost disputes start before shipping. Prevent mode catches a missing house number, a missing ZIP, no photos and no return address, and adds tracking to PayPal before the package leaves." |
| 2:25–2:40 | Metrics tab | "In my tests, preparing a response by hand took [X] minutes. The agent did it in [Y] seconds, with [Z]% of the evidence complete." |
| 2:40–2:45 | Back to Defend | "Neutronova Disputes: answer every dispute on time, with the right proof." |

Cost tip: rehearse with the rules engine (free). Switch to `AGENT_STYLE=agent` only for the final takes, then switch back to `economy`.

Tips: rehearse twice, keep the cursor slow, and cut pauses in editing.
