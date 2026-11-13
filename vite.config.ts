import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy solo in produzione (in sviluppo Vite inietta stili
// inline per l'HMR). La pagina carica solo i propri file e parla solo con i
// relay Nostr via WebSocket; WebRTC non passa da connect-src.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  'connect-src wss:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'openmeet-csp',
  apply: 'build',
  transformIndexHtml: html =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

// base relativo: funziona su GitHub Pages sotto /<nome-repo>/
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  plugins: [csp()],
})
