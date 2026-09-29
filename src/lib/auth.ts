// Simple auth helpers. Passwords stored in plaintext by design so the admin
// can recover them (per app requirement). Sessions use random tokens.

export function randomToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function shareSlug(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function getToken(c: any): string | null {
  const auth = c.req.header('Authorization')
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

export async function getSession(db: D1Database, token: string | null) {
  if (!token) return null
  const row = await db
    .prepare('SELECT * FROM sessions WHERE token = ?')
    .bind(token)
    .first<{ token: string; user_id: number; role: string }>()
  return row || null
}
