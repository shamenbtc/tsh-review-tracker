// api/bulk-classify.js
// Reads unclassified rows from Supabase, classifies with Claude, writes back.
// Actions: preview, classify-one, write

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
      // Rows where sentiment is null or empty
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/reviews?sentiment=is.null&select=id,check_in_date,platform,booking_number,room_number,room_type,rating,review_text,sentiment,category,severity&order=check_in_date.desc`,
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
      const result = await classifyWithClaude(row, apiKey);
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

// ── CLASSIFY WITH CLAUDE ───────────────────────────────────────────────────
async function classifyWithClaude(row, apiKey) {
  const prompt = `You are a hotel operations analyst for The Sultan Hotel Singapore.
Analyse this guest input and return a JSON object with ALL fields filled.

The input may be one of two formats:
1. A written guest review (narrative text)
2. A ratings-only entry — sub-category scores copied from a booking platform, e.g.:
   "Staff 10 / Cleanliness 10 / Location 7.5 / Comfort 10 / Room view 5"

For ratings-only entries: infer sentiment from the overall rating and sub-scores. A sub-score below 6 is a weak point — treat it as a mild complaint signal. No written complaint means severity is at most 2 unless a sub-score is below 5. Set complaint_summary to the weakest sub-category if any score is below 7, otherwise leave empty.

Review details:
- Platform: ${row.platform}
- Room: ${row.room} (${row.roomType || 'unknown'})
- Rating: ${row.rating}
- Check-in: ${row.checkIn}
- Review text / ratings: ${row.text}

Return ONLY valid JSON, no markdown, no explanation:
{
  "sentiment": "Positive" | "Neutral" | "Negative",
  "category": "Room Comfort & Quality" | "Cleanliness" | "Staff" | "Facilities" | "Value for Money" | "F&B" | "Location" | "Other",
  "subcategory": string,
  "complaint_summary": string (5-10 words or empty if no issues),
  "severity": 1 | 2 | 3 | 4 | 5,
  "maintenance_flag": "Yes" | "No",
  "hskp_flag": "Yes" | "No",
  "suggested_action": string,
  "resolution_status": "Open" | "Resolved" | "Escalated" | "In Progress" | "Monitoring",
  "assigned_department": "Engineering" | "Housekeeping" | "Front Office" | "F&B" | "Management" | ""
}

CATEGORY SELECTION — read carefully:
- "Location" = anything about the hotel's surroundings: neighbourhood, nearby food/restaurants, MRT/transport, walking distance to attractions. Example: "great location, near eating places, MRT within walking distance" = Location, NOT Room Comfort.
- "Room Comfort & Quality" = ONLY the room itself: bed, furniture, size, temperature, noise inside the room.
- A positive review praising the location is a "Location" review.

SUBCATEGORY — must come from the actual text:
- NEVER default to "HVAC" unless the review genuinely refers to air-conditioning, heating, or ventilation.
- If no specific sub-topic is mentioned, use "General".

Rules:
- sentiment = overall guest experience
- Positive reviews CAN have maintenance_flag/hskp_flag = Yes if physical issue mentioned
- For ratings-only: if Room view, Comfort, or Facilities score < 6 consider maintenance_flag/hskp_flag
- severity 5=pest/mould/health, 4=urgent, 3=action this week, 2=low, 1=informational
- Ratings-only with no sub-score below 6: severity=1, resolution_status="Resolved"
- severity>=3 and no clear resolution → resolution_status="Open"
- purely positive no issues → severity=1, resolution_status="Resolved"`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error('Claude API error: ' + (err.error?.message || response.status));
  }

  const data = await response.json();
  const text = data.content[0].text.trim().replace(/^```json?\n?/,'').replace(/\n?```$/,'');
  return JSON.parse(text);
}
