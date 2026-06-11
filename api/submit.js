// api/submit.js
// Appends a new review row to Supabase.
// The row array arrives from the intake form in column order (A–AA).
// We map it to named fields before inserting.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TSH-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret gate
  const requiredKey = process.env.TSH_INTAKE_KEY;
  if (requiredKey && req.headers['x-tsh-key'] !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = 'https://nhckdbehipfibgesnkwj.supabase.co';
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });

  const { row } = req.body;
  if (!row || !Array.isArray(row)) {
    return res.status(400).json({ error: 'Missing row array' });
  }

  // Column mapping (matches intake form row array order A–AA)
  // Strip apostrophe prefix used to prevent Google Sheets date interpretation
  const clean = v => typeof v === 'string' ? v.replace(/^'+/, '').trim() : v;
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const toDate = v => {
    if (!v) return null;
    const s = clean(v);
    // YYYY-MM-DD (ISO — from browser date picker direct)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD-Mon-YYYY (from fmtDate in intake form e.g. "10-Jun-2026")
    const m2 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m2) {
      const mo = MONTHS[m2[2].toLowerCase()];
      if (mo) return `${m2[3]}-${String(mo).padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    }
    // DD/MM/YYYY or DD-MM-YYYY
    const m3 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m3) return `${m3[3]}-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`;
    return null;
  };
  const toInt  = v => { const n = parseInt(v); return isNaN(n) ? null : n; };
  const toBool = v => ['yes','true','1'].includes(String(v||'').toLowerCase().trim());

  const record = {
    check_in_date:       toDate(row[0]),
    check_out_date:      toDate(row[1]),
    nights_stayed:       toInt(row[2]),
    review_month:        clean(row[3]) || null,
    platform:            clean(row[4]) || null,
    booking_number:      clean(row[5]) || null,
    room_number:         clean(row[6]) || null,
    room_type:           clean(row[7]) || null,
    guest_country:       clean(row[8]) || null,
    rating:              clean(row[9]) || null,
    review_text:         clean(row[10]) || null,
    mentioned_staff:     clean(row[11]) || null,
    // row[12] = Verified Stay — no longer collected, skip
    sentiment:           clean(row[13]) || null,
    category:            clean(row[14]) || null,
    subcategory:         clean(row[15]) || null,
    complaint_summary:   clean(row[16]) || null,
    severity:            toInt(row[17]),
    maintenance_flag:    toBool(row[18]),
    hskp_flag:           toBool(row[19]),
    suggested_action:    clean(row[20]) || null,
    resolution_status:   clean(row[21]) || 'Open',
    resolved_date:       toDate(row[22]),
    assigned_department: clean(row[23]) || null,
    assigned_staff:      clean(row[24]) || null,
    resolution_notes:    clean(row[25]) || null,
    last_updated:        new Date().toISOString()
  };

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/reviews`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(record)
    });

    if (!resp.ok) {
      const err = await resp.text();
      // Duplicate booking number — friendly message
      if (resp.status === 409 || err.includes('unique_booking_number')) {
        return res.status(409).json({
          error: `A review with booking number "${record.booking_number}" already exists. Check the duplicate checker on the Data tab.`
        });
      }
      return res.status(500).json({ error: `Supabase error (${resp.status}): ${err}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Submission failed' });
  }
}
