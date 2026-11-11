'use strict';

// Prevent mode: check an order before it ships, so a future dispute can be won
// (or never happens). Each check maps to a reason sellers lose disputes.

const config = require('./config');

const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

function sameAddress(a, b) {
  if (!a || !b) return false;
  return norm(a.line1) === norm(b.line1) && norm(a.city) === norm(b.city)
    && norm(a.state) === norm(b.state) && norm(a.postal_code).slice(0, 5) === norm(b.postal_code).slice(0, 5);
}

const US_ZIP = /^\d{5}(-\d{4})?$/;

function checkOrder(order) {
  const flags = [];
  const add = (level, code, message, action) => flags.push({ level, code, message, action });
  const to = order.ship_to || {};
  const plan = order.plan || {};

  if (!/\d/.test(to.line1 || '')) {
    add('high', 'NO_STREET_NUMBER', 'The street address has no house or building number.', 'Message the buyer to confirm the full address before shipping.');
  }
  if (!to.postal_code || (to.country === 'US' && !US_ZIP.test(to.postal_code))) {
    add('high', 'BAD_POSTAL_CODE', 'The ZIP or postal code is missing or invalid.', 'Confirm the ZIP code with the buyer.');
  }
  if (order.paypal_ship_to && !sameAddress(to, order.paypal_ship_to)) {
    add('high', 'ADDRESS_MISMATCH', 'You plan to ship to an address that differs from the PayPal ship-to address. Seller Protection requires shipping to the address on the Transaction Details page.', 'Ship to the PayPal address, or ask the buyer to update it in PayPal first.');
  }
  if (!plan.tracking) {
    add('high', 'NO_TRACKING', 'No tracking. Without online, verifiable tracking an "item not received" claim cannot be defended.', 'Use a tracked service and add the tracking number to PayPal.');
  }
  if (Number(order.amount) >= config.signatureThreshold && !plan.signature) {
    add('medium', 'NO_SIGNATURE', `High-value order ($${Number(order.amount).toFixed(2)}). Proof of delivery with a signature is much stronger for orders like this.`, 'Add signature confirmation with the carrier.');
  }
  if (!plan.item_photos) {
    add('medium', 'NO_PHOTOS', 'No photos of the item before shipping. Photos are the main defense against "not as described" claims.', 'Photograph the item, tag and packed box.');
  }
  if (!plan.return_address) {
    add('medium', 'NO_RETURN_ADDRESS', 'No return address on the package. Undeliverable packages may never come back.', 'Print a return address on the label.');
  }
  if (Number(order.paid_days_ago) > 7) {
    add('medium', 'LATE_SHIPMENT', `Paid ${order.paid_days_ago} days ago. PayPal recommends shipping within 7 days of payment.`, 'Ship today and message the buyer.');
  }

  const score = flags.reduce((s, f) => s + (f.level === 'high' ? 3 : 1), 0);
  const risk = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return { order_id: order.order_id, risk, score, flags };
}

module.exports = { checkOrder, sameAddress };
