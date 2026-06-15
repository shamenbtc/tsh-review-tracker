// api/classify.js
// Single-review classification endpoint (called by the intake form).
// All prompt + parsing + validation logic lives in classifier.js so this path
// and the bulk-classify path can never diverge.

import { classify } from './classifier.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TSH-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Shared-secret gate: blocks drive-by use from anyone who discovers the URL.
  const requiredKey = process.env.TSH_INTAKE_KEY;
  if (requiredKey && req.headers['x-tsh-key'] !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables' });
  }

  const { platform, roomNumber, roomType, rating, checkinDate, reviewText } = req.body;
  if (!reviewText || !platform || !roomNumber) {
    return res.status(400).json({ error: 'Missing required fields: reviewText, platform, roomNumber' });
  }

  try {
    const result = await classify(
      { platform, roomNumber, roomType, rating, checkinDate, reviewText },
      apiKey
    );
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Classification failed' });
  }
}
