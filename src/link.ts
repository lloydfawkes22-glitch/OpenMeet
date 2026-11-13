// Gestione del link d'invito. Tutto sta nel frammento (#...), che il browser
// non invia mai al server che ospita la pagina.

export const LINK_TTL_MS = 24 * 60 * 60 * 1000 // il link scade dopo 24 ore

export type Invite = {
  room: string // ID casuale (128 bit, base64url)
  pw: string // password casuale (128 bit, base64url)
  exp: number // scadenza, ms epoch
}

const CONSUMED_KEY = 'openmeet:consumed'

function randomToken(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createInvite(): Invite {
  return { room: randomToken(), pw: randomToken(), exp: Date.now() + LINK_TTL_MS }
}

export function inviteToHash(inv: Invite): string {
  return `#room=${inv.room}&pw=${inv.pw}&exp=${inv.exp}`
}

export function inviteUrl(inv: Invite): string {
  const base = location.href.split('#')[0]
  return base + inviteToHash(inv)
}

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/

export function parseInvite(hash: string): Invite | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const room = params.get('room') ?? ''
  const pw = params.get('pw') ?? ''
  const exp = Number(params.get('exp'))
  if (!TOKEN_RE.test(room) || !TOKEN_RE.test(pw) || !Number.isSafeInteger(exp)) return null
  return { room, pw, exp }
}

/**
 * Nome della stanza Trystero: include la scadenza, così modificare `exp` nel
 * link porta in una stanza diversa (vuota) invece di allungarne la validità.
 */
export function roomName(inv: Invite): string {
  return `${inv.room}.${inv.exp}`
}

export function isExpired(inv: Invite): boolean {
  return Date.now() > inv.exp
}

// --- "Monouso" lato client -------------------------------------------------
// Senza server non si può invalidare un link in modo assoluto. La garanzia
// vera è il limite di 2 partecipanti; in più questo browser ricorda i link già
// usati per una chiamata e si rifiuta di riaprirli.

function readConsumed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(CONSUMED_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function isConsumed(inv: Invite): boolean {
  return roomName(inv) in readConsumed()
}

export function markConsumed(inv: Invite): void {
  try {
    const all = readConsumed()
    const now = Date.now()
    // pulizia: le voci servono solo finché il link non è comunque scaduto
    for (const [k, exp] of Object.entries(all)) if (exp < now) delete all[k]
    all[roomName(inv)] = inv.exp
    localStorage.setItem(CONSUMED_KEY, JSON.stringify(all))
  } catch {
    /* storage non disponibile: resta solo la scadenza */
  }
}
