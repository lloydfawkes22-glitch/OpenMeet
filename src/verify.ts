// Codice di verifica (SAS) derivato dalle impronte dei certificati DTLS di
// entrambi i lati. Se qualcuno si mette in mezzo, ognuno dei due vede un
// certificato remoto diverso e i codici non coincidono.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // base32 Crockford: niente I/L/O/U

type Fingerprints = { local: string; remote: string }

function normalize(fp: string): string {
  return fp.trim().toUpperCase()
}

/** Impronte dai certificati effettivamente usati nell'handshake DTLS. */
async function fingerprintsFromStats(pc: RTCPeerConnection): Promise<Fingerprints | null> {
  const stats = await pc.getStats()
  let transport: any = null
  stats.forEach(s => {
    if (s.type === 'transport' && s.dtlsState === 'connected' && !transport) transport = s
  })
  if (!transport?.localCertificateId || !transport?.remoteCertificateId) return null
  const local = stats.get(transport.localCertificateId)
  const remote = stats.get(transport.remoteCertificateId)
  if (!local?.fingerprint || !remote?.fingerprint) return null
  return {
    local: `${local.fingerprintAlgorithm} ${normalize(local.fingerprint)}`,
    remote: `${remote.fingerprintAlgorithm} ${normalize(remote.fingerprint)}`,
  }
}

/** Ripiego: impronte dichiarate negli SDP (es. browser senza certificate stats). */
function fingerprintsFromSdp(pc: RTCPeerConnection): Fingerprints | null {
  const grab = (sdp?: string) => {
    const m = sdp?.match(/a=fingerprint:(\S+) (\S+)/i)
    return m ? `${m[1].toLowerCase()} ${normalize(m[2])}` : null
  }
  const local = grab(pc.localDescription?.sdp)
  const remote = grab(pc.remoteDescription?.sdp)
  return local && remote ? { local, remote } : null
}

export async function verificationCode(pc: RTCPeerConnection, length = 6): Promise<string | null> {
  const fps = (await fingerprintsFromStats(pc)) ?? fingerprintsFromSdp(pc)
  if (!fps) return null
  // ordinati: entrambi i lati ottengono la stessa stringa
  const input = ['openmeet-sas-v1', ...[fps.local, fps.remote].sort()].join('\n')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[digest[i] & 31]
  return out.slice(0, 3) + '-' + out.slice(3)
}
