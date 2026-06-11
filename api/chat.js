// api/chat.js
// Conversational AI chatbot for The Sultan Hotel dashboard.
// Receives the full conversation history + a summary of current review data,
// returns Claude's response using claude-haiku-4-5-20251001 (cheapest model).
// Cost: ~$0.003–0.005 per message at typical usage.

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, context } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Build the system prompt with live dashboard context
  const systemPrompt = buildSystemPrompt(context || {});

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages  // full conversation history for Option B memory
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';
    return res.status(200).json({ reply, usage: data.usage });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Chat failed' });
  }
}

function buildSystemPrompt(ctx) {
  const {
    totalReviews = 0, avgRating = 0, positivePct = 0, negativePct = 0,
    maintFlags = 0, cleanFlags = 0, openIssues = 0,
    platforms = {}, categories = {}, topRooms = [],
    recentReviews = [], sentimentTrend = []
  } = ctx;

  return `You are the Sultan Intelligence assistant for The Sultan Hotel Singapore — a 61-room boutique heritage hotel in the Arab Quarter.

You have access to the hotel's live review analytics data (summarised below). Your job is to help hotel staff and management understand their guest reviews, interpret analytics charts, and identify operational priorities.

PERSONALITY:
- Concise, professional, and direct. No filler phrases.
- Always ground answers in the actual data provided. Never fabricate statistics.
- When asked about charts, explain what to look for and what it means operationally.
- If a question can't be answered from the data, say so clearly.

CURRENT DASHBOARD DATA:
- Total reviews: ${totalReviews}
- Average rating: ${avgRating}/5
- Positive sentiment: ${positivePct}%
- Negative sentiment: ${negativePct}%
- Maintenance flags: ${maintFlags} reviews (cumulative — historical record)
- Cleaning flags: ${cleanFlags} reviews (cumulative — historical record)
- Open unresolved issues: ${openIssues}

PLATFORM BREAKDOWN:
${Object.entries(platforms).map(([p,n]) => `- ${p}: ${n} reviews`).join('\n') || '- No data'}

TOP COMPLAINT CATEGORIES:
${Object.entries(categories).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,n]) => `- ${c}: ${n} mentions`).join('\n') || '- No data'}

ROOMS WITH MOST ISSUES (top 5):
${topRooms.slice(0,5).map(r => `- Room ${r.room} (${r.type}): ${r.complaints} complaints, ${r.maint} maint flags, avg ${r.avg}/5`).join('\n') || '- No data'}

RECENT REVIEWS (last 8):
${recentReviews.slice(0,8).map(r =>
  `- Room ${r.room} | ${r.platform} | ${r.rating}/5 | ${r.sentiment} | ${r.date} | "${(r.text||'').slice(0,80)}${(r.text||'').length>80?'…':''}"`
).join('\n') || '- No data'}

HOTEL CONTEXT:
- Room types: Standard Single, Standard Double, Standard Twin, Attic Room (No Windows), Sultan Room, Sultan Loft, Skylight Room, Skylight Loft, Puteri Room
- Platforms tracked: Agoda, Booking.com, Expedia, Google Reviews, Tripadvisor, Traveloka/Tiket.com, Trip.com
- Key staff: Ms Ong (Hotel Manager), Mr Li Gang (Engineering), Ms Rina (Housekeeping)
- Severity scale: 1=minor, 2=low, 3=medium (act within week), 4=high (24-48hr), 5=critical (immediate)

CHART EXPLANATIONS (use these when asked):
- Sentiment Trend: monthly counts of positive/negative reviews — widening green lead = improving reputation
- Severity Trend: average seriousness of complaints per month — downward slope = issues getting lighter
- Monthly Volume & Avg Rating: bar=review count, line=avg rating — high bars + low line = genuine problem month
- Platform Heatmap: sentiment split per booking channel — consistent red on one platform = that listing oversells
- Category Sentiment: positive vs negative mentions per category — tall red bar = systemic problem area
- Room Heatmap: colour-coded room grid — red=complaints, yellow=maint/HSKP flags, green=clean
- Recurring Issues: rooms with same high-severity issue 2+ times — these need permanent fixes not patches

Respond in plain English. Use bullet points only when listing multiple items. Keep responses under 200 words unless a detailed explanation is genuinely needed.`;
}
