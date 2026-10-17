// Shared answer checking for every quiz type (used by the live game server).
// Enumeration = the student lists several items (any order, not case-sensitive).

export const norm = (s: any) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// Correct items of an enumeration question
export function enumItems(q: any): string[] {
  if (Array.isArray(q?.items) && q.items.length) return q.items.map((x: any) => String(x ?? '').trim()).filter(Boolean)
  return String(q?.answer ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)
}

// Turn what the player sent (array or text) into a list of items
export function toItems(raw: any): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]+/)
  return list.map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 50)
}

// Every correct item must be listed exactly once (order does not matter)
export function enumCorrect(q: any, raw: any): boolean {
  const want = enumItems(q).map(norm)
  const got = toItems(raw).map(norm)
  if (!want.length || got.length !== want.length) return false
  const left = want.slice()
  for (const g of got) {
    const k = left.indexOf(g)
    if (k === -1) return false
    left.splice(k, 1)
  }
  return left.length === 0
}

// → { chosen: text stored / shown, correct }
export function gradeAnswer(q: any, raw: any): { chosen: string; correct: boolean } {
  if (q?.type === 'enumeration') {
    const items = toItems(raw)
    return { chosen: items.join(', ').slice(0, 1000), correct: enumCorrect(q, items) }
  }
  const chosen = String(raw ?? '').slice(0, 300)
  return { chosen, correct: norm(chosen) === norm(q?.answer) }
}
