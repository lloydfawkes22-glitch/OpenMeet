// Ottimizzazioni WebRTC: priorità all'audio, codec robusti, video leggero.
//
// Trystero accetta un `rtcPolyfill`: gli passiamo una sottoclasse di
// RTCPeerConnection che applica le preferenze su ogni connessione che crea,
// senza modificare l'SDP a mano (le impronte DTLS restano intatte).

// --- Profilo del dispositivo ----------------------------------------------

const nav = navigator as Navigator & { deviceMemory?: number }
const lowEnd = (nav.hardwareConcurrency ?? 4) <= 2 || (nav.deviceMemory ?? 4) <= 2

/** Parametri video in base alla potenza del dispositivo. */
export const profile = lowEnd
  ? { width: 640, height: 360, fps: 20, videoMaxBitrate: 450_000 }
  : { width: 960, height: 540, fps: 24, videoMaxBitrate: 900_000 }

export const audioConstraints: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 }, // voce: mono, metà dei dati
  sampleRate: { ideal: 48_000 }, // nativo per Opus, niente ricampionamento
}

export const videoConstraints: MediaTrackConstraints = {
  width: { ideal: profile.width, max: 1280 },
  height: { ideal: profile.height, max: 720 },
  frameRate: { ideal: profile.fps, max: 30 },
  facingMode: 'user',
}

/** Suggerimenti all'encoder: voce per l'audio, fluidità per il video. */
export function hintTracks(stream: MediaStream) {
  stream.getAudioTracks().forEach(t => (t.contentHint = 'speech'))
  stream.getVideoTracks().forEach(t => (t.contentHint = 'motion'))
}

// --- Stato condiviso del tuning -------------------------------------------

/** Video sospeso dal controllo di banda (l'audio continua sempre). */
let videoSuspended = false
const peers = new Set<TunedPeerConnection>()

// --- Codec audio: RED (ridondanza) davanti a Opus --------------------------
// RED reinvia in ogni pacchetto anche il frame audio precedente: se un
// pacchetto va perso, la voce si ricostruisce senza buchi. Costa ~30 kbit/s
// in più ed è ciò che usano i servizi di videochiamata più diffusi.

const tunedTransceivers = new WeakSet<RTCRtpTransceiver>()

function preferAudioCodecs(pc: RTCPeerConnection) {
  const caps = typeof RTCRtpReceiver.getCapabilities === 'function' ? RTCRtpReceiver.getCapabilities('audio') : null
  if (!caps) return
  const red = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/red')
  const opus = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/opus')
  if (!opus.length) return
  const rest = caps.codecs.filter(c => !red.includes(c) && !opus.includes(c))
  const order = [...red, ...opus, ...rest]
  for (const t of pc.getTransceivers()) {
    if (tunedTransceivers.has(t) || (t as any).stopped || t.currentDirection === 'stopped') continue
    const kind = t.sender.track?.kind ?? t.receiver.track?.kind
    if (kind !== 'audio' || typeof t.setCodecPreferences !== 'function') continue
    try {
      t.setCodecPreferences(order)
      tunedTransceivers.add(t)
    } catch (err) {
      console.warn('setCodecPreferences', err)
    }
  }
}

// --- Parametri dei sender ---------------------------------------------------

async function tuneSenders(pc: RTCPeerConnection) {
  for (const sender of pc.getSenders()) {
    const kind = sender.track?.kind
    if (!kind) continue
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
    if (!params.encodings?.length) continue // non ancora negoziato: riproviamo dopo
    for (const enc of params.encodings as (RTCRtpEncodingParameters & { networkPriority?: string })[]) {
      if (kind === 'audio') {
        enc.priority = 'high' // più banda nell'allocazione interna
        enc.networkPriority = 'high' // marcatura DSCP: i router possono favorirlo
      } else {
        enc.priority = 'low'
        enc.networkPriority = 'low'
        enc.maxBitrate = profile.videoMaxBitrate
        enc.maxFramerate = profile.fps
        enc.active = !videoSuspended
      }
    }
    // con poca banda o CPU si abbassa la risoluzione, non i fotogrammi
    if (kind === 'video') params.degradationPreference = 'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch (err) {
      console.warn('setParameters', kind, err)
    }
  }
}

export class TunedPeerConnection extends RTCPeerConnection {
  private tuning: Promise<void> = Promise.resolve()

  constructor(config?: RTCConfiguration) {
    super({ ...config, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    peers.add(this)
    this.addEventListener('signalingstatechange', () => {
      if (this.signalingState === 'stable') this.retune()
    })
    this.addEventListener('connectionstatechange', () => {
      if (this.connectionState === 'closed') peers.delete(this)
    })
  }

  // Trystero usa setLocalDescription() implicito sia per l'offerta che per
  // la risposta: è il punto giusto per fissare le preferenze dei codec.
  override setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    preferAudioCodecs(this)
    return super.setLocalDescription(description)
  }

  override close() {
    peers.delete(this)
    super.close()
  }

  /** setParameters in serie: due chiamate sovrapposte si annullano a vicenda. */
  retune() {
    this.tuning = this.tuning.then(() => tuneSenders(this)).catch(() => {})
    return this.tuning
  }
}

export function retuneAll() {
  return Promise.all([...peers].map(pc => pc.retune()))
}

export function setVideoSuspended(value: boolean) {
  if (videoSuspended === value) return
  videoSuspended = value
  void retuneAll()
}

export const isVideoSuspended = () => videoSuspended

// --- Monitor qualità e controllo di banda ---------------------------------

export type Quality = 'good' | 'fair' | 'poor'

export type QualitySample = {
  quality: Quality
  rttMs: number | null
  lossPct: number // il peggiore tra perdita in uscita e in ingresso (audio)
  outKbps: number | null // stima di banda disponibile in uscita
  audioCodec: string | null
  videoSuspended: boolean
}

const SAMPLE_MS = 2000
const LOW_KBPS = 120 // sotto questa banda il video soffoca l'audio
const BAD_LOSS = 10 // % di pacchetti audio persi
const RESUME_MIN_MS = 15_000
const RESUME_MAX_MS = 60_000
const STABLE_RESET_MS = 30_000

/**
 * Ogni 2 s legge le statistiche: calcola un indicatore di qualità e, se la
 * rete non regge, sospende il video in uscita per lasciare tutta la banda alla
 * voce. Riprova a riattivarlo con attesa crescente (15 s → 60 s).
 */
export function startQualityMonitor(
  pc: RTCPeerConnection,
  onSample: (s: QualitySample) => void,
  canSendVideo: () => boolean,
): () => void {
  let prevIn: { lost: number; recv: number } | null = null
  let badStreak = 0
  let resumeDelay = RESUME_MIN_MS
  let suspendedAt = 0
  let resumedAt = 0
  let stopped = false

  const tick = async () => {
    if (stopped || pc.connectionState === 'closed') return
    let rtt: number | null = null
    let outKbps: number | null = null
    let outLoss = 0
    let inLoss = 0
    let audioCodec: string | null = null
    try {
      const stats = await pc.getStats()
      let pairId: string | undefined
      stats.forEach(s => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId
      })
      stats.forEach(s => {
        if (!pairId && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id
      })
      const pair: any = pairId ? stats.get(pairId) : null
      if (pair?.currentRoundTripTime != null) rtt = Math.round(pair.currentRoundTripTime * 1000)
      if (pair?.availableOutgoingBitrate != null) outKbps = Math.round(pair.availableOutgoingBitrate / 1000)

      stats.forEach((s: any) => {
        if (s.kind !== 'audio') return
        if (s.type === 'remote-inbound-rtp') {
          // come l'altro lato riceve il nostro audio
          if (typeof s.fractionLost === 'number') outLoss = Math.max(outLoss, s.fractionLost * 100)
          if (rtt == null && typeof s.roundTripTime === 'number') rtt = Math.round(s.roundTripTime * 1000)
        } else if (s.type === 'inbound-rtp') {
          const cur = { lost: s.packetsLost ?? 0, recv: s.packetsReceived ?? 0 }
          if (prevIn) {
            const lost = cur.lost - prevIn.lost
            const total = lost + (cur.recv - prevIn.recv)
            if (total > 0) inLoss = Math.max(0, (lost / total) * 100)
          }
          prevIn = cur
        } else if (s.type === 'outbound-rtp' && s.codecId) {
          audioCodec = stats.get(s.codecId)?.mimeType?.replace(/^audio\//i, '') ?? null
        }
      })
    } catch {
      return schedule()
    }

    const lossPct = Math.round(Math.max(outLoss, inLoss) * 10) / 10
    const quality: Quality =
      (rtt ?? 0) < 250 && lossPct < 2 ? 'good' : (rtt ?? 0) < 500 && lossPct < 8 ? 'fair' : 'poor'

    // --- controllo del video in uscita ---
    const now = Date.now()
    const bad = (outKbps != null && outKbps < LOW_KBPS) || outLoss >= BAD_LOSS
    badStreak = bad ? badStreak + 1 : 0
    if (!isVideoSuspended()) {
      if (badStreak >= 2 && canSendVideo()) {
        // se ricade subito dopo una ripresa, aspetta di più la prossima volta
        resumeDelay = now - resumedAt < STABLE_RESET_MS ? Math.min(resumeDelay * 2, RESUME_MAX_MS) : RESUME_MIN_MS
        suspendedAt = now
        setVideoSuspended(true)
      }
    } else if (now - suspendedAt >= resumeDelay && !bad) {
      resumedAt = now
      badStreak = 0
      setVideoSuspended(false)
    }

    onSample({ quality, rttMs: rtt, lossPct, outKbps, audioCodec, videoSuspended: isVideoSuspended() })
    schedule()
  }

  let timer: number | undefined
  const schedule = () => {
    if (!stopped) timer = window.setTimeout(tick, SAMPLE_MS)
  }
  schedule()

  return () => {
    stopped = true
    clearTimeout(timer)
    setVideoSuspended(false)
  }
}
