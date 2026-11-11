'use strict';

// Simulated data shaped like PayPal's Disputes, Transactions and Tracking APIs.
// Every name, address and number here is invented.

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

function disputeLinks(id, status) {
  const links = [{ rel: 'self', method: 'GET', href: `/v1/customer/disputes/${id}` }];
  if (status === 'WAITING_FOR_SELLER_RESPONSE') {
    links.push({ rel: 'provide_evidence', method: 'POST', href: `/v1/customer/disputes/${id}/provide-evidence` });
    links.push({ rel: 'accept_claim', method: 'POST', href: `/v1/customer/disputes/${id}/accept-claim` });
  }
  return links;
}

function makeDispute(d) {
  return {
    dispute_id: d.id,
    create_time: iso(-d.openedDaysAgo),
    update_time: iso(-d.openedDaysAgo),
    reason: d.reason,
    status: d.status,
    dispute_state: d.status === 'RESOLVED' ? 'RESOLVED' : d.status === 'WAITING_FOR_SELLER_RESPONSE' ? 'REQUIRED_ACTION' : 'UNDER_PAYPAL_REVIEW',
    dispute_life_cycle_stage: d.stage || 'CLAIM',
    dispute_channel: 'INTERNAL',
    dispute_amount: { currency_code: 'USD', value: d.amount.toFixed(2) },
    seller_response_due_date: d.status === 'WAITING_FOR_SELLER_RESPONSE' ? iso(d.dueInDays) : undefined,
    messages: d.buyerMessage ? [{ posted_by: 'BUYER', time_posted: iso(-d.openedDaysAgo), content: d.buyerMessage }] : [],
    disputed_transactions: [{
      seller_transaction_id: d.txn,
      buyer: { name: d.buyer },
      gross_amount: { currency_code: 'USD', value: d.amount.toFixed(2) },
      items: [{ item_description: d.item, item_quantity: String(d.qty || 1) }],
      seller_protection_eligible: true,
    }],
    links: disputeLinks(d.id, d.status),
  };
}

function seed() {
  const disputes = [
    { id: 'PP-D-1001', txn: '7KT51390AB224410X', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 86, item: 'Ceramic mug set (2)', qty: 2, buyer: 'Jordan Ellis', openedDaysAgo: 4, dueInDays: 6, buyerMessage: 'My order never arrived.' },
    { id: 'PP-D-1002', txn: '3HM20984CD551172Y', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 240, item: 'Handmade leather tote', buyer: 'Priya Raman', openedDaysAgo: 7, dueInDays: 3, buyerMessage: 'Still waiting for my bag.' },
    { id: 'PP-D-1003', txn: '9QX44120EF883305Z', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 129, item: 'Vintage denim jacket, size M', buyer: 'Sam Okafor', openedDaysAgo: 2, dueInDays: 8, buyerMessage: 'The jacket is not the size shown.' },
    { id: 'PP-D-1004', txn: '5RB78231GH114096W', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 54, item: 'Soy candle trio', buyer: 'Lena Fischer', openedDaysAgo: 5, dueInDays: 5, buyerMessage: 'Nothing was delivered to me.' },
    { id: 'PP-D-1005', txn: '2LP90017JK336281V', reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 310, item: 'Walnut cutting board, engraved', buyer: 'Chris Baker', openedDaysAgo: 9, dueInDays: 1, stage: 'CHARGEBACK' },
    { id: 'PP-D-1006', txn: '8NV33564LM702918U', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'RESOLVED', amount: 38, item: 'Linen napkins (4)', buyer: 'Alex Moreno', openedDaysAgo: 30, dueInDays: 0 },
  ].map(makeDispute);

  // Transactions as the seller sees them (ship-to address from Transaction Details).
  const transactions = {
    '7KT51390AB224410X': { transaction_id: '7KT51390AB224410X', order_id: '5O190127TN364715T', date: iso(-14), amount: '86.00', shipping_address: { line1: '418 Maple Ave', city: 'Springfield', state: 'IL', postal_code: '62704', country: 'US' } },
    '3HM20984CD551172Y': { transaction_id: '3HM20984CD551172Y', order_id: '8A420389LK903126M', date: iso(-21), amount: '240.00', shipping_address: { line1: '77 Harbor St Apt 5', city: 'Portland', state: 'ME', postal_code: '04101', country: 'US' } },
    '9QX44120EF883305Z': { transaction_id: '9QX44120EF883305Z', order_id: '1C730112RS558820B', date: iso(-12), amount: '129.00', shipping_address: { line1: '2901 Elm St', city: 'Austin', state: 'TX', postal_code: '78705', country: 'US' } },
    '5RB78231GH114096W': { transaction_id: '5RB78231GH114096W', order_id: '6D115574QW227391C', date: iso(-15), amount: '54.00', shipping_address: { line1: '15 Birch Rd', city: 'Madison', state: 'WI', postal_code: '53703', country: 'US' } },
    '2LP90017JK336281V': { transaction_id: '2LP90017JK336281V', order_id: '4E992201ZX118467D', date: iso(-25), amount: '310.00', shipping_address: { line1: '640 Cedar Ln', city: 'Denver', state: 'CO', postal_code: '80203', country: 'US' } },
    '8NV33564LM702918U': { transaction_id: '8NV33564LM702918U', order_id: '7F338806UV449102E', date: iso(-45), amount: '38.00', shipping_address: { line1: '9 Pine Ct', city: 'Tampa', state: 'FL', postal_code: '33602', country: 'US' } },
  };

  // Tracking that was added to PayPal for each order (as get_shipment_tracking returns it).
  const tracking = {
    '7KT51390AB224410X': { carrier: 'USPS', tracking_number: '9400111899223344556677', status: 'DELIVERED', delivered_at: iso(-9), delivered_to: { city: 'Springfield', state: 'IL', postal_code: '62704' } },
    '9QX44120EF883305Z': { carrier: 'UPS', tracking_number: '1Z999AA10123456784', status: 'DELIVERED', delivered_at: iso(-6), delivered_to: { city: 'Austin', state: 'TX', postal_code: '78705' } },
    '5RB78231GH114096W': { carrier: 'USPS', tracking_number: '9400111899220011223344', status: 'DELIVERED', delivered_at: iso(-8), delivered_to: { city: 'Milwaukee', state: 'WI', postal_code: '53202' } },
    '2LP90017JK336281V': { carrier: 'FEDEX', tracking_number: '771234567890', status: 'DELIVERED', delivered_at: iso(-19), delivered_to: { city: 'Denver', state: 'CO', postal_code: '80203' }, signature: 'C. BAKER' },
    '8NV33564LM702918U': { carrier: 'USPS', tracking_number: '9400111899225566778899', status: 'DELIVERED', delivered_at: iso(-40), delivered_to: { city: 'Tampa', state: 'FL', postal_code: '33602' } },
  };

  // What the seller keeps outside PayPal: listing text, photos, messages, policies.
  const sellerRecords = {
    '7KT51390AB224410X': { listing: 'Set of two hand-thrown ceramic mugs, 12 oz, speckled glaze.', files: [], messages: ['Buyer confirmed the shipping address by message the day after purchase.'], return_policy: '30-day returns, buyer pays return shipping.' },
    '3HM20984CD551172Y': { listing: 'Handmade full-grain leather tote, 14 x 12 in.', files: [], messages: [], return_policy: '30-day returns, buyer pays return shipping.' },
    '9QX44120EF883305Z': { listing: 'Vintage denim jacket. Tag says M. Measurements: chest 21 in pit-to-pit, length 25 in. Fits like a modern S.', files: [{ name: 'jacket-front.jpg', kind: 'item_photo' }, { name: 'jacket-tag-measurements.jpg', kind: 'item_photo' }], messages: ['Buyer asked about fit before buying; seller replied it fits like a modern S.'], return_policy: '14-day returns for vintage items.' },
    '5RB78231GH114096W': { listing: 'Three 8 oz soy candles: cedar, lavender, citrus.', files: [], messages: [], return_policy: 'No returns on candles.' },
    '2LP90017JK336281V': { listing: 'Walnut cutting board with custom engraving.', files: [{ name: 'engraving-proof-approved.png', kind: 'customer_approval' }], messages: ['Buyer approved the engraving text "The Bakers, est. 2019" before production.'], return_policy: 'Custom items are final sale.' },
    '8NV33564LM702918U': { listing: 'Set of four linen napkins.', files: [], messages: [], return_policy: '30-day returns.' },
  };

  // Unshipped orders for Prevent mode.
  const orders = [
    { order_id: '9G552019HT331800K', buyer: 'Maya Chen', item: 'Stoneware dinner set', amount: 820, paid_days_ago: 1, ship_to: { line1: '1200 Lake Shore Dr', city: 'Chicago', state: 'IL', postal_code: '60610', country: 'US' }, paypal_ship_to: { line1: '1200 Lake Shore Dr', city: 'Chicago', state: 'IL', postal_code: '60610', country: 'US' }, plan: { carrier: 'USPS', tracking: true, signature: false, return_address: true, item_photos: true } },
    { order_id: '3K118842PL907724J', buyer: 'Diego Ruiz', item: 'Leather card wallet', amount: 45, paid_days_ago: 2, ship_to: { line1: 'Oak Street', city: 'Newark', state: 'NJ', postal_code: '', country: 'US' }, paypal_ship_to: { line1: 'Oak Street', city: 'Newark', state: 'NJ', postal_code: '', country: 'US' }, plan: { carrier: 'USPS', tracking: true, signature: false, return_address: false, item_photos: false } },
    { order_id: '6M774410BB120035Q', buyer: 'Ava Thompson', item: 'Ceramic planter', amount: 62, paid_days_ago: 9, ship_to: { line1: '88 Willow Way', city: 'Boston', state: 'MA', postal_code: '02116', country: 'US' }, paypal_ship_to: { line1: '88 Willow Way', city: 'Boston', state: 'MA', postal_code: '02116', country: 'US' }, plan: { carrier: 'UPS', tracking: true, signature: false, return_address: true, item_photos: true } },
    { order_id: '2P663391CV448102R', buyer: 'Noah Patel', item: 'Wool throw blanket', amount: 150, paid_days_ago: 1, ship_to: { line1: '45 Spruce St', city: 'Albany', state: 'NY', postal_code: '12207', country: 'US' }, paypal_ship_to: { line1: '310 State St', city: 'Albany', state: 'NY', postal_code: '12210', country: 'US' }, plan: { carrier: 'USPS', tracking: false, signature: false, return_address: true, item_photos: true } },
    { order_id: '7T220984DD775310S', buyer: 'Emma Rossi', item: 'Hand-poured candle', amount: 28, paid_days_ago: 0, ship_to: { line1: '17 Garden Pl', city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US' }, paypal_ship_to: { line1: '17 Garden Pl', city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US' }, plan: { carrier: 'USPS', tracking: true, signature: false, return_address: true, item_photos: true } },
  ];

  // PayPal's tracking API stores only what the seller uploaded (carrier, number, status).
  // Where and when the package was delivered comes from the carrier's delivery
  // confirmation, which the seller keeps with their own records.
  for (const [txn, t] of Object.entries(tracking)) {
    if (t.delivered_to) {
      sellerRecords[txn].delivery_confirmation = { source: `${t.carrier} delivery confirmation`, delivered_at: t.delivered_at, ...t.delivered_to, signature: t.signature || null };
    }
    delete t.delivered_at; delete t.delivered_to; delete t.signature;
  }

  return { disputes, transactions, tracking, sellerRecords, orders, counter: 1007 };
}

let store = seed();

function reset() { store = seed(); }
function getStore() { return store; }

// Creates a new simulated dispute, used by the "simulate webhook" demo button.
function addSimulatedDispute() {
  const n = store.counter++;
  const txn = `4WS${n}8812NN0047A`;
  const d = makeDispute({ id: `PP-D-${n}`, txn, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', amount: 72, item: 'Macrame wall hanging', buyer: 'Taylor Brooks', openedDaysAgo: 0, dueInDays: 10, buyerMessage: 'Package never showed up.' });
  store.disputes.unshift(d);
  store.transactions[txn] = { transaction_id: txn, order_id: `9Z${n}440TT118822`, date: iso(-11), amount: '72.00', shipping_address: { line1: '503 River Rd', city: 'Trenton', state: 'NJ', postal_code: '08608', country: 'US' } };
  store.tracking[txn] = { carrier: 'USPS', tracking_number: `94001118992${n}55`, status: 'DELIVERED' };
  store.sellerRecords[txn] = { listing: 'Handmade macrame wall hanging, 24 in.', files: [], messages: [], return_policy: '30-day returns.', delivery_confirmation: { source: 'USPS delivery confirmation', delivered_at: iso(-5), city: 'Trenton', state: 'NJ', postal_code: '08608', signature: null } };
  return d;
}

module.exports = { getStore, reset, addSimulatedDispute, disputeLinks };
