// api/classifier.js
// SINGLE SOURCE OF TRUTH for review classification.
// Both classify.js (single intake) and bulk-classify.js (backlog) import from here,
// so the prompt and parsing rules CANNOT drift apart. If you change classification
// behaviour, change it here once.

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

// Valid enum values — used by validateClassification() to reject malformed AI output.
const VALID = {
  sentiment: ['Positive', 'Neutral', 'Negative'],
  category: ['Room Comfort & Quality', 'Cleanliness', 'Staff', 'Facilities', 'Value for Money', 'F&B', 'Location', 'Other'],
  resolution_status: ['Open', 'Resolved', 'Escalated', 'In Progress', 'Monitoring'],
  assigned_department: ['Engineering', 'Housekeeping', 'Front Office', 'F&B', 'Management', ''],
  confidence: ['high', 'med', 'low']
};

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────
// `details` = { platform, roomNumber, roomType, rating, checkinDate, reviewText }
function buildClassificationPrompt(details) {
  const { platform, roomNumber, roomType, rating, checkinDate, reviewText } = details;
  return `You are a hotel operations analyst for The Sultan Hotel Singapore.
Analyse this guest input and return a JSON object with ALL fields filled.

The input may be one of two formats:
1. A written guest review (narrative text)
2. A ratings-only entry — sub-category scores copied from a booking platform, e.g.:
   "Staff 10 / Cleanliness 10 / Location 7.5 / Comfort 10 / Room view 5"

For ratings-only entries: infer sentiment from the overall rating and sub-scores. A sub-score below 6 is a weak point — treat it as a mild complaint signal. No written complaint means severity is at most 2 unless a sub-score is below 5. Set complaint_summary to the weakest sub-category if any score is below 7, otherwise leave empty.

Review details:
- Platform: ${platform}
- Room: ${roomNumber} (${roomType || 'unknown'})
- Rating: ${rating}
- Check-in: ${checkinDate}
- Review text / ratings: ${reviewText}

Return ONLY valid JSON, no markdown, no explanation. Use exactly these fields:
{
  "sentiment": "Positive" | "Neutral" | "Negative",
  "category": "Room Comfort & Quality" | "Cleanliness" | "Staff" | "Facilities" | "Value for Money" | "F&B" | "Location" | "Other",
  "subcategory": string,
  "complaint_summary": string (5-10 words, or empty string if no issues),
  "severity": 1 | 2 | 3 | 4 | 5,
  "maintenance_flag": "Yes" | "No",
  "hskp_flag": "Yes" | "No",
  "suggested_action": string,
  "resolution_status": "Open" | "Resolved" | "Escalated" | "In Progress" | "Monitoring",
  "assigned_department": "Engineering" | "Housekeeping" | "Front Office" | "F&B" | "Management" | "",
  "mixed_sentiment": true | false,
  "mixed_sentiment_note": string,
  "analyst_note": string,
  "confidence_sentiment": "high" | "med" | "low",
  "confidence_category": "high" | "med" | "low",
  "confidence_severity": "high" | "med" | "low"
}

Rules:
- sentiment = overall guest experience, not individual sub-scores
- A Positive review CAN have maintenance_flag or hskp_flag = Yes if it mentions a physical issue
- For ratings-only: if Room view, Comfort, or Facilities score < 6 → consider maintenance_flag or hskp_flag
- severity 5 = pest/mould/health risk, 4 = urgent (broken AC, no hot water), 3 = action within week, 2 = low, 1 = informational
- Ratings-only with no sub-score below 6: severity = 1, resolution_status = "Resolved"
- If severity >= 3, default resolution_status to "Open" unless clearly resolved
- If purely positive with no issues: severity = 1, resolution_status = "Resolved"

CATEGORY SELECTION (read carefully — pick the category that matches what the review is actually ABOUT):
- "Location" → the review's main point is the hotel's location, neighbourhood, surroundings, nearby food/restaurants, MRT/transport/walkability, distance to attractions or city centre. Example: "great location, near eating places, MRT within walking distance" = Location, NOT Room Comfort.
- "Room Comfort & Quality" → only when the review is about the room itself: bed, space, furnishings, temperature/AC, noise inside the room, view from the room.
- "Cleanliness" → dirt, dust, stains, hygiene, pests in the context of cleaning.
- "Staff" → service, front desk, helpfulness, attitude.
- "Facilities" → pool, gym, lift, wifi, breakfast area, shared amenities.
- "Value for Money" → price vs what was received.
- "F&B" → food and beverage quality.
- "Other" → only if genuinely none of the above fit.
- This applies to POSITIVE reviews too — a positive review praising the location is a "Location" review, not "Room Comfort & Quality".

SUBCATEGORY (must come from the actual text):
- The subcategory must describe something the guest ACTUALLY mentioned. Never invent one.
- NEVER default to "HVAC" (or any specific subcategory) unless the review genuinely refers to air-conditioning, heating, or temperature.
- If there is no specific sub-issue (e.g. a short positive review), use a plain descriptor of the topic such as "General" or the main subject in a few words — do not fabricate a technical issue.

- Use "Location" as category when the main signal is about the hotel's location or nearby environment
- analyst_note: flag issues masked by service recovery, safety concerns, recurring patterns, or low sub-scores worth monitoring
- confidence_*: be honest. Use "low" when the text is short, ambiguous, mixed, or you are guessing. Use "high" only when the text clearly supports the call.`;
}

// ── VALIDATION ────────────────────────────────────────────────────────────────
// Returns { ok: true, value } if the parsed object is structurally sound,
// or { ok: false, reason } if it's malformed. We coerce where safe and reject
// where a field is unrecoverable, so bad AI output never silently writes garbage.
function validateClassification(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' };

  // sentiment — required, must be valid enum
  if (!VALID.sentiment.includes(obj.sentiment)) {
    return { ok: false, reason: `invalid sentiment: ${JSON.stringify(obj.sentiment)}` };
  }
  // category — required, must be valid enum
  if (!VALID.category.includes(obj.category)) {
    return { ok: false, reason: `invalid category: ${JSON.stringify(obj.category)}` };
  }
  // severity — must coerce to integer 1..5
  let sev = parseInt(obj.severity);
  if (isNaN(sev) || sev < 1 || sev > 5) {
    return { ok: false, reason: `invalid severity: ${JSON.stringify(obj.severity)}` };
  }
  obj.severity = sev;

  // resolution_status — coerce invalid/empty to a safe default rather than reject
  if (!VALID.resolution_status.includes(obj.resolution_status)) {
    obj.resolution_status = sev >= 3 ? 'Open' : 'Resolved';
  }
  // assigned_department — coerce invalid to empty
  if (!VALID.assigned_department.includes(obj.assigned_department)) {
    obj.assigned_department = '';
  }
  // flags — normalise to "Yes"/"No" strings (downstream code expects these)
  obj.maintenance_flag = isYes(obj.maintenance_flag) ? 'Yes' : 'No';
  obj.hskp_flag        = isYes(obj.hskp_flag) ? 'Yes' : 'No';

  // string fields — coerce missing to safe defaults
  obj.subcategory       = typeof obj.subcategory === 'string' ? obj.subcategory : 'General';
  obj.complaint_summary = typeof obj.complaint_summary === 'string' ? obj.complaint_summary : '';
  obj.suggested_action  = typeof obj.suggested_action === 'string' ? obj.suggested_action : '';

  // confidence fields — coerce invalid/missing to "med" so they're always present & usable
  ['confidence_sentiment', 'confidence_category', 'confidence_severity'].forEach(k => {
    if (!VALID.confidence.includes(obj[k])) obj[k] = 'med';
  });

  // optional analyst fields — ensure present
  if (typeof obj.mixed_sentiment !== 'boolean') obj.mixed_sentiment = false;
  obj.mixed_sentiment_note = typeof obj.mixed_sentiment_note === 'string' ? obj.mixed_sentiment_note : '';
  obj.analyst_note         = typeof obj.analyst_note === 'string' ? obj.analyst_note : '';

  return { ok: true, value: obj };
}

function isYes(v) {
  return ['yes', 'true', '1'].includes(String(v || '').toLowerCase().trim());
}

// Strip markdown fences and parse. Returns parsed object or throws.
function parseClaudeJSON(rawText) {
  const text = String(rawText || '').trim()
    .replace(/^```json?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  return JSON.parse(text);
}

// ── MAIN ENTRY ────────────────────────────────────────────────────────────────
// Calls Claude, parses, validates. Retries ONCE if the first response is
// unparseable or fails validation (transient model formatting slips happen).
// Throws with a clear message if both attempts fail — caller decides how to surface.
async function classify(details, apiKey) {
  const prompt = buildClassificationPrompt(details);
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let data;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // API-level errors (auth, rate limit) are not worth retrying blindly — surface them.
        throw new Error('Claude API error: ' + (err.error?.message || response.status));
      }
      data = await response.json();
    } catch (apiErr) {
      // Network/API failure — record and retry once
      lastErr = apiErr;
      continue;
    }

    // Parse + validate
    try {
      const parsed = parseClaudeJSON(data.content?.[0]?.text);
      const check = validateClassification(parsed);
      if (check.ok) return check.value;
      lastErr = new Error('Validation failed: ' + check.reason);
    } catch (parseErr) {
      lastErr = new Error('JSON parse failed: ' + parseErr.message);
    }
    // fall through to retry
  }

  throw lastErr || new Error('Classification failed after retry');
}

export {
  classify,
  buildClassificationPrompt,
  validateClassification,
  parseClaudeJSON,
  CLAUDE_MODEL,
  VALID
};
