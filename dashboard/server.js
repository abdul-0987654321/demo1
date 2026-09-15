'use strict';
/**
 * dashboard/server.js — Express server powering the dashboard UI
 * Serves the frontend + a small JSON API on top of bot.js / store.js
 *
 * npm install express
 * Run from project root: node dashboard/server.js
 */

const path = require('path');
const crypto = require('crypto');
require('dotenv').config(); // load PORT / DASH_PASSWORD / GROQ_API_KEY / SHEET_WEBHOOK_URL from .env
const express = require('express');
const bot = require('../bot');
const store = require('../store');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DASH_PASSWORD = process.env.DASH_PASSWORD || 'dash123';

// ---- very simple password gate for the demo (header-based) ----
function requireAuth(req, res, next) {
  const pass = req.header('x-dash-password') || req.query.password || '';
  // timing-safe comparison instead of !== — avoids leaking password length/content via response timing
  const a = Buffer.from(String(pass));
  const b = Buffer.from(String(DASH_PASSWORD));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// ---- bot status + QR (for linking WhatsApp) ----
app.get('/api/status', requireAuth, (req, res) => {
  res.json({ ok: true, status: bot.getStatus() });
});
app.post('/api/bot/start', requireAuth, async (req, res) => {
  const result = await bot.start();
  res.json(result);
});
app.post('/api/bot/stop', requireAuth, async (req, res) => {
  const result = await bot.stop();
  res.json(result);
});

// ---- pending payments queue ----
app.get('/api/payments/pending', requireAuth, (req, res) => {
  const pending = store.listPendingPayments().map((p) => ({
    jid: p.jid,
    name: p.name || p.pushName || p.jid,
    coaching: p.selectedCoaching,
    payment: p.payment,
  }));
  res.json({ ok: true, pending });
});
app.post('/api/payments/:jid/confirm', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const result = await bot.confirmPaymentAndSendLink(jid);
  res.json(result);
});
app.post('/api/payments/:jid/reject', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const result = await bot.rejectPaymentAndNotify(jid, req.body?.reason);
  res.json(result);
});

// ---- all customers + chat overview ----
app.get('/api/customers', requireAuth, (req, res) => {
  const customers = store.listPatients().map((p) => ({
    jid: p.jid,
    name: p.name || p.pushName || p.jid,
    stage: p.stage,
    coaching: p.selectedCoaching,
    paymentStatus: p.payment?.status || null,
  }));
  res.json({ ok: true, customers });
});
app.get('/api/customers/:jid/chat', requireAuth, (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json({ ok: true, chat: store.getChatLog(jid, 200) });
});
app.get('/api/customers/:jid/payment-history', requireAuth, (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json({ ok: true, history: store.getPaymentHistory(jid) });
});

// ---- coaching programs (for the dashboard to display) ----
app.get('/api/coachings', requireAuth, (req, res) => {
  res.json({ ok: true, coachings: store.getSettings().coachings });
});

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT} (password: ${DASH_PASSWORD})`);
  void bot.start(); // auto-start the WhatsApp connection when the dashboard boots
});