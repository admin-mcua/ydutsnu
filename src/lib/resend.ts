// Resend email helper — sends the "Find your account" verification code.
//
// The API key MUST be provided via the RESEND_API_KEY environment binding
// (Set in Cloudflare: npx wrangler secret put RESEND_API_KEY or in .dev.vars)

const FROM = 'Unstudy <noreply@unstudy.xyz>'

export async function sendResetCodeEmail(
  env: any,
  to: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = env && env.RESEND_API_KEY

  if (!apiKey) {
    console.error('[Resend error] RESEND_API_KEY is not configured in environment bindings.')
    return { ok: false, error: 'Email service is not configured (missing API Key).' }
  }

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
    <h1 style="color:#4F46E5;font-size:22px;margin:0 0 4px;">Unstudy</h1>
    <p style="color:#64748b;font-size:14px;margin:0 0 24px;">Review lessons the smart way</p>
    <h2 style="color:#1e293b;font-size:18px;margin:0 0 8px;">Your verification code</h2>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px;">
      We received a request to access your Unstudy account. Enter this code to verify it's you:
    </p>
    <div style="background:#EEF2FF;border-radius:12px;padding:18px;text-align:center;margin:0 0 20px;">
      <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#4F46E5;">${code}</span>
    </div>
    <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0;">
      This code expires in <b>10 minutes</b>. If you didn't request it, you can safely ignore this email.
    </p>
  </div>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: `${code} is your Unstudy verification code`,
        html
      })
    })
    if (!res.ok) {
      let msg = 'Could not send the email'
      try {
        const data: any = await res.json()
        if (data && data.message) msg = data.message
      } catch (e) {}
      console.error('[Resend error]', res.status, msg)
      return { ok: false, error: msg }
    }
    return { ok: true }
  } catch (e: any) {
    console.error('[Resend fetch error]', e?.message || e)
    return { ok: false, error: 'Could not reach the email service' }
  }
}
