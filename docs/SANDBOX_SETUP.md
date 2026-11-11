# Connect the PayPal Sandbox

Use Sandbox credentials only. Never put live credentials in this project.

1. Go to the PayPal Developer Dashboard > **Apps & Credentials** > **Sandbox**, and create an app (or use the default one).
2. In the app's settings, turn on **Customer disputes** (and **Transaction search**, if listed).
3. Copy the app's **Client ID** and **Secret** into `.env`:

   ```
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```

4. Create a test dispute:
   - Under **Testing Tools > Sandbox Accounts** you have a Sandbox *personal* account and a Sandbox *business* account.
   - Pay the business account with the personal account (for example with a Sandbox checkout).
   - Log in to sandbox.paypal.com with the **personal** account, open the payment and report a problem ("I didn't receive it") to open a dispute.
   - Escalate it to a claim if you want to test the full evidence flow.
5. Add tracking to that payment (Prevent tab, or the toolkit's `create_shipment_tracking`).
6. Run `npm start`, open the Defend tab, and the dispute appears. Add the carrier delivery confirmation in the app, run the agent, approve, and send.

## Webhooks (optional)

1. In the Sandbox app, add a webhook pointing to `https://<your-host>/webhooks/paypal` with the events `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED`.
2. Put the webhook ID in `PAYPAL_WEBHOOK_ID`. The server verifies every webhook with PayPal before using it.

## If something fails

- `PayPal OAuth failed`: the Client ID or Secret is wrong, or they are live credentials.
- 403 on disputes: Customer disputes is not enabled for the app.
- "PayPal is not accepting evidence for this dispute right now": PayPal only accepts evidence while the dispute is waiting for the seller (the dispute has a `provide_evidence` link).
