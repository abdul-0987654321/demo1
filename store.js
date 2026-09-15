  'use strict';
/**
 * store.js — Data layer for the payment-verification demo
 * In-memory for speed, backed up to Google Sheets via Apps Script web app (free, zero-cost).
 *
 * IMPORTANT: I don't have the source of your Apps Script (script.google.com/macros/.../exec),
 * only that it responds to POST (doPost exists, doGet doesn't). The postToSheet() function
 * below sends a generic { action, payload } JSON body. Once you share the Apps Script code
 * (or tell me the field names it expects), I'll adjust the payload shape to match exactly —
 * for now this defines the *shape* of what we send so the wiring is a one-line fix either way.
 */

const https = require('https');

// Loaded from .env now instead of being hardcoded — keeps the Sheets webhook
// out of source control and makes it a one-line change per client deployment.
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';

// ---- In-memory state ----
const patients = new Map(); // jid -> patient record
const chatLog = [];         // { at, direction, jid, name, text }
const CHAT_LOG_LIMIT = 1000;

// ---- Static settings for the demo ----
const settings = {
  business: { name: 'Coaching Programs' },
  // All 10 programs are pre-created as placeholders so the picker already shows
  // 10 options in the demo. Replace label/price/groupLink for each once hansimatik
  // confirms the real names, prices, and group invite links — nothing else needs to change.
  coachings: [
    { id: 'c1', label: 'Coaching 1', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c2', label: 'Coaching 2', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c3', label: 'Coaching 3', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c4', label: 'Coaching 4', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c5', label: 'Coaching 5', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c6', label: 'Coaching 6', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c7', label: 'Coaching 7', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c8', label: 'Coaching 8', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c9', label: 'Coaching 9', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
    { id: 'c10', label: 'Coaching 10', price: 10, currency: 'PKR', groupLink: 'https://whatsapp.com/channel/0029Vao4OLg002T97lLNFs2n' },
  ],
  bankDetails: {
    accountTitle: 'Abdul Raheem Qureshi',
    accountNumber: '03371456781',
    bankName: 'Nayapay',
  },
};
function getSettings() { return settings; }

const fs = require('fs');
const path = require('path');

// ---- Persist patients (customers) to disk so restarting the server doesn't wipe "All Customers" ----
const PATIENTS_FILE = path.join(__dirname, 'patients.json');

function loadPatients() {
  try {
    if (fs.existsSync(PATIENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PATIENTS_FILE, 'utf8'));
      for (const p of data) patients.set(p.jid, p);
      console.log(`Loaded ${patients.size} customer(s) from disk.`);
    }
  } catch (err) {
    console.error('Failed to load patients.json:', err.message);
  }
}
function persistPatients() {
  try {
    fs.writeFileSync(PATIENTS_FILE, JSON.stringify(Array.from(patients.values()), null, 2));
  } catch (err) {
    console.error('Failed to save patients.json:', err.message);
  }
}
loadPatients();

// ---- Patient record helpers ----
function getPatient(jid) {
  if (!patients.has(jid)) {
    patients.set(jid, {
      jid,
      name: null,
      pushName: null,
      stage: 'welcome',
      selectedCoaching: null,
      payment: null, // { amount, date, referenceNumber, senderName, confidence, status, screenshotAt } — the CURRENT/latest attempt
      paymentHistory: [], // past payment attempts, oldest first — so a new screenshot never erases what came before
      createdAt: new Date().toISOString(),
    });
  }
  return patients.get(jid);
}
function savePatient(patient) {
  patients.set(patient.jid, patient);
  persistPatients(); // save to disk immediately so a restart doesn't lose it
  void postToSheet('upsertPatient', patient); // fire-and-forget backup (best-effort, ok if it fails)
  return patient;
}
function touchPatient(jid, { pushName } = {}) {
  const p = getPatient(jid);
  if (pushName && !p.pushName) p.pushName = pushName;
  savePatient(p);
  return p;
}
function listPatients() { return Array.from(patients.values()); }

// ---- Fraud checks + smart auto-confirm ----
const USED_REFS_FILE = path.join(__dirname, 'used-references.json');
const usedReferenceNumbers = new Map(); // referenceNumber -> jid that used it first

// Load previously-used reference numbers on startup so duplicate detection
// survives server restarts (this was the actual bug — it was memory-only before).
function loadUsedReferences() {
  try {
    if (fs.existsSync(USED_REFS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USED_REFS_FILE, 'utf8'));
      for (const [ref, jid] of Object.entries(data)) usedReferenceNumbers.set(ref, jid);
      console.log(`Loaded ${usedReferenceNumbers.size} used reference number(s) from disk.`);
    }
  } catch (err) {
    console.error('Failed to load used-references.json:', err.message);
  }
}
function saveUsedReferences() {
  try {
    const obj = Object.fromEntries(usedReferenceNumbers);
    fs.writeFileSync(USED_REFS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Failed to save used-references.json:', err.message);
  }
}
loadUsedReferences();

const MAX_SLIP_AGE_HOURS = 48; // reject/flag screenshots whose printed date is older than this
const MAX_SLIP_TIME_GAP_MINUTES = 30; // flag if the slip's own time is far from when the screenshot was actually sent
const AMOUNT_TOLERANCE = 1; // allow small rounding differences (e.g. bank fee display quirks)

function parseSlipDate(dateStr) {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed;
  return null; // couldn't parse — treated as unverifiable, not auto-trusted
}

/**
 * Runs fraud/sanity checks on an OCR result and decides whether it's safe to auto-confirm.
 * Returns { autoConfirm: boolean, reasons: string[] } — reasons explains any failed checks,
 * shown in the dashboard so a human reviewer knows exactly what to double check.
 */
function validatePayment(jid, ocrResult, coaching) {
  const reasons = [];

  // 1. Confidence must be high — low/medium reads are never auto-confirmed
  if (ocrResult.confidence !== 'high') reasons.push('OCR confidence not high enough');

  // 2. Reference number must be present and not already used (by anyone, including a resend from the same customer —
  //    a real payment should only ever be confirmed once)
  if (!ocrResult.referenceNumber) {
    reasons.push('No reference/transaction number found');
  } else if (usedReferenceNumbers.has(ocrResult.referenceNumber)) {
    const existingJid = usedReferenceNumbers.get(ocrResult.referenceNumber);
    const who = existingJid === jid ? 'this same customer (resend)' : 'a different customer';
    reasons.push(`Reference number already used before by ${who} — possible reused screenshot`);
  }

  // 3. Slip date must be present, parseable, and recent
  const slipDate = parseSlipDate(ocrResult.date);
  if (!slipDate) {
    reasons.push('Could not verify the date on the slip');
  } else {
    const ageHours = (Date.now() - slipDate.getTime()) / 3600000;
    if (ageHours > MAX_SLIP_AGE_HOURS) reasons.push(`Slip date is ${Math.round(ageHours)}h old (screenshot may be reused)`);
    if (ageHours < -1) reasons.push('Slip date is in the future — suspicious');

    // 3b. Compare the slip's own printed TIME against when the screenshot message actually arrived.
    // Catches same-day reused screenshots (e.g. a morning slip resent in the evening) that would
    // otherwise pass the day-level age check above.
    if (ocrResult.receivedAt) {
      const receivedDate = new Date(ocrResult.receivedAt);
      if (!isNaN(receivedDate.getTime())) {
        const gapMinutes = Math.abs(receivedDate.getTime() - slipDate.getTime()) / 60000;
        if (gapMinutes > MAX_SLIP_TIME_GAP_MINUTES) {
          reasons.push(`Slip time is ${Math.round(gapMinutes)} min apart from when it was sent (possible reused screenshot)`);
        }
      }
    }
  }

  // 4. Recipient must be YOUR business account — this is the strongest check, since a customer could
  //    send a real, valid, recent screenshot... of a payment to someone else's account entirely.
  const bank = settings.bankDetails;
  const normalizeAcct = (s) => (s || '').replace(/\D/g, ''); // digits only, so spacing/dashes don't cause false mismatches
  const normalizeName = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

  if (!ocrResult.recipientAccountNumber && !ocrResult.recipientName) {
    reasons.push('Could not read who the payment was sent to — cannot verify it reached your account');
  } else {
    if (ocrResult.recipientAccountNumber) {
      const gotAcct = normalizeAcct(ocrResult.recipientAccountNumber);
      const wantAcct = normalizeAcct(bank.accountNumber);
      // allow the slip to show only the last few digits of a longer account number
      const acctMatches = gotAcct && wantAcct && (gotAcct === wantAcct || wantAcct.endsWith(gotAcct) || gotAcct.endsWith(wantAcct));
      if (!acctMatches) reasons.push(`Recipient account number (${ocrResult.recipientAccountNumber}) does not match your business account — payment may have gone to the wrong account`);
    }
    if (ocrResult.recipientName) {
      const nameMatches = normalizeName(ocrResult.recipientName) === normalizeName(bank.accountTitle);
      if (!nameMatches) reasons.push(`Recipient name on slip ("${ocrResult.recipientName}") does not match your business account name ("${bank.accountTitle}")`);
    }
  }

  // 5. Amount must match the selected coaching's price (and currency, if we could read it)
  if (coaching && ocrResult.amount != null) {
    if (ocrResult.currency && coaching.currency && ocrResult.currency !== coaching.currency) {
      reasons.push(`Currency mismatch: slip shows ${ocrResult.currency}, expected ${coaching.currency}`);
    }
    if (Math.abs(ocrResult.amount - coaching.price) > AMOUNT_TOLERANCE) {
      reasons.push(`Amount (${ocrResult.amount}) doesn't match expected price (${coaching.price})`);
    }
  } else {
    reasons.push('Could not verify amount against expected price');
  }

  return { autoConfirm: reasons.length === 0, reasons };
}

function markReferenceUsed(referenceNumber, jid) {
  if (referenceNumber) {
    usedReferenceNumbers.set(referenceNumber, jid);
    saveUsedReferences();
  }
}

// ---- Payment record helpers ----
function recordPaymentScreenshot(jid, ocrResult) {
  const p = getPatient(jid);
  const coaching = settings.coachings.find((c) => c.id === p.selectedCoaching);
  const validation = validatePayment(jid, ocrResult, coaching);

  // Archive whatever payment attempt was there before — pending, confirmed, or rejected —
  // so a new screenshot never silently erases the record of the last one.
  if (p.payment) {
    if (!Array.isArray(p.paymentHistory)) p.paymentHistory = [];
    p.paymentHistory.push(p.payment);
  }

  p.payment = {
    ...ocrResult,
    status: 'pending', // pending | confirmed | rejected
    screenshotAt: new Date().toISOString(),
    autoConfirmEligible: validation.autoConfirm,
    flagReasons: validation.reasons,
  };
  savePatient(p);
  void postToSheet('logPendingPayment', { jid, coaching: p.selectedCoaching, payment: p.payment });
  return { patient: p, validation };
}
function confirmPayment(jid) {
  const p = getPatient(jid);
  if (!p.payment) return null;
  p.payment.status = 'confirmed';
  p.payment.confirmedAt = new Date().toISOString();
  savePatient(p);
  markReferenceUsed(p.payment.referenceNumber, jid);
  void postToSheet('confirmPayment', { jid, coaching: p.selectedCoaching, payment: p.payment });
  return p;
}
function rejectPayment(jid, reason) {
  const p = getPatient(jid);
  if (!p.payment) return null;
  p.payment.status = 'rejected';
  p.payment.rejectedAt = new Date().toISOString();
  p.payment.rejectReason = reason || null;
  savePatient(p);
  void postToSheet('rejectPayment', { jid, coaching: p.selectedCoaching, payment: p.payment });
  return p;
}
function listPendingPayments() {
  return listPatients().filter((p) => p.payment && p.payment.status === 'pending');
}
function getPaymentHistory(jid) {
  const p = getPatient(jid);
  return Array.isArray(p.paymentHistory) ? p.paymentHistory : [];
}

// ---- Chat log ----
function logChatEvent({ direction, jid, name, text }) {
  const entry = { at: new Date().toISOString(), direction, jid, name: name || '', text: text || '' };
  chatLog.push(entry);
  while (chatLog.length > CHAT_LOG_LIMIT) chatLog.shift();
  void postToSheet('logChatEvent', entry);
  return entry;
}
function getChatLog(jid, limit = 100) {
  const filtered = jid ? chatLog.filter((e) => e.jid === jid) : chatLog;
  return filtered.slice(-limit);
}

// ---- Google Sheets backup (via Apps Script web app) ----
function postToSheet(action, payload) {
  return new Promise((resolve) => {
    if (!SHEET_WEBHOOK_URL) return resolve({ ok: false, error: 'SHEET_WEBHOOK_URL not set — skipping backup' });
    try {
      const body = JSON.stringify({ action, payload, at: new Date().toISOString() });
      const url = new URL(SHEET_WEBHOOK_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, data }));
        }
      );
      req.on('error', (err) => {
        console.error('Sheet backup failed:', err.message);
        resolve({ ok: false, error: err.message });
      });
      req.write(body);
      req.end();
    } catch (err) {
      console.error('Sheet backup error:', err.message);
      resolve({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  getSettings,
  getPatient,
  savePatient,
  touchPatient,
  listPatients,
  recordPaymentScreenshot,
  validatePayment,
  confirmPayment,
  rejectPayment,
  listPendingPayments,
  getPaymentHistory,
  logChatEvent,
  getChatLog,
  postToSheet,
};