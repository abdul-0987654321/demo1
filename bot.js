'use strict';
/**
 * bot.js — Coaching payment-verification WhatsApp bot (demo)
 * Uses the same Baileys stack as your reference clinic bot.
 *
 * npm install @itsliaaa/baileys qrcode pino
 * (plus sharp + tesseract.js from ocr.js)
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');
const store = require('./store');
const ocr = require('./ocr');

const logger = pino({ level: 'silent' });

const runtime = {
  sock: null,
  status: 'stopped',
  qrDataUrl: null,
  me: null,
  connectedAt: null,
  lastError: null,
  reconnectAttempts: 0,
  manualStop: false,
  busy: false,
};

function log(level, message) {
  const prefix = { info: '·', warn: '!', error: 'x', chat: '>' }[level] || '·';
  console.log(`${prefix} ${message}`);
}
function isConnected() { return runtime.status === 'connected' && Boolean(runtime.sock); }
function getStatus() {
  return {
    status: runtime.status,
    qrDataUrl: runtime.status === 'qr' ? runtime.qrDataUrl : null,
    me: runtime.me,
    connectedAt: runtime.connectedAt,
    lastError: runtime.lastError,
  };
}

// ---- send helper (kept simple for the demo — no queue/typing-delay yet) ----
async function send(jid, content) {
  if (!runtime.sock) return { ok: false, error: 'not connected' };
  try {
    await runtime.sock.sendMessage(jid, content);
    store.logChatEvent({ direction: 'out', jid, text: content.text || content.caption || '[interactive]' });
    return { ok: true };
  } catch (err) {
    log('error', `Send failed for ${jid}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function extractText(msg) {
  const m =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.buttonsResponseMessage?.selectedButtonId ||
    ''
  );
}
function hasImage(msg) {
  const m =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message;
  return Boolean(m?.imageMessage);
}

// ---- conversation stages ----
async function sendCoachingPicker(jid) {
  const coachings = store.getSettings().coachings;
  const rows = coachings.map((c) => ({ title: c.label, description: `${c.currency} ${c.price}`, rowId: `coach:${c.id}` }));
  await send(jid, {
    text: 'Welcome! Please choose the coaching program you\'re interested in:',
    buttonText: '📋 Choose a program',
    title: 'Available programs',
    sections: [{ title: 'Coaching programs', rows }],
  });
}
async function sendPaymentInstructions(jid, coaching) {
  const bank = store.getSettings().bankDetails;
  await send(jid, {
    text:
      `You selected *${coaching.label}* (${coaching.currency} ${coaching.price}).\n\n` +
      `Please transfer the amount to:\n` +
      `🏦 Bank: ${bank.bankName}\n` +
      `👤 Account Title: ${bank.accountTitle}\n` +
      `🔢 Account Number: ${bank.accountNumber}\n\n` +
      `Once paid, send a screenshot of the payment confirmation here.`,
  });
}
async function handleCoachingSelection(jid, patient, coachId) {
  const coaching = store.getSettings().coachings.find((c) => c.id === coachId);
  if (!coaching) { await sendCoachingPicker(jid); return; }
  patient.selectedCoaching = coaching.id;
  patient.stage = 'awaiting_screenshot';
  store.savePatient(patient);
  await sendPaymentInstructions(jid, coaching);
}
async function handleScreenshot(jid, patient, msg) {
  await send(jid, { text: 'Got it — reading your payment proof, one moment ⏳' });
  try {
    const receivedAt = new Date().toISOString();
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const ocrResult = await ocr.readPaymentScreenshot(buffer);
    ocrResult.receivedAt = receivedAt;
    log('info', `OCR raw text for ${jid}:\n${ocrResult.rawText}`);

    const { validation } = store.recordPaymentScreenshot(jid, ocrResult);
    patient.stage = 'pending_review';
    store.savePatient(patient);

    if (validation.autoConfirm) {
      log('info', `Auto-confirming payment for ${jid} — all checks passed`);
      await confirmPaymentAndSendLink(jid);
    } else {
      log('info', `Payment for ${jid} held for manual review: ${validation.reasons.join('; ')}`);
      await send(jid, {
        text: 'Thanks! We\'ve received your payment proof and it\'s being reviewed ✅ We\'ll send your group link as soon as it\'s confirmed.',
      });
    }
  } catch (err) {
    log('error', `OCR failed for ${jid}: ${err.message}`);
    await send(jid, { text: 'Sorry, we couldn\'t read that image. Could you resend a clearer screenshot?' });
  }
}

// ---- called from the dashboard when hansimatik clicks Confirm/Reject ----
async function confirmPaymentAndSendLink(jid) {
  const patient = store.confirmPayment(jid);
  if (!patient) return { ok: false, error: 'no pending payment' };
  const coaching = store.getSettings().coachings.find((c) => c.id === patient.selectedCoaching);
  const linkIsPlaceholder = !coaching?.groupLink || coaching.groupLink.includes('REPLACE_');
  patient.stage = 'main';
  store.savePatient(patient);
  if (linkIsPlaceholder) {
    log('warn', `Group link for coaching "${coaching?.id}" is still a placeholder — payment confirmed but link NOT sent to ${jid}`);
    await send(jid, {
      text: `✅ Payment confirmed for *${coaching?.label || 'your coaching'}*! Your group link is being finalized and will be sent to you shortly.`,
    });
    return { ok: true, warning: 'group link placeholder — not sent, needs manual follow-up' };
  }
  await send(jid, {
    text: `✅ Payment confirmed! Here's your group link for *${coaching.label}*:\n${coaching.groupLink}`,
  });
  return { ok: true };
}
async function rejectPaymentAndNotify(jid, reason) {
  const patient = store.rejectPayment(jid, reason);
  if (!patient) return { ok: false, error: 'no pending payment' };
  patient.stage = 'awaiting_screenshot';
  store.savePatient(patient);
  await send(jid, {
    text: `We couldn't verify this payment${reason ? ` (${reason})` : ''}. Please double check and resend a screenshot, or reply here for help.`,
  });
  return { ok: true };
}

// ---- main message router ----
async function handleText(jid, patient, text) {
  const lower = text.trim().toLowerCase();
  if (['hi', 'hello', 'hey', 'menu', 'start'].includes(lower) || patient.stage === 'welcome') {
    patient.stage = 'select_coaching';
    store.savePatient(patient);
    await sendCoachingPicker(jid);
    return;
  }
  if (text.startsWith('coach:') && patient.stage === 'select_coaching') {
    await handleCoachingSelection(jid, patient, text.slice(6));
    return;
  }
  if (patient.stage === 'awaiting_screenshot') {
    await send(jid, { text: 'Please send the payment screenshot as an image so we can verify it 🙏' });
    return;
  }
  if (patient.stage === 'pending_review') {
    await send(jid, { text: 'Your payment is still being reviewed — we\'ll message you as soon as it\'s confirmed.' });
    return;
  }
  await sendCoachingPicker(jid);
}

async function onMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@g.us')) return;

  if (runtime.sock) {
    try {
      await runtime.sock.sendPresenceUpdate('available');
      await runtime.sock.readMessages([msg.key]);
    } catch (err) {
      log('warn', `Failed to mark message as read for ${jid}: ${err.message}`);
    }
  }

  const patient = store.touchPatient(jid, { pushName: msg.pushName });
  const text = extractText(msg).trim();

  if (text) store.logChatEvent({ direction: 'in', jid, name: msg.pushName || '', text });
  log('chat', `${msg.pushName || jid}: ${hasImage(msg) ? '[image]' : text.slice(0, 120)}`);

  if (hasImage(msg) && patient.stage === 'awaiting_screenshot') {
    await handleScreenshot(jid, patient, msg);
    return;
  }
  if (!text) return;
  await handleText(jid, patient, text);
}

// ---- connection lifecycle ----
function detachSocket() {
  if (!runtime.sock) return;
  try { runtime.sock.ev.removeAllListeners(); } catch (_) {}
  try { runtime.sock.end(undefined); } catch (_) {}
  runtime.sock = null;
}
async function start() {
  if (runtime.busy) return { ok: false, message: 'Already starting, please wait.' };
  if (isConnected()) return { ok: true, message: 'Already connected.' };
  runtime.busy = true; runtime.manualStop = false; runtime.lastError = null; runtime.status = 'starting';
  log('info', 'Starting Baileys connection...');
  try {
    detachSocket();
    const { state: authState, saveCreds } = await useMultiFileAuthState('./auth');
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { version = [2, 3000, 1015901307]; }
    const sock = makeWASocket({
      version,
      auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
      logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      browser: ['CoachingPaymentBot', 'Chrome', '120.0.0'],
    });
    runtime.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        runtime.status = 'qr';
        try { runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); log('info', 'New QR generated.'); } catch (err) { log('error', `QR render failed: ${err.message}`); }
      }
      if (connection === 'open') {
        runtime.status = 'connected'; runtime.qrDataUrl = null; runtime.connectedAt = new Date().toISOString();
        runtime.reconnectAttempts = 0;
        runtime.me = { id: sock.user?.id || null, name: sock.user?.name || sock.user?.verifiedName || null };
        log('info', `Connected as ${runtime.me.name || runtime.me.id}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        runtime.qrDataUrl = null;
        if (runtime.manualStop) { runtime.status = 'stopped'; log('info', 'Bot stopped.'); return; }
        if (code === DisconnectReason.loggedOut) {
          runtime.status = 'stopped'; runtime.lastError = 'Device logged out. Scan QR again.';
          log('warn', runtime.lastError); return;
        }
        runtime.reconnectAttempts += 1; runtime.status = 'reconnecting';
        const backoff = Math.min(60000, 3000 * runtime.reconnectAttempts);
        log('warn', `Disconnected (code ${code}). Retrying in ${backoff / 1000}s`);
        setTimeout(() => { if (!runtime.manualStop) void start(); }, backoff).unref?.();
      }
    });
    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages || []) {
        void onMessage(msg);
      }
    });
    return { ok: true, message: 'Bot started. Scan the QR code.' };
  } catch (err) {
    runtime.status = 'stopped'; runtime.lastError = err.message;
    log('error', `Start failed: ${err.message}`);
    return { ok: false, message: err.message };
  } finally { runtime.busy = false; }
}
async function stop() {
  runtime.manualStop = true; detachSocket();
  runtime.status = 'stopped'; runtime.qrDataUrl = null; runtime.me = null; runtime.connectedAt = null;
  log('info', 'Bot stopped manually.');
  await ocr.shutdown();
  return { ok: true, message: 'Bot stopped.' };
}

// ---- HTTP Server & Auto-Start for Render deployment ----
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', botStatus: runtime.status }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  log('info', `HTTP Server running on port ${PORT}`);
  start();
});

module.exports = {
  start,
  stop,
  getStatus,
  isConnected,
  confirmPaymentAndSendLink,
  rejectPaymentAndNotify,
};
