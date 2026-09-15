'use strict';
/**
 * ocr.js — Payment screenshot reader
 * Free, zero-cost OCR pipeline: sharp (preprocessing) + tesseract.js (OCR) + regex (parsing)
 *
 * npm install sharp tesseract.js
 */

const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

let worker = null;

/**
 * Starts (or reuses) a single long-lived Tesseract worker.
 * Reusing the worker avoids reloading the OCR engine on every screenshot.
 */
async function getWorker() {
  if (worker) return worker;
  worker = await createWorker('eng');
  return worker;
}

/**
 * Preprocess the raw screenshot buffer to improve OCR accuracy.
 * Bank app screenshots often have colored/gradient backgrounds — converting
 * to grayscale, boosting contrast, and upscaling small screenshots helps a lot.
 */
async function preprocessImage(buffer) {
  return sharp(buffer)
    .resize({ width: 1200, withoutEnlargement: false }) // upscale small screenshots
    .grayscale()
    .normalize() // auto contrast stretch
    .sharpen()
    .toBuffer();
}

/**
 * Runs OCR on a preprocessed image buffer and returns raw extracted text.
 */
async function extractText(buffer) {
  const w = await getWorker();
  const { data } = await w.recognize(buffer);
  return data.text || '';
}

/**
 * Parses raw OCR text into structured payment fields.
 * Tuned for common bank-transfer confirmation screenshot patterns.
 * Extend the regex patterns as you see real screenshots from hansimatik's bank.
 */
/**
 * Normalizes OCR-read currency symbols/labels into standard 3-letter codes.
 * "Rs", "Rs.", "PKR" -> "PKR" ; "$", "USD" -> "USD" ; "€", "EUR" -> "EUR"
 * This fixes mismatches like slip showing "RS" while coaching price is set in "PKR".
 */
function normalizeCurrency(raw) {
  if (!raw) return null;
  const cleaned = raw.replace('.', '').toUpperCase().trim();
  if (['RS', 'PKR'].includes(cleaned)) return 'PKR';
  if (['$', 'USD'].includes(cleaned)) return 'USD';
  if (['€', 'EUR'].includes(cleaned)) return 'EUR';
  return cleaned || null;
}

function parsePaymentText(rawText) {
  const text = rawText.replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const joined = lines.join(' ');

  const result = {
    amount: null,
    currency: null,
    date: null,
    referenceNumber: null,
    senderName: null,
    recipientName: null,
    recipientAccountNumber: null,
    rawText: text,
    confidence: 'low',
  };

  // Amount: the keyword ("total amount" / "amount") is now REQUIRED, not optional —
  // this stops it from grabbing unrelated numbers like a Transaction ID.
  // "Total Amount" is checked first since it's the final confirmed figure on most receipts.
  const amountRegexes = [
    /total\s*amount\s*[:\-]?\s*(PKR|Rs\.?|USD|\$|€|EUR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\bamount\s*[:\-]?\s*(PKR|Rs\.?|USD|\$|€|EUR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const re of amountRegexes) {
    const m = joined.match(re);
    if (m) {
      const numeric = m[2].replace(/,/g, '');
      if (numeric && !isNaN(parseFloat(numeric))) {
        result.amount = parseFloat(numeric);
        result.currency = normalizeCurrency(m[1]);
        break;
      }
    }
  }

  // Date: prefer text right after "Date & Time" / "Date" label; fall back to a bare date pattern
  const dateLabelMatch = joined.match(/date\s*(?:&\s*time)?\s*[:\-]?\s*([A-Za-z0-9,: ]{6,35}?)(?=\s{2,}|\s+[A-Z][a-z]+\s*[:\-]|$)/i);
  const dateBareMatch = joined.match(
    /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\-\s]+[A-Za-z]{3,9}[\-\s]+\d{4}(?:,?\s*\d{1,2}:\d{2}\s*[AP]M)?)\b/
  );
  if (dateLabelMatch) result.date = dateLabelMatch[1].trim();
  else if (dateBareMatch) result.date = dateBareMatch[1];

  // Reference / transaction number: now allows a "#" between the label and the digits
  const refMatch = joined.match(
    /(?:ref(?:erence)?\.?\s*(?:no\.?|number)?|txn\.?\s*(?:id)?|transaction\s*(?:id|no\.?))\s*[:\-]?\s*#?\s*([A-Za-z0-9\-]{4,20})/i
  );
  if (refMatch) result.referenceNumber = refMatch[1];

  // Sender name: supports "Sent by ... Name X" layout (easypaisa/JazzCash/NayaPay style)
  // as well as the older "From:"/"Sender:" style.
  const sentByMatch = joined.match(/sent\s*by[\s\S]{0,40}?name\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40}?)(?=\s{2,}|\s+account|\s+number|$)/i);
  const genericSenderMatch = joined.match(/(?:from|sender)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40})/i);
  if (sentByMatch) result.senderName = sentByMatch[1].trim();
  else if (genericSenderMatch) result.senderName = genericSenderMatch[1].trim();

  // Recipient name: "Sent to ... Name X" (older layout) OR "Destination Acc. Title" (easypaisa/JazzCash/NayaPay
  // "additional information" block, e.g. patients.json's real sample). Check both — this is the field that tells
  // us whether the money actually landed in *your* business account, so it's important to catch either layout.
  const sentToMatch = joined.match(/sent\s*to[\s\S]{0,40}?name\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40}?)(?=\s{2,}|\s+raast|\s+iban|\s+bank|\s+account|$)/i);
  const destTitleMatch = joined.match(/destination\s*acc(?:ount|\.)?\s*title\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40}?)(?=\s{2,}|\s+destination|\s+bank|$)/i);
  if (sentToMatch) result.recipientName = sentToMatch[1].trim();
  else if (destTitleMatch) result.recipientName = destTitleMatch[1].trim();

  // Recipient/destination account number — compare this against your real business account number in store.js.
  // This is the single strongest fraud check: OCR confidence, dates, and amounts can all coincidentally look fine,
  // but if the money didn't go to *your* account number, the payment is not valid, full stop.
  const destAcctMatch = joined.match(/destination\s*acc(?:ount|\.)?\s*number\s*[:\-]?\s*(\d[\d\s]{3,20}\d)/i);
  if (destAcctMatch) result.recipientAccountNumber = destAcctMatch[1].replace(/\s+/g, '');

  // Confidence heuristic: how many fields did we manage to extract
  const fieldsFound = [result.amount, result.date, result.referenceNumber, result.senderName, result.recipientName, result.recipientAccountNumber]
    .filter(Boolean).length;
  result.confidence = fieldsFound >= 4 ? 'high' : fieldsFound >= 2 ? 'medium' : 'low';

  return result;
}

/**
 * Main entry point: takes a raw screenshot buffer, returns structured payment data.
 * If GROQ_API_KEY is set, uses the free Groq vision model (vision-ocr.js) — much more
 * accurate on real bank-slip layouts and returns structured fields directly, no regex needed.
 * Falls back to the local tesseract pipeline below if no key is set, or if the AI call fails
 * for any reason (rate limit, network issue, etc.) — so a screenshot is never silently dropped.
 */
async function readPaymentScreenshot(imageBuffer) {
  if (process.env.GROQ_API_KEY) {
    try {
      console.log('· Reading screenshot with Groq AI vision...');
      const { readPaymentScreenshotAI } = require('./vision-ocr');
      return await readPaymentScreenshotAI(imageBuffer);
    } catch (err) {
      console.error('AI vision OCR failed, falling back to tesseract:', err.message);
    }
  } else {
    console.log('· GROQ_API_KEY not set — using local tesseract OCR (slower, less accurate).');
  }
  const processed = await preprocessImage(imageBuffer);
  const rawText = await extractText(processed);
  const parsed = parsePaymentText(rawText);
  return parsed;
}

async function shutdown() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

module.exports = { readPaymentScreenshot, parsePaymentText, shutdown };