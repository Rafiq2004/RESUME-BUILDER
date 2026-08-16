// This runs on Vercel's servers, never in the user's browser — so your
// API key here stays secret. This is the piece that makes it safe to
// put your website live for real people to use.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 3;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { resume, jd, clientId } = req.body || {};

  if (!clientId || typeof clientId !== 'string') {
    res.status(400).json({ error: 'Missing client identifier. Try reloading the page.' });
    return;
  }

  if (!resume || typeof resume !== 'string' || !resume.trim()) {
    res.status(400).json({ error: 'Resume text is required.' });
    return;
  }

  // --- Look up (or create) this visitor's usage record ---
  let visitor;
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('visitors')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (existing) {
      visitor = existing;
    } else {
      const { data: created, error: insertError } = await supabase
        .from('visitors')
        .insert({ client_id: clientId, free_used: 0, paid_credits: 0 })
        .select()
        .single();
      if (insertError) throw insertError;
      visitor = created;
    }
  } catch (err) {
    console.error('Supabase lookup/create error:', err);
    res.status(500).json({ error: 'Could not check your usage. Try again shortly.' });
    return;
  }

  // --- Check whether they're allowed to rewrite ---
  const freeRemaining = FREE_LIMIT - visitor.free_used;
  const canUseFree = freeRemaining > 0;
  const canUsePaid = visitor.paid_credits > 0;

  if (!canUseFree && !canUsePaid) {
    res.status(403).json({
      error: 'You\'ve used all 3 free rewrites. Payment options are coming soon.',
      freeRemaining: 0,
      paidCredits: visitor.paid_credits
    });
    return;
  }

  // Cap input length so one request can't rack up huge API costs
  const safeResume = resume.slice(0, 12000);
  const safeJd = (jd || '').slice(0, 6000);

  const systemPrompt = `You rewrite resumes to be sharper, more concrete, and ATS-friendly.
Rules:
- Never invent experience, employers, dates, numbers, or skills not present in the original.
- Turn vague duties into concrete, action-verb-led accomplishment lines where the original supports it.
- If a job description is provided, naturally emphasize relevant existing experience and mirror its key terms where truthful — do not fabricate matches.
- Keep the person's actual roles, companies, and timeline exactly as given.
- Output plain text only: no markdown symbols, no commentary, just the rewritten resume ready to use.`;

  const userPrompt = safeJd
    ? `Original resume:\n${safeResume}\n\nTarget job description:\n${safeJd}\n\nRewrite the resume above, tailored to this role.`
    : `Original resume:\n${safeResume}\n\nRewrite this resume to be clearer, more concrete, and more compelling.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      res.status(502).json({ error: 'The rewrite service failed. Try again shortly.' });
      return;
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!text) {
      res.status(502).json({ error: 'Got an empty response. Try again.' });
      return;
    }

    // --- Record the usage now that the rewrite succeeded ---
    const updates = { last_used_at: new Date().toISOString() };
    if (canUseFree) {
      updates.free_used = visitor.free_used + 1;
    } else {
      updates.paid_credits = visitor.paid_credits - 1;
    }

    const { error: updateError } = await supabase
      .from('visitors')
      .update(updates)
      .eq('client_id', clientId);

    if (updateError) {
      // Don't fail the whole request over a logging issue — the user
      // already got their rewrite. Just log it for us to notice.
      console.error('Supabase usage update error:', updateError);
    }

    res.status(200).json({
      result: text,
      freeRemaining: canUseFree ? FREE_LIMIT - updates.free_used : freeRemaining,
      paidCredits: canUseFree ? visitor.paid_credits : updates.paid_credits
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
};
