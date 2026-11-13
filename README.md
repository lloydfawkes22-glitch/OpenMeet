# OpenMeet

Videochiamate 1:1 peer-to-peer nel browser. Pagina statica, nessun backend.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/, pronto per GitHub Pages
```

Test locale: apri http://localhost:5173 in una scheda, clicca **Nuova chiamata**,
copia il link e aprilo in una seconda scheda (o in una finestra in incognito).

## Come funziona
- Segnalazione: Trystero (strategia Nostr, relay pubblici), cifrata con la password del link.
- Link: `#room=<128 bit>&pw=<128 bit>&exp=<ms>`. Il frammento non arriva mai al server.
  La scadenza fa parte del nome della stanza: modificarla porta in una stanza vuota.
- Stanza limitata a 2 utenti (`maxUsers: 2`); il terzo riceve "Stanza occupata".
- Codice di verifica: SHA-256 delle impronte dei certificati DTLS (locale + remoto, ordinate),
  6 caratteri base32. Se i codici a voce coincidono, nessuno sta facendo da intermediario.
- Link "monouso": dopo la connessione il browser lo segna come usato e lo rimuove dalla barra
  degli indirizzi. Senza server non è un'invalidazione globale: la garanzia vera è il limite di 2.
- STUN: Google + Cloudflare (default Trystero). Niente TURN: su NAT simmetrici/reti aziendali
  la connessione diretta può fallire, e l'app lo dice esplicitamente.

## Ottimizzazioni (priorità all'audio)
Tutto in [src/rtc.ts](src/rtc.ts), applicato tramite una sottoclasse di `RTCPeerConnection`
passata a Trystero come `rtcPolyfill` (nessuna modifica manuale dell'SDP).

- **Audio**: Opus mono 48 kHz con cancellazione eco, soppressione rumore e AGC; `contentHint: 'speech'`.
  **RED** (ridondanza audio) negoziato davanti a Opus: ogni pacchetto porta anche il frame
  precedente, così una perdita non diventa un buco nella voce (~65 kbit/s invece di ~32).
  Sender audio con `priority`/`networkPriority: 'high'` (allocazione di banda + marcatura DSCP).
- **Video**: 960×540 a 24 fps (640×360 a 20 fps su dispositivi con ≤2 core o ≤2 GB),
  tetto 900 kbit/s (450 sui deboli), priorità bassa, `maintain-framerate`: sotto carico
  scende la risoluzione, non la fluidità. VP8, il codec più leggero in software.
- **Controllo di banda**: ogni 2 s legge RTT, perdita e banda stimata. Se la banda in uscita
  scende sotto 120 kbit/s o l'audio perde ≥10% dei pacchetti, il video in uscita va in pausa
  (l'altro lato lo vede segnalato) e riprova a ripartire dopo 15 s, fino a 60 s se ricade.
- **Indicatore qualità** nella barra in alto (buona/discreta/scarsa, ms, % persi); il tooltip
  mostra codec audio e banda stimata.
- `bundlePolicy: 'max-bundle'`: audio, video e dati su un'unica porta/connessione DTLS.

Test senza webcam (solo `npm run dev`): apri `http://localhost:5173/?fake` per usare un tono e
un video sintetici al posto dei dispositivi.
