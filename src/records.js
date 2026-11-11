'use strict';

// The seller's own records per transaction (listing, files, messages, return policy).
// Mock mode keeps them in memory; sandbox mode saves them to data/seller-records.json.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const mock = require('./paypal/mock');

const FILE = path.join('data', 'seller-records.json');

function load() {
  if (config.paypalMode === 'mock') return mock.getStore().sellerRecords;
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(all) {
  if (config.paypalMode === 'mock') return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function blank() { return { listing: null, files: [], messages: [], return_policy: null }; }

function get(transactionId) {
  const all = load();
  return all[transactionId] ? structuredClone(all[transactionId]) : null;
}

function update(transactionId, patch) {
  const all = load();
  const current = all[transactionId] || blank();
  for (const key of ['listing', 'return_policy']) if (typeof patch[key] === 'string') current[key] = patch[key].slice(0, 2000);
  if (typeof patch.message === 'string' && patch.message.trim()) current.messages.push(patch.message.trim().slice(0, 2000));
  if (patch.delivery_confirmation && typeof patch.delivery_confirmation === 'object') {
    const dc = patch.delivery_confirmation;
    const s = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    current.delivery_confirmation = {
      source: s(dc.source) || 'Carrier delivery confirmation',
      delivered_at: s(dc.delivered_at), city: s(dc.city), state: s(dc.state),
      postal_code: s(dc.postal_code), signature: s(dc.signature),
    };
  }
  all[transactionId] = current;
  save(all);
  return structuredClone(current);
}

function addFile(transactionId, file) {
  const all = load();
  const current = all[transactionId] || blank();
  current.files.push({ name: file.originalname, kind: file.kind || 'other', stored: file.filename, mimetype: file.mimetype, size: file.size });
  all[transactionId] = current;
  save(all);
  return structuredClone(current);
}

function filePaths(transactionId) {
  const rec = get(transactionId);
  if (!rec) return [];
  return rec.files.filter((f) => f.stored).map((f) => ({
    path: path.join(config.uploadDir, f.stored), originalname: f.name, mimetype: f.mimetype,
  }));
}

module.exports = { get, update, addFile, filePaths };
