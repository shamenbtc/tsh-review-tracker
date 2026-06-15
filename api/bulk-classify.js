// api/bulk-classify.js
// Reads unclassified rows from Supabase, classifies with Claude, writes back.
// Actions: preview, classify-one, write
// Classification logic is imported from classifier.js (shared with classify.js)
// so the two paths can never produce different results for the same review.

import { classify } from './classifier.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TSH-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const requiredKey = process.env.TSH_INTAKE_KEY;
  if (requiredKey && req.headers['x-tsh-key'] !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = 'https://nhckdbehipfibgesnkwj.supabase.co';
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const apiKey       = process.env.ANTHROPIC_API_KEY;

  if (!apiKey)     return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });

  const sbHeaders = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const { action, row } = req.body;

  // ── ACTION: preview — return rows missing classification ──────────────────
  if (action === 'preview') {
    try {
      // Rows where sentiment is null OR empty string — both mean "unclassified".
      // (A plain sentiment=is.null misses rows that were written with '' instead of NULL,
      // which would otherwise be invisible to this tool forever.)
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/reviews?or=(sentiment.is.null,sentiment.eq.)&select=id,check_in_date,platform,booking_number,room_number,room_type,rating,review_text,sentiment,category,severity&order=check_in_date.desc`,
        { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
      );
      if (!resp.ok) throw new Error(`Supabase read failed: ${resp.status}`);
      const rows = await resp.json();

      // Map to the shape the bulk-classify UI expects
      const mapped = rows.map(r => ({
        supabaseId:  r.id,
        checkIn:     r.check_in_date || '',
        platform:    r.platform || '',
        booking:     r.booking_number || '',
        room:        r.room_number || '',
        roomType:    r.room_type || '',
        rating:      r.rating || '',
        text:        r.review_text || '',
        sentiment:   r.sentiment || '',
        category:    r.category || '',
        severity:    r.severity || ''
      }));

      return res.status(200).json({ rows: mapped });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION: classify-one — classify a single row with Claude ─────────────
  if (action === 'classify-one') {
    if (!row) return res.status(400).json({ error: 'Missing row data' });
    try {
      // Map bulk row field names to the shared classifier's expected shape
      const result = await classify({
        platform:    row.platform,
        roomNumber:  row.room,
        roomType:    row.roomType,
        rating:      row.rating,
        checkinDate: row.checkIn,
        reviewText:  row.text
      }, apiKey);
      return res.status(200).json(result);
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION: write — write classification back to Supabase row ────────────
  if (action === 'write') {
    if (!row) return res.status(400).json({ error: 'Missing row data' });
    const { supabaseId, classification } = row;
    if (!supabaseId) return res.status(400).json({ error: 'Missing supabaseId' });

    try {
      const updates = {
        sentiment:           classification.sentiment           || null,
        category:            classification.category            || null,
        subcategory:         classification.subcategory         || null,
        complaint_summary:   classification.complaint_summary   || null,
        severity:            classification.severity            ? parseInt(classification.severity) : null,
        maintenance_flag:    ['yes','true','1'].includes(String(classification.maintenance_flag||'').toLowerCase()),
        hskp_flag:           ['yes','true','1'].includes(String(classification.hskp_flag||'').toLowerCase()),
        suggested_action:    classification.suggested_action    || null,
        resolution_status:   classification.resolution_status   || 'Open',
        assigned_department: classification.assigned_department || null,
        last_updated:        new Date().toISOString()
      };

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/reviews?id=eq.${supabaseId}`,
        { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(updates) }
      );

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Supabase write failed (${resp.status}): ${err}`);
      }

      return res.status(200).json({ success: true });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: preview, classify-one, write' });
}
