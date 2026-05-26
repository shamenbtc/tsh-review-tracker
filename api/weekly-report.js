// api/weekly-report.js
// Generates department-specific weekly operations reports using Claude.
// Returns HTML reports for: Management (EN), Engineering (ZH), Housekeeping (EN+MS)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { reviews, weekOf, department } = req.body;
  if (!reviews || !Array.isArray(reviews)) return res.status(400).json({ error: 'reviews array required' });

  // Filter to recent reviews — last 7 days or all if fewer than 5
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Build summary data for Claude
  const total = reviews.length;
  const ratings = reviews.map(r => parseFloat(r.rating) || 0).filter(r => r > 0);
  const avgRating = ratings.length ? (ratings.reduce((a,b) => a+b, 0) / ratings.length).toFixed(1) : 'N/A';
  const positive = reviews.filter(r => r.sentiment === 'Positive').length;
  const neutral  = reviews.filter(r => r.sentiment === 'Neutral').length;
  const negative = reviews.filter(r => r.sentiment === 'Negative').length;

  const openAlerts = reviews.filter(r => {
    const hasFlag = r.maintFlag === 'Yes' || r.cleanFlag === 'Yes';
    const isAlert = hasFlag || parseInt(r.severity) >= 3;
    return isAlert && r.resolutionStatus !== 'Resolved';
  });

  const maintAlerts = reviews.filter(r =>
    (r.maintFlag === 'Yes' || r.maintFlag === true) && r.resolutionStatus !== 'Resolved'
  );

  const hskpAlerts = reviews.filter(r =>
    (r.cleanFlag === 'Yes' || r.hskpFlag === 'Yes' || r.cleanFlag === true) && r.resolutionStatus !== 'Resolved'
  );

  const staffMentions = reviews.filter(r => r.staffMentioned && r.staffMentioned.trim());
  const positiveStaff = reviews.filter(r => r.staffMentioned && r.sentiment === 'Positive');

  // Days open calculator
  function daysOpen(r) {
    if (!r.checkInDate && !r.date) return null;
    const d = new Date(r.checkInDate || r.date);
    if (isNaN(d)) return null;
    return Math.max(0, Math.floor((now - d) / (1000 * 60 * 60 * 24)));
  }

  const overdueAlerts = openAlerts.filter(r => {
    const d = daysOpen(r);
    return d !== null && d >= 7;
  });

  // Build data summaries for prompts
  const maintData = maintAlerts.map(r => ({
    room: r.room, severity: r.severity,
    issue: r.complaintSummary || r.subcategory || r.category,
    action: r.action || '',
    status: r.resolutionStatus || 'Open',
    days: daysOpen(r),
    platform: r.platform,
    rating: r.rating
  }));

  const hskpData = hskpAlerts.map(r => ({
    room: r.room, severity: r.severity,
    issue: r.complaintSummary || r.subcategory || r.category,
    action: r.action || '',
    status: r.resolutionStatus || 'Open',
    days: daysOpen(r)
  }));

  const staffData = positiveStaff.map(r => ({
    staff: r.staffMentioned,
    platform: r.platform,
    room: r.room,
    rating: r.rating,
    snippet: (r.text || '').slice(0, 150)
  }));

  const overdueSummary = overdueAlerts.map(r => ({
    room: r.room, days: daysOpen(r),
    issue: r.complaintSummary || r.category,
    status: r.resolutionStatus,
    severity: r.severity
  }));

  let prompt, reportType;

  if (department === 'engineering') {
    // MANDARIN report for Mr Li Gang
    reportType = 'engineering_zh';
    prompt = `你是The Sultan Hotel新加坡的运营分析师。请根据以下数据，为工程部主管李刚先生生成一份本周工程维修报告。

报告日期：${weekOf}
收件人：工程部主管 李刚先生

维修警报数据（需要工程部跟进）：
${JSON.stringify(maintData, null, 2)}

超过7天未解决的问题：
${JSON.stringify(overdueSummary.filter(r => maintAlerts.find(m => m.room === r.room)), null, 2)}

请生成一份简洁、专业的中文报告，包含：
1. 本周维修概况（几个待处理问题，几个超期）
2. 每个房间的具体问题列表，按严重程度排序（5最紧急，1最轻微）
3. 每个问题的建议行动
4. 需要立即处理的超期问题（用醒目方式标出）

格式要求：
- 语言：简体中文
- 风格：简洁、直接、适合工程技术人员阅读
- 房间号用"X号房"格式
- 严重程度：5级=紧急立即处理，4级=24-48小时内，3级=本周内，2级=低优先级，1级=可跟踪
- 如果没有维修问题，请写"本周无维修警报"

请只返回报告正文内容，使用清晰的段落，不需要HTML格式。`;

  } else if (department === 'housekeeping') {
    // ENGLISH + MALAY report for Ms Rina
    reportType = 'housekeeping_en_ms';
    prompt = `You are an operations analyst for The Sultan Hotel Singapore. Generate a weekly housekeeping report for Ms Rina, Housekeeping Supervisor.

Report date: ${weekOf}
Recipient: Housekeeping Supervisor, Ms Rina

Housekeeping alerts (cleanliness issues requiring attention):
${JSON.stringify(hskpData, null, 2)}

Overall sentiment this week:
- Total reviews: ${total}
- Positive: ${positive}, Neutral: ${neutral}, Negative: ${negative}
- Average rating: ${avgRating}/5

Overdue unresolved issues (7+ days):
${JSON.stringify(overdueSummary.filter(r => hskpAlerts.find(h => h.room === r.room)), null, 2)}

Staff recognition mentions this week:
${JSON.stringify(staffData.slice(0, 5), null, 2)}

Generate a professional bilingual report (English first, then Malay translation below) containing:
1. Week summary — how many HSKP flags, overall cleanliness performance
2. Each room with a housekeeping issue — room number, issue, priority, recommended action
3. Overdue items highlighted clearly
4. Any positive staff mentions related to housekeeping
5. One key focus area for this week

Format:
- English section first, complete report
- Then a horizontal line divider: ---
- Then the complete Malay (Bahasa Malaysia) translation
- Professional but practical tone — written for a housekeeping supervisor
- If no housekeeping issues: write "No housekeeping alerts this week" (and Malay equivalent)

Return only the report body content, clear paragraphs, no HTML.`;

  } else {
    // FULL ENGLISH report for Ms Ong and Sharmendran
    reportType = 'management_en';
    prompt = `You are an operations analyst for The Sultan Hotel Singapore. Generate a comprehensive weekly operations report for hotel management.

Report date: ${weekOf}
Recipients: Ms Ong (Hotel Manager) and Sharmendran (Front Office)

REVIEW DATA THIS PERIOD:
- Total reviews: ${total}
- Average rating: ${avgRating}/5
- Positive: ${positive} | Neutral: ${neutral} | Negative: ${negative}
- Open alerts: ${openAlerts.length}
- Overdue (7d+): ${overdueAlerts.length}

ALL OPEN ALERTS:
${JSON.stringify(openAlerts.map(r => ({
  room: r.room, platform: r.platform, severity: r.severity,
  category: r.category, issue: r.complaintSummary || r.subcategory,
  status: r.resolutionStatus, days: daysOpen(r),
  dept: r.assignedDept || 'Unassigned', action: (r.action||'').slice(0, 120)
})), null, 2)}

OVERDUE ALERTS (7+ days unresolved):
${JSON.stringify(overdueSummary, null, 2)}

STAFF RECOGNITION:
${JSON.stringify(staffData, null, 2)}

Generate a professional management report containing these exact sections:

1. WEEK AT A GLANCE — 3-4 sentence executive summary of the week
2. KEY METRICS — Total reviews, avg rating, sentiment split, open alerts, overdue count
3. OPEN ALERTS BY DEPARTMENT — Group by Engineering, Housekeeping, Front Office. For each alert: room, severity, issue, days open, recommended action
4. ⚠ OVERDUE ALERTS — Any alert open 7+ days gets its own call-out with escalation recommendation
5. STAFF RECOGNITION — Name each staff member mentioned positively, what they were praised for, recommended action (share with dept head / nominate for recognition)
6. TOP 3 ACTIONS THIS WEEK — The 3 most important things management should ensure happen this week, in priority order

Tone: Professional, concise, written for a hotel manager. Factual, no fluff.
Format: Clear section headers, bullet points where helpful. No HTML.
If any section has no data, write "None this period."`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error('Claude API: ' + (err.error?.message || response.status));
    }

    const data = await response.json();
    const reportText = data.content[0].text.trim();

    return res.status(200).json({
      success: true,
      reportType,
      department,
      weekOf,
      reportText,
      meta: { total, avgRating, positive, neutral, negative, openAlerts: openAlerts.length, overdue: overdueAlerts.length }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Report generation failed' });
  }
}
