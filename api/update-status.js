// api/update-status.js
// Updates resolution fields for a review in Supabase.
// Matches by booking_number. Refuses if the booking number is duplicated.

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

  const { bookingNumber, resolutionStatus, resolvedDate, assignedDept, assignedStaff, resolutionNotes } = req.body;

  if (!bookingNumber) return res.status(400).json({ error: 'bookingNumber is required' });
  if (!resolutionStatus) return res.status(400).json({ error: 'resolutionStatus is required' });

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // First: check how many rows share this booking number
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/reviews?booking_number=eq.${encodeURIComponent(bookingNumber)}&select=id`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Prefer': 'count=exact' } }
    );
    const matches = await checkRes.json();
    if (!Array.isArray(matches)) throw new Error('Unexpected response from Supabase');

    if (matches.length === 0) {
      return res.status(404).json({ error: `Booking number "${bookingNumber}" not found` });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        error: `Booking number "${bookingNumber}" matches ${matches.length} rows. Fix the duplicate first (Data tab → Duplicate Review Check).`
      });
    }

    // Safe to update — exactly one match
    const updates = {
      resolution_status:   resolutionStatus,
      resolved_date:       resolvedDate || null,
      assigned_department: assignedDept || null,
      assigned_staff:      assignedStaff || null,
      resolution_notes:    resolutionNotes || null,
      last_updated:        new Date().toISOString()
    };

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/reviews?booking_number=eq.${encodeURIComponent(bookingNumber)}`,
      { method: 'PATCH', headers, body: JSON.stringify(updates) }
    );

    if (!updateRes.ok) {
      const err = await updateRes.text();
      return res.status(500).json({ error: `Supabase update failed: ${err}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Update failed' });
  }
}
