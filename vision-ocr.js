'use strict';
/**
 * vision-ocr.js — Payment screenshot reader using Groq's free vision API
 *
 * Free tier: no credit card needed. Rate limits apply (currently roughly
 * 30 requests/min, ~14,400/day per org) — check https://console.groq.com/docs/rate-limits
 * for the current numbers before relying on this for real volume.
 *
 * Setup:
 *   npm install groq-sdk
 *   Get a free key at https://console.groq.com/keys and set it as GROQ_API_KEY
 *   (export GROQ_API_KEY=... or put it in a .env file if you add dotenv).
 *
 * This is a drop-in replacement for ocr.js's readPaymentScreenshot() — same
 * return shape — so bot.js doesn't need to change at all. ocr.js decides
 * whether to use this (if GROQ_API_KEY is set) or fall back to tesseract.
 */

const Groq = require('groq-sdk');
const sharp = require('sharp');

// Model deprecates and gets renamed occasionally — override with GROQ_VISION_MODEL
// if Groq retires this one. Check https://console.groq.com/docs/vision for the current name.
const MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

let client = null;
function getClient() {
  if (!process.env.GROQ_API_KEY) return null;
  if (!client) client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return client;
}

const EXTRACTION_PROMPT = `You are reading a bank/mobile-wallet payment confirmation screenshot (easypaisa, JazzCash, NayaPay, or a similar Pakistani bank transfer receipt).

Extract the following fields EXACTLY as printed on the slip and return ONLY a JSON object, no other text:
{
  "amount": <number or null>,
  "currency": "<PKR|USD|EUR|... or null>",
  "date": "<the date/time exactly as printed, or null>",
  "referenceNumber": "<transaction/reference ID, or null>",
  "senderName": "<the sender's account title, or null>",
  "recipientName": "<the destination/recipient account title, or null>",
  "recipientAccountNumber": "<the destination account number, digits only, or null>",
  "confidence": "<'high' if the image is clear and all key fields are legible, 'medium' if some fields are blurry or missing, 'low' if the image is hard to read>"
}

Rules:
- If a field is not visible on the slip, use null — never guess or invent a value.
- amount must be a plain number (no currency symbols, no commas).
- recipientAccountNumber must contain only digits (strip spaces/dashes).
- Return ONLY the JSON object, nothing else.`;

async function toJpegBase64(imageBuffer) {
  const jpeg = await sharp(imageBuffer)
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return jpeg.toString('base64');
}

/**
 * Reads a payment screenshot using Groq's free-tier vision model.
 * Returns the same field shape as ocr.js's parsePaymentText() result.
 */
async function readPaymentScreenshotAI(imageBuffer) {
  const groq = getClient();
  if (!groq) throw new Error('GROQ_API_KEY not set — cannot use AI vision OCR');

  const base64Image = await toJpegBase64(imageBuffer);

  const completion = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    reasoning_effort: 'none', // this is a simple extraction task — thinking mode just burns the token budget on hidden reasoning and leaves nothing for the actual JSON answer
    reasoning_format: 'hidden', // safety net: if the model reasons anyway, keep it out of message.content
    temperature: 0.2, // qwen's docs recommend ~0.7 for non-thinking mode; a bit of room helps it commit to an answer instead of stalling
    max_completion_tokens: 600, // free tier caps this model at ~1000 output tokens/min — our JSON schema is tiny, 600 is generous headroom
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACTION_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Groq returned non-JSON response: ${raw.slice(0, 200)}`);
  }

  return {
    amount: typeof parsed.amount === 'number' ? parsed.amount : (parseFloat(parsed.amount) || null),
    currency: parsed.currency || null,
    date: parsed.date || null,
    referenceNumber: parsed.referenceNumber || null,
    senderName: parsed.senderName || null,
    recipientName: parsed.recipientName || null,
    recipientAccountNumber: parsed.recipientAccountNumber ? String(parsed.recipientAccountNumber).replace(/\D/g, '') : null,
    rawText: raw, // keep the model's raw JSON for the dashboard/logs, same slot ocr.js used for tesseract's raw text
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
  };
}

module.exports = { readPaymentScreenshotAI };