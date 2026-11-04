// Slim list columns: let SQLite count / preview the JSON instead of shipping it.
export const SLIM_FLASHCARD_COLS = (a = 'f') =>
  `json_array_length(${a}.cards) AS card_count,
   json_extract(${a}.cards, '$[0].front') AS preview_0,
   json_extract(${a}.cards, '$[1].front') AS preview_1`
export const SLIM_QUIZ_COLS = (a = 'q') => `json_array_length(${a}.questions) AS question_count`
export function slimItem(item: any) {
  if (item.content_type === 'flashcard') {
    item.card_count = Number(item.card_count) || 0
    item.cards_preview = [item.preview_0, item.preview_1].filter((x) => x != null).map((front) => ({ front: String(front) }))
    delete item.preview_0; delete item.preview_1
  } else {
    item.question_count = Number(item.question_count) || 0
    try { item.types = JSON.parse(item.types || '[]') } catch (e) { item.types = [] }
  }
  return item
}

// Decode base64 without Node APIs (works on any Workers compat setting)
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
