// api/bulk-classify.js
// Reads all rows from Google Sheet, classifies rows with blank Sentiment using Claude,
// then writes classifications back to the exact cells.
// Called by the bulk classify UI with action=preview, action=classify-one, or action=write.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TSH-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret gate: blocks drive-by use from anyone who discovers the URL.
  // Set TSH_INTAKE_KEY in Vercel env vars. If unset, the gate is skipped.
  const requiredKey = process.env.TSH_INTAKE_KEY;
  if (requiredKey && req.headers['x-tsh-key'] !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }


  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const saEmail = process.env.GOOGLE_SA_EMAIL;
  const saKey   = process.env.GOOGLE_SA_PRIVATE_KEY;
  const SPREADSHEET_ID = '15gzSANBAwhZPfNoi3Jh2W4tMTVAHVKjv3g4hGXHq3-w';
  const SHEET_TAB      = 'Review Data';

  if (!apiKey)  return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!saEmail || !saKey) return res.status(500).json({ error: 'Google credentials not set' });

  const { action, row } = req.body;

  // ── ACTION: preview — fetch sheet and return rows that need classification ──
  if (action === 'preview') {
    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/e/2PACX-1vRqCAoucSr2sR8pdyLobUytm71UaX2Goibvna-a55Kv2Yj5PAGmRqoMcRnrPaWA6Co4-Y6KAZwbcz17/pub?gid=1245614730&single=true&output=csv`;
      const csvResp = await fetch(csvUrl, { cache: 'no-store' });
      if (!csvResp.ok) throw new Error('Could not fetch sheet CSV');
      const csv = await csvResp.text();
      const parsed = parseCSV(csv);
      return res.status(200).json({ rows: parsed });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION: classify-one — classify a single review with Claude ──
  if (action === 'classify-one') {
    if (!row) return res.status(400).json({ error: 'Missing row data' });
    try {
      const result = await classifyWithClaude(row, apiKey);
      return res.status(200).json(result);
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION: write — write classifications back to specific cells ──
  if (action === 'write') {
    if (!row) return res.status(400).json({ error: 'Missing row data' });
    try {
      const token = await getGoogleAccessToken(saEmail, saKey);
      await writeClassification(row, token, SPREADSHEET_ID, SHEET_TAB);
      return res.status(200).json({ success: true });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: preview, classify-one, write' });
}

// ── PARSE CSV ─────────────────────────────────────────────────────────────────
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // Quote-aware line splitter
  const splitLines = (t) => {
    const lines = []; let cur = '', inQ = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"') { if (inQ && t[i+1] === '"') { cur += '"'; i++; continue; } inQ = !inQ; cur += c; continue; }
      if (!inQ && (c === '\n' || c === '\r')) { if (c === '\r' && t[i+1] === '\n') i++; lines.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur) lines.push(cur);
    return lines.filter(l => l.trim());
  };

  const parseRow = (line) => {
    const result = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; continue; } inQ = !inQ; continue; }
      if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    result.push(cur.trim());
    return result;
  };

  const lines = splitLines(text);

  // Find header row (skip group band and description rows)
  const MARKERS = ['check-in','checkin','platform','review text','rating','room number','sentiment'];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const lc = parseRow(lines[i]).map(c => c.toLowerCase());
    const hits = MARKERS.filter(m => lc.some(c => c.includes(m))).length;
    if (hits >= 3) { headerIdx = i; break; }
  }

  const rawHeaders = parseRow(lines[headerIdx]).map(h => h.replace(/[★*†‡]/g,'').trim());
  const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''));

  // Find key column indices
  const col = (keys) => { for (const k of keys) { const i = headers.indexOf(k); if (i > -1) return i; } return -1; };
  const COLS = {
    checkIn:   col(['check_in_date','checkin_date','check_in']),
    platform:  col(['platform','source']),
    booking:   col(['booking','booking_number','booking_id']),
    room:      col(['room','room_number','room_no']),
    roomType:  col(['room_type','roomtype']),
    rating:    col(['rating','score']),
    text:      col(['review_text','review','text','comment']),
    sentiment: col(['sentiment']),
    category:  col(['category']),
    subcategory: col(['subcategory','sub_category']),
    complaint: col(['complaint_summary','complaint','summary']),
    severity:  col(['severity']),
    maint:     col(['maintenance','maintenance_flag','maint_flag']),
    hskp:      col(['hskp','hskp_flag','cleaning','housekeeping']),
    action:    col(['suggested_action','action']),
    status:    col(['resolution_status','status']),
    dept:      col(['assigned_department','department','dept']),
  };

  // Skip description row
  let startRow = headerIdx + 1;
  if (startRow < lines.length) {
    const nextRow = parseRow(lines[startRow]).map(c => c.toLowerCase()).join(' ');
    const descMarkers = ['dd-mon-yyyy','number of nights','yes / no','country of guest'];
    if (descMarkers.filter(m => nextRow.includes(m)).length >= 2) startRow++;
  }

  const rows = [];
  for (let i = startRow; i < lines.length; i++) {
    const r = parseRow(lines[i]);
    if (r.every(c => !c.trim())) continue;
    const text = COLS.text > -1 ? r[COLS.text] || '' : '';
    if (!text.trim()) continue;

    const sentiment = COLS.sentiment > -1 ? r[COLS.sentiment] || '' : '';
    const category  = COLS.category  > -1 ? r[COLS.category]  || '' : '';
    const severity  = COLS.severity  > -1 ? r[COLS.severity]  || '' : '';

    // Determine actual sheet row number (1-based, accounting for header rows)
    const sheetRowNum = i + 1; // lines array is 0-indexed, sheet rows are 1-indexed

    rows.push({
      sheetRow: sheetRowNum,
      checkIn:  COLS.checkIn  > -1 ? r[COLS.checkIn]  || '' : '',
      platform: COLS.platform > -1 ? r[COLS.platform] || '' : '',
      booking:  COLS.booking  > -1 ? r[COLS.booking]  || '' : '',
      room:     COLS.room     > -1 ? r[COLS.room]     || '' : '',
      roomType: COLS.roomType > -1 ? r[COLS.roomType] || '' : '',
      rating:   COLS.rating   > -1 ? r[COLS.rating]   || '' : '',
      text,
      sentiment, category, severity,
      // Needs classification if sentinel fields are blank
      needsClassification: !sentiment.trim() || !category.trim() || !severity.trim(),
      // Current values for all classification columns
      cols: COLS
    });
  }

  return rows;
}

// ── CLASSIFY WITH CLAUDE ───────────────────────────────────────────────────────
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
- "Location" = anything about the hotel's surroundings: neighbourhood, nearby food/restaurants, MRT/transport, walking distance to attractions, the area. Example: "great location, near eating places, MRT within walking distance" = Location, NOT Room Comfort.
- "Room Comfort & Quality" = ONLY the room itself: bed, furniture, size, temperature, noise inside the room, view from the room.
- A positive review praising the location is a "Location" review. Categorise every review (positive or negative) by its MAIN topic.

SUBCATEGORY — must come from the actual text:
- The subcategory must reflect something the review genuinely mentions.
- NEVER default to "HVAC" unless the review genuinely refers to air-conditioning, heating, or ventilation.
- If no specific sub-topic is mentioned, use a general one like "General" — do not invent specifics.

Rules:
- sentiment = overall guest experience
- Positive reviews CAN have maintenance_flag/hskp_flag = Yes if physical issue mentioned
- For ratings-only: if Room view, Comfort, or Facilities score < 6 → consider maintenance_flag or hskp_flag
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
      max_tokens: 600,
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

// ── WRITE CLASSIFICATION BACK TO SHEET ────────────────────────────────────────
async function writeClassification(row, token, spreadsheetId, sheetTab) {
  // Columns N through V (indices 13-21, 0-based) = Sentiment through Resolution Status
  // N=Sentiment, O=Category, P=Subcategory, Q=Complaint Summary, R=Severity,
  // S=Maintenance Flag, T=HSKP Flag, U=Suggested Action, V=Resolution Status, X=Assigned Department
  const { sheetRow, classification } = row;

  // Build batch update — write to specific ranges
  const updates = [
    { range: `${sheetTab}!N${sheetRow}`, values: [[classification.sentiment || '']] },
    { range: `${sheetTab}!O${sheetRow}`, values: [[classification.category || '']] },
    { range: `${sheetTab}!P${sheetRow}`, values: [[classification.subcategory || '']] },
    { range: `${sheetTab}!Q${sheetRow}`, values: [[classification.complaint_summary || '']] },
    { range: `${sheetTab}!R${sheetRow}`, values: [[String(classification.severity || 1)]] },
    { range: `${sheetTab}!S${sheetRow}`, values: [[classification.maintenance_flag || 'No']] },
    { range: `${sheetTab}!T${sheetRow}`, values: [[classification.hskp_flag || 'No']] },
    { range: `${sheetTab}!U${sheetRow}`, values: [[classification.suggested_action || '']] },
    { range: `${sheetTab}!V${sheetRow}`, values: [[classification.resolution_status || 'Open']] },
    { range: `${sheetTab}!X${sheetRow}`, values: [[classification.assigned_department || '']] },
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
  });

  const data = await resp.json();
  if (data.error) throw new Error('Sheets write error: ' + data.error.message);
  return data;
}

// ── GOOGLE JWT AUTH ───────────────────────────────────────────────────────────
async function getGoogleAccessToken(email, pemKey) {
  const { createSign } = await import('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  })).toString('base64url');
  const sigInput = header + '.' + payload;
  const fixedKey = pemKey.replace(/\\n/g, '\n');
  const sign = createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(fixedKey, 'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const jwt = sigInput + '.' + signature;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}
