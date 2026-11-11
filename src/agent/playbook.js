'use strict';

// Evidence checklist per dispute reason, and a deterministic assessment built only
// from data returned by the tools. The AI agent writes the summary and the response
// note, but the facts in the checklist always come from this code, so the agent
// cannot claim evidence the seller does not have.
//
// Based on:
// - PayPal Seller Protection (US), Item Not Received: online verifiable tracking,
//   "delivered" status and date, recipient address matching the Transaction Details
//   ship-to address (at least city/state or ZIP).
// - PayPal "Dispute reasons and evidence": INR -> PROOF_OF_FULFILLMENT or PROOF_OF_REFUND;
//   SNAD -> OTHER or PROOF_OF_REFUND; UNAUTHORISED -> PROOF_OF_FULFILLMENT, PROOF_OF_REFUND or OTHER.

const config = require('../config');

const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorized payment',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate transaction',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Canceled recurring billing',
  OTHER: 'Other',
};

const norm = (s) => String(s || '').trim().toUpperCase();
const zip5 = (s) => norm(s).slice(0, 5);

// Pulls the facts out of raw tool results (works for mock and Sandbox shapes).
function extractFacts({ dispute, transactions, tracking, records }) {
  const dt = (dispute.disputed_transactions || [])[0] || {};
  const txnDetail = (transactions?.transaction_details || [])[0] || null;
  const addr = txnDetail?.shipping_info?.address || null;
  const tracker = (tracking?.trackers || tracking?.items || [])[0] || null;
  const rec = records || {};
  const dc = rec.delivery_confirmation || null;
  const files = rec.files || [];

  let addressMatch = null; // null = unknown
  if (addr && dc) {
    const zipOk = dc.postal_code && addr.postal_code && zip5(dc.postal_code) === zip5(addr.postal_code);
    const cityOk = dc.city && addr.city && norm(dc.city) === norm(addr.city) && norm(dc.state) === norm(addr.state || addr.admin_area_1);
    addressMatch = Boolean(zipOk || (cityOk && !dc.postal_code));
    if (dc.postal_code && addr.postal_code && !zipOk) addressMatch = false;
  }

  return {
    disputeId: dispute.dispute_id,
    reason: dispute.reason,
    reasonLabel: REASON_LABELS[dispute.reason] || dispute.reason,
    status: dispute.status,
    amount: Number(dispute.dispute_amount?.value || 0),
    currency: dispute.dispute_amount?.currency_code || 'USD',
    dueDate: dispute.seller_response_due_date || null,
    canProvideEvidence: (dispute.links || []).some((l) => l.rel === 'provide_evidence'),
    canAcceptClaim: (dispute.links || []).some((l) => l.rel === 'accept_claim'),
    transactionId: dt.seller_transaction_id,
    buyer: dt.buyer?.name || 'Buyer',
    item: dt.items?.[0]?.item_description || 'Item',
    buyerMessage: dispute.messages?.find((m) => m.posted_by === 'BUYER')?.content || null,
    shipTo: addr,
    tracker: tracker ? { carrier: tracker.carrier || tracker.carrier_name, number: tracker.tracking_number, status: tracker.status } : null,
    delivery: dc,
    addressMatch,
    listing: rec.listing || null,
    itemPhotos: files.filter((f) => f.kind === 'item_photo' || f.kind === 'package_photo'),
    approvals: files.filter((f) => f.kind === 'customer_approval'),
    allFiles: files,
    messages: rec.messages || [],
    returnPolicy: rec.return_policy || null,
  };
}

function item(key, label, required, ok, detail) {
  return { key, label, required, status: ok ? 'have' : 'missing', detail };
}

function checklistFor(f) {
  const delivered = f.tracker && norm(f.tracker.status) === 'DELIVERED' && f.delivery && f.delivery.delivered_at;
  const trackingItem = item('tracking', 'Online, verifiable tracking added to PayPal', true, Boolean(f.tracker?.number),
    f.tracker?.number ? `${f.tracker.carrier} ${f.tracker.number}` : 'No tracking number was added to PayPal for this order.');
  const deliveredItem = item('delivered', '"Delivered" status with delivery date', true, Boolean(delivered),
    delivered ? `Delivered ${f.delivery.delivered_at.slice(0, 10)} (${f.delivery.source})` : 'No carrier delivery confirmation on file.');
  const addressItem = item('address_match', 'Delivery address matches the PayPal ship-to address', true, f.addressMatch === true,
    f.addressMatch === true ? `Delivered to ${f.delivery.city}, ${f.delivery.state} ${f.delivery.postal_code || ''}`.trim()
      : f.addressMatch === false ? `Carrier shows ${f.delivery.city}, ${f.delivery.state} ${f.delivery.postal_code || ''}, but PayPal ship-to is ${f.shipTo.city}, ${f.shipTo.state} ${f.shipTo.postal_code}.`
        : 'Cannot compare: the carrier delivery confirmation or the ship-to address is missing.');
  const messagesItem = item('messages', 'Messages with the buyer', false, f.messages.length > 0,
    f.messages.length ? f.messages.join(' ') : 'No saved messages.');
  const photosItem = (required) => item('item_photos', 'Photos of the item before shipping', required, f.itemPhotos.length > 0,
    f.itemPhotos.length ? f.itemPhotos.map((p) => p.name).join(', ') : 'No photos uploaded.');

  switch (f.reason) {
    case 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED': {
      const list = [trackingItem, deliveredItem, addressItem, messagesItem, photosItem(false)];
      if (f.amount >= config.signatureThreshold) {
        list.push(item('signature', `Signature confirmation (order of $${config.signatureThreshold} or more)`, false, Boolean(f.delivery?.signature),
          f.delivery?.signature ? `Signed by ${f.delivery.signature}` : 'No signature on the delivery confirmation.'));
      }
      return list;
    }
    case 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED':
      return [
        item('listing', 'Original listing description', true, Boolean(f.listing), f.listing || 'Listing text not saved.'),
        photosItem(true),
        messagesItem,
        item('return_policy', 'Return policy shown to the buyer', false, Boolean(f.returnPolicy), f.returnPolicy || 'No return policy saved.'),
        item('tracking', 'Tracking added to PayPal', false, Boolean(f.tracker?.number), f.tracker?.number ? `${f.tracker.carrier} ${f.tracker.number}` : 'No tracking added.'),
      ];
    case 'UNAUTHORISED':
      return [
        trackingItem, deliveredItem, addressItem,
        item('signature', 'Signature on delivery', false, Boolean(f.delivery?.signature), f.delivery?.signature ? `Signed by ${f.delivery.signature}` : 'No signature on file.'),
        item('buyer_interaction', 'Proof the account holder interacted with the order', false, f.approvals.length > 0 || f.messages.length > 0,
          [...f.approvals.map((a) => a.name), ...f.messages].join(' ') || 'No approvals or messages saved.'),
      ];
    default:
      return [messagesItem, item('documents', 'Supporting documents', true, f.allFiles.length > 0, f.allFiles.map((x) => x.name).join(', ') || 'No documents uploaded.')];
  }
}

// Missing required items the seller can still fix by uploading something.
const SELLER_FIXABLE = new Set(['delivered', 'item_photos', 'listing', 'documents']);

function assess(facts) {
  const checklist = checklistFor(facts);
  const applicable = checklist.length;
  const have = checklist.filter((c) => c.status === 'have').length;
  const missingRequired = checklist.filter((c) => c.required && c.status === 'missing');

  // Hard blockers: without tracking, or with a delivery to a different address,
  // a delivery-based defense is very unlikely to work.
  const blockers = missingRequired.filter((c) => c.key === 'tracking' || (c.key === 'address_match' && facts.addressMatch === false));
  const fixable = missingRequired.filter((c) => SELLER_FIXABLE.has(c.key) || (c.key === 'address_match' && facts.addressMatch === null));

  let recommendation; let strength;
  if (blockers.length) { recommendation = 'REFUND'; strength = 'weak'; }
  else if (fixable.length) { recommendation = 'NEED_INFO'; strength = 'moderate'; }
  else { recommendation = 'FIGHT'; strength = have === applicable ? 'strong' : 'moderate'; }

  const evidenceType = recommendation === 'REFUND' ? 'PROOF_OF_REFUND'
    : facts.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' ? 'OTHER'
      : ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'UNAUTHORISED'].includes(facts.reason) ? 'PROOF_OF_FULFILLMENT' : 'OTHER';

  const missingFromSeller = checklist.filter((c) => c.status === 'missing' && (SELLER_FIXABLE.has(c.key) || c.key === 'address_match' && facts.addressMatch === null || !c.required))
    .map((c) => c.label);

  return {
    recommendation, strength,
    completeness: Math.round((have / applicable) * 100),
    checklist,
    blockers: blockers.map((b) => b.detail),
    missing_from_seller: missingFromSeller,
    evidence_type: evidenceType,
    tracking_info: facts.tracker?.number ? [{ carrier_name: norm(facts.tracker.carrier) || 'OTHER', tracking_number: facts.tracker.number }] : [],
  };
}

// Plain, factual response note used in rules mode (and as a fallback).
function draftNote(facts, a) {
  if (a.recommendation === 'REFUND') {
    return `We reviewed this ${facts.reasonLabel.toLowerCase()} case and could not confirm delivery to the buyer's PayPal ship-to address. We will refund the buyer.`;
  }
  const lines = [];
  if (facts.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
    lines.push(`The item matches the listing the buyer accepted: "${facts.listing}".`);
    if (facts.itemPhotos.length) lines.push(`Photos taken before shipping are attached (${facts.itemPhotos.map((p) => p.name).join(', ')}).`);
    if (facts.messages.length) lines.push(`Buyer communication: ${facts.messages.join(' ')}`);
    if (facts.returnPolicy) lines.push(`Return policy shown at purchase: ${facts.returnPolicy}`);
  } else {
    if (facts.tracker?.number) lines.push(`The order shipped with ${facts.tracker.carrier} tracking ${facts.tracker.number}, added to PayPal.`);
    if (facts.delivery?.delivered_at) lines.push(`The carrier confirms delivery on ${facts.delivery.delivered_at.slice(0, 10)} to ${facts.delivery.city}, ${facts.delivery.state} ${facts.delivery.postal_code || ''}, matching the PayPal ship-to address.`.replace(/\s+,/g, ','));
    if (facts.delivery?.signature) lines.push(`The delivery was signed by ${facts.delivery.signature}.`);
    if (facts.approvals.length) lines.push(`The account holder approved the order details before production (${facts.approvals.map((x) => x.name).join(', ')}).`);
    if (facts.messages.length) lines.push(`Buyer communication: ${facts.messages.join(' ')}`);
  }
  if (facts.allFiles.length) lines.push('Supporting documents are attached.');
  return lines.join(' ').slice(0, 2000);
}

module.exports = { extractFacts, assess, draftNote, REASON_LABELS };
