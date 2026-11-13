import { joinRoom } from 'trystero'
import {
  createInvite,
  inviteToHash,
  inviteUrl,
  isConsumed,
  isExpired,
  markConsumed,
  parseInvite,
  roomName,
  type Invite,
} from './link'
import { verificationCode } from './verify'
import {
  audioConstraints,
  hintTracks,
  retuneAll,
  startQualityMonitor,
  TunedPeerConnection,
  videoConstraints,
  type QualitySample,
} from './rtc'

const APP_ID = 'openmeet-p2p-1on1-v1'
const GUEST_WAIT_HINT_MS = 45_000

type Room = ReturnType<typeof joinRoom>
type Ctl = { t: 'state'; mic: boolean; cam: boolean; vp?: boolean } | { t: 'bye' }
type Tone = 'ok' | 'warn' | 'bad' | 'idle'

// ---------------------------------------------------------------------------
// DOM
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const screens = { home: $('home'), call: $('call'), message: $('message') }
const remoteVideo = $<HTMLVideoElement>('remote-video')
const localVideo = $<HTMLVideoElement>('local-video')
const remotePlaceholder = $('remote-placeholder')
const localOff = $('local-off')
const statusEl = $('status')
const statusText = $('status-text')
const remoteFlags = $('remote-flags')
const qualityEl = $('quality')
const localNote = $('local-note')
const sharePanel = $('share')
const shareLink = $<HTMLInputElement>('share-link')
const verifyPanel = $('verify')
const verifyCode = $('verify-code')
const banner = $('banner')
const btnMic = $<HTMLButtonElement>('toggle-mic')
const btnCam = $<HTMLButtonElement>('toggle-cam')

function show(name: keyof typeof screens) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name
}

function setStatus(text: string, tone: Tone = 'idle') {
  statusText.textContent = text
  statusEl.dataset.tone = tone
}

function showBanner(text: string | null) {
  banner.hidden = !text
  banner.textContent = text ?? ''
}

function endScreen(title: string, text: string) {
  $('message-title').textContent = title
  $('message-text').textContent = text
  show('message')
}

// ---------------------------------------------------------------------------
// Stato della chiamata
let invite: Invite | null = null
let room: Room | null = null
let sendCtl: ((msg: Ctl) => Promise<void>) | null = null
let localStream: MediaStream | null = null
let remotePeerId: string | null = null
let remoteSaidBye = false
let ended = false
let micOn = true
let camOn = true
let guestWaitTimer: number | undefined
let stopMonitor: (() => void) | null = null
let videoPaused = false

const hostKey = (inv: Invite) => `openmeet:host:${roomName(inv)}`

// ---------------------------------------------------------------------------
// Media locali

async function getLocalMedia(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints })
  } catch (err) {
    console.warn('audio+video non disponibili', err)
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
    showBanner('Webcam non disponibile: partecipi solo con l’audio.')
    return s
  } catch (err) {
    console.warn('audio non disponibile', err)
  }
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fake')) return fakeMedia()
  showBanner('Microfono e webcam non disponibili (permesso negato o dispositivi occupati). Puoi comunque vedere e sentire l’altra persona.')
  return null
}

/** Solo sviluppo (?fake): tono + animazione al posto di microfono e webcam. */
function fakeMedia(): MediaStream {
  const ac = new AudioContext()
  const osc = ac.createOscillator()
  const dest = ac.createMediaStreamDestination()
  osc.frequency.value = 440
  osc.connect(dest)
  osc.start()
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 })
  const g = canvas.getContext('2d')!
  let f = 0
  setInterval(() => {
    g.fillStyle = `hsl(${f++ % 360} 60% 40%)`
    g.fillRect(0, 0, 320, 180)
    g.fillStyle = '#fff'
    g.font = '24px sans-serif'
    g.fillText(`fake ${f}`, 20, 100)
  }, 1000 / 24)
  return new MediaStream([...dest.stream.getAudioTracks(), ...canvas.captureStream(24).getVideoTracks()])
}

function refreshLocalUi() {
  const hasAudio = !!localStream?.getAudioTracks().length
  const hasVideo = !!localStream?.getVideoTracks().length
  btnMic.disabled = !hasAudio
  btnCam.disabled = !hasVideo && !camOn
  btnMic.classList.toggle('off', !micOn || !hasAudio)
  btnCam.classList.toggle('off', !camOn || !hasVideo)
  btnMic.title = micOn ? 'Disattiva microfono' : 'Attiva microfono'
  btnCam.title = camOn ? 'Spegni webcam' : 'Accendi webcam'
  localOff.hidden = camOn && hasVideo
  localNote.hidden = !(videoPaused && camOn)
}

function announceState() {
  sendCtl?.({ t: 'state', mic: micOn, cam: camOn, vp: videoPaused }).catch(() => {})
}

function toggleMic() {
  micOn = !micOn
  localStream?.getAudioTracks().forEach(t => (t.enabled = micOn))
  refreshLocalUi()
  announceState()
}

async function toggleCam() {
  if (!localStream) return
  btnCam.disabled = true
  try {
    const old = localStream.getVideoTracks()[0]
    if (camOn && old) {
      // spegnimento vero (si spegne anche la luce della webcam);
      // la traccia ferma resta nello stream finché non la sostituiamo
      old.stop()
      camOn = false
    } else {
      const fresh = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints })).getVideoTracks()[0]
      fresh.contentHint = 'motion'
      if (old) {
        if (room) await room.replaceTrack(old, fresh)
        localStream.removeTrack(old)
      }
      localStream.addTrack(fresh)
      localVideo.srcObject = localStream
      camOn = true
      void retuneAll() // i parametri dell'encoder valgono anche per la nuova traccia
    }
  } catch (err) {
    console.error(err)
    showBanner('Impossibile riaccendere la webcam.')
  } finally {
    btnCam.disabled = false
    refreshLocalUi()
    announceState()
  }
}

// ---------------------------------------------------------------------------
// Connessione

function stopEverything() {
  clearTimeout(guestWaitTimer)
  stopMonitor?.()
  stopMonitor = null
  localStream?.getTracks().forEach(t => t.stop())
  remoteVideo.srcObject = null
  const r = room
  room = null
  sendCtl = null
  r?.leave().catch(() => {})
}

function finish(title: string, text: string) {
  if (ended) return
  ended = true
  stopEverything()
  if (invite) sessionStorage.removeItem(hostKey(invite))
  history.replaceState(null, '', location.pathname + location.search)
  endScreen(title, text)
}

async function hangUp() {
  if (sendCtl && remotePeerId) {
    // best effort: avvisa l'altro lato, ma non bloccare il riaggancio
    await Promise.race([sendCtl({ t: 'bye' }), new Promise(r => setTimeout(r, 300))]).catch(() => {})
  }
  finish('Chiamata terminata', 'Hai riagganciato. Il link usato non è più valido: per un’altra chiamata creane uno nuovo.')
}

async function describeRoute(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats()
    let pairId: string | undefined
    stats.forEach(s => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId
    })
    const pair: any = pairId ? stats.get(pairId) : null
    const local: any = pair ? stats.get(pair.localCandidateId) : null
    const remote: any = pair ? stats.get(pair.remoteCandidateId) : null
    const types = [local?.candidateType, remote?.candidateType]
    return types.includes('relay') ? 'via relay TURN' : 'peer-to-peer diretto'
  } catch {
    return 'peer-to-peer diretto'
  }
}

const QUALITY_LABEL = { good: 'buona', fair: 'discreta', poor: 'scarsa' } as const

function onQuality(s: QualitySample) {
  if (ended) return
  qualityEl.hidden = false
  qualityEl.dataset.tone = s.quality === 'good' ? 'ok' : s.quality === 'fair' ? 'warn' : 'bad'
  const parts = [`Qualità ${QUALITY_LABEL[s.quality]}`]
  if (s.rttMs != null) parts.push(`${s.rttMs} ms`)
  if (s.lossPct >= 1) parts.push(`${s.lossPct}% persi`)
  qualityEl.querySelector('.label')!.textContent = parts.join(' · ')
  qualityEl.title = [
    s.audioCodec && `Audio: ${s.audioCodec}`,
    s.outKbps != null && `Banda in uscita stimata: ${s.outKbps} kbit/s`,
  ].filter(Boolean).join('\n')
  if (s.videoSuspended !== videoPaused) {
    videoPaused = s.videoSuspended
    refreshLocalUi()
    announceState()
  }
}

async function onConnected(pc: RTCPeerConnection) {
  setStatus(`Connesso · ${await describeRoute(pc)}`, 'ok')
  showBanner(null)
  if (!stopMonitor) stopMonitor = startQualityMonitor(pc, onQuality, () => camOn)
  if (!verifyPanel.hidden && verifyCode.textContent !== '···-···') return
  verifyPanel.hidden = false
  // l'handshake DTLS può completarsi un attimo dopo: riprova qualche volta
  for (let i = 0; i < 10 && !ended; i++) {
    const code = await verificationCode(pc)
    if (code) {
      verifyCode.textContent = code
      return
    }
    await new Promise(r => setTimeout(r, 300))
  }
  verifyCode.textContent = 'non disponibile'
}

function watchConnection(pc: RTCPeerConnection) {
  const update = () => {
    if (ended) return
    switch (pc.connectionState) {
      case 'connected':
        void onConnected(pc)
        break
      case 'connecting':
      case 'new':
        setStatus('Connessione in corso…', 'warn')
        break
      case 'disconnected':
        setStatus('Connessione instabile, riprovo…', 'warn')
        break
      case 'failed':
        setStatus('Connessione persa', 'bad')
        showBanner('La connessione diretta si è interrotta e non è stato possibile ristabilirla. Riaggancia e create un nuovo link.')
        break
      case 'closed':
        break
    }
  }
  pc.addEventListener('connectionstatechange', update)
  update()
}

async function startCall(inv: Invite, isHost: boolean) {
  invite = inv
  show('call')
  setStatus('Accesso a webcam e microfono…')
  refreshLocalUi()

  if (isHost) {
    shareLink.value = inviteUrl(inv)
    $('share-exp').textContent = new Date(inv.exp).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
    sharePanel.hidden = false
  }

  localStream = await getLocalMedia()
  if (ended) return
  camOn = !!localStream?.getVideoTracks().length
  localVideo.srcObject = localStream
  refreshLocalUi()

  setStatus(isHost ? 'In attesa dell’altro partecipante…' : 'Connessione all’host…', 'warn')
  remotePlaceholder.textContent = isHost ? 'In attesa dell’altro partecipante…' : 'Connessione in corso…'

  const r = joinRoom(
    {
      appId: APP_ID,
      password: inv.pw, // cifra la segnalazione (AES-GCM, chiave via PBKDF2)
      maxUsers: 2, // un terzo che arriva viene rifiutato
      identity: 'none', // identità usa-e-getta: niente chiavi persistenti tra chiamate
      rtcPolyfill: TunedPeerConnection, // priorità audio, RED, limiti video
    },
    roomName(inv),
  )
  room = r
  if (import.meta.env.DEV) (window as any).__room = r // ispezione da console

  const ctl = r.makeAction<Ctl>('ctl')
  sendCtl = (msg) => ctl.send(msg, remotePeerId ? { target: remotePeerId } : undefined)

  if (!isHost) {
    guestWaitTimer = window.setTimeout(() => {
      if (!remotePeerId && !ended)
        showBanner('Ancora nessuna risposta. L’host potrebbe aver chiuso la pagina, oppure la connessione diretta è bloccata da firewall/NAT. Continuo a provare…')
    }, GUEST_WAIT_HINT_MS)
  }

  r.onPeerJoin(({ peerId }) => {
    if (ended) return
    if (remotePeerId && remotePeerId !== peerId) return // già in chiamata con qualcun altro
    remotePeerId = peerId
    clearTimeout(guestWaitTimer)
    sharePanel.hidden = true
    showBanner(null)
    remotePlaceholder.textContent = 'Connesso, in attesa del video…'

    // da qui il link è "consumato": niente riutilizzo da questo browser,
    // e lo togliamo dalla barra degli indirizzi / cronologia
    markConsumed(inv)
    history.replaceState(null, '', location.pathname + location.search)

    if (localStream) {
      hintTracks(localStream)
      r.addStream(localStream, { target: peerId }).then(retuneAll, console.error)
    }
    announceState()

    const pc = r.getPeers()[peerId]?.connection
    if (pc) watchConnection(pc)
    else setStatus('Connesso', 'ok')
  })

  r.onPeerLeave(({ peerId }) => {
    if (peerId !== remotePeerId) return
    finish(
      remoteSaidBye ? 'Chiamata terminata' : 'Connessione persa',
      remoteSaidBye ? 'L’altra persona ha riagganciato.' : 'L’altra persona si è disconnessa o la connessione è caduta.',
    )
  })

  r.onPeerStream((stream, { peerId }) => {
    if (peerId !== remotePeerId) return
    remoteVideo.srcObject = stream
    remotePlaceholder.hidden = true
    remoteVideo.play().catch(() => {
      // autoplay con audio bloccato: serve un gesto dell'utente
      remotePlaceholder.hidden = false
      remotePlaceholder.textContent = 'Tocca lo schermo per avviare l’audio'
      document.addEventListener('click', () => { remoteVideo.play(); remotePlaceholder.hidden = true }, { once: true })
    })
  })

  ctl.onMessage((msg, { peerId }) => {
    if (peerId !== remotePeerId) return
    if (msg.t === 'bye') remoteSaidBye = true
    if (msg.t === 'state') {
      const paused = msg.cam && !!msg.vp
      const flags = [
        !msg.mic && '🔇 microfono spento',
        !msg.cam && '📷 webcam spenta',
        paused && '⏸ video in pausa (rete lenta)',
      ].filter(Boolean)
      remoteFlags.textContent = flags.length ? `Altro partecipante: ${flags.join(' · ')}` : ''
      if (remoteVideo.srcObject) {
        remotePlaceholder.hidden = msg.cam && !paused
        remotePlaceholder.textContent = paused
          ? 'Video in pausa per la rete lenta: l’audio continua'
          : 'Webcam dell’altro partecipante spenta'
      }
    }
  })

  r.onError(err => {
    console.warn('[trystero]', err.code, err.message)
    if (ended) return
    switch (err.code) {
      case 'room-full':
        if (!remotePeerId && Object.keys(r.getPeers()).length === 0)
          finish('Stanza occupata', 'In questa chiamata ci sono già due persone. Chiedi all’host un nuovo link.')
        break
      case 'peer-connect-failed':
        setStatus('Connessione diretta non riuscita', 'bad')
        showBanner(
          'Non è stato possibile creare una connessione diretta tra i due dispositivi. ' +
            'Succede con alcune reti (aziendali, scolastiche, 4G/5G con NAT restrittivo) che bloccano il peer-to-peer. ' +
            'Prova a cambiare rete (es. hotspot o Wi-Fi di casa) e a creare un nuovo link.',
        )
        break
      case 'relay-failed':
        if (!remotePeerId)
          showBanner('Alcuni server di segnalazione non rispondono. Se l’altra persona non si collega, controlla la connessione a Internet.')
        break
      case 'handshake-failed':
        showBanner('Handshake di sicurezza fallito con un partecipante: connessione rifiutata.')
        break
      // 'decrypt-failed': qualcuno con la password sbagliata. Lo ignoriamo.
    }
  })
}

// ---------------------------------------------------------------------------
// Avvio

function goHome() {
  location.href = location.pathname + location.search
}

function boot() {
  $('new-call').addEventListener('click', () => {
    const inv = createInvite()
    sessionStorage.setItem(hostKey(inv), '1')
    history.replaceState(null, '', inviteToHash(inv))
    void startCall(inv, true)
  })
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareLink.value)
    } catch {
      shareLink.select()
      document.execCommand('copy')
    }
    $('copy-link').textContent = 'Copiato!'
    setTimeout(() => ($('copy-link').textContent = 'Copia'), 1500)
  })
  btnMic.addEventListener('click', toggleMic)
  btnCam.addEventListener('click', () => void toggleCam())
  $('hangup').addEventListener('click', () => void hangUp())
  $('go-home').addEventListener('click', goHome)
  window.addEventListener('pagehide', () => {
    if (remotePeerId) sendCtl?.({ t: 'bye' }).catch(() => {})
    stopEverything()
  })

  if (!location.hash) return show('home')

  const inv = parseInvite(location.hash)
  if (!inv) return endScreen('Link non valido', 'Il link è incompleto o danneggiato. Chiedi all’host di inviarlo di nuovo.')
  if (isExpired(inv)) return endScreen('Link scaduto', 'Questo link non è più valido. Chiedi all’host di crearne uno nuovo.')
  if (isConsumed(inv)) return endScreen('Link già usato', 'Questo link è già stato usato per una chiamata. Per parlare di nuovo serve un link nuovo.')

  void startCall(inv, sessionStorage.getItem(hostKey(inv)) === '1')
}

window.addEventListener('hashchange', () => location.reload())
boot()
