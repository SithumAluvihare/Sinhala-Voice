# Sinhala Voice

Speak English, hear Sinhala in real time. A static website that streams your mic to the
Gemini Live API (`gemini-3.5-live-translate-preview`) using **your own API key**, and plays
back the Sinhala translation with live transcripts.

There is no server. The key and audio go straight from the browser to Google.

## Two ways to use it

- **Browser tab** (Chrome or Edge on a computer): press the button, pick a tab such as a YouTube
  video and turn on **Share tab audio**. The Sinhala voice plays from this page. The original
  English plays quietly underneath and dips while Sinhala is speaking. Choose "Off" or
  "Full volume" under **Original English**.
- **Microphone:** translate what's said in the room. Use headphones to avoid feedback.

## How it stays fast and smooth

- **Connects early:** the connection to Gemini opens while the share picker is still open.
- **No gaps on long videos:** when Google warns that a session is ending (`goAway`), a new
  session is opened in the background and audio switches over once it's ready. The old one
  stays open for 4 seconds to deliver its last words.
- **Auto-reconnect:** network drops retry with backoff. Key, model and quota errors stop with
  a plain-language message instead of retrying.
- **Lag meter:** shows when the Sinhala falls behind and suggests slowing the video.
- **Key check:** saving a key opens a test session with Google first, so a bad key is caught
  before you start.

## Install as an app

`manifest.webmanifest`, `sw.js` and `icons/` make the site installable. Chrome and Edge show an
**Install app** button. The same build can be packaged for the Microsoft Store with
[PWABuilder](https://www.pwabuilder.com/).

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout and a strict Content-Security-Policy (only Google's Live API endpoint can be contacted) |
| `style.css` | Styles, light and dark mode, mobile layout |
| `app.js` | Key storage, Live API WebSocket, audio playback, transcripts, auto-reconnect |
| `pcm-capture.js` | AudioWorklet that turns mic audio into 16 kHz 16-bit PCM in 100 ms chunks |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it an installable app (PWA) |
| `brand/` | Logo: `logo-256.png` (header), `logo-full.png` (transparent, full size), `logo-original-crop.png` (white background) |

## Run locally

The mic and AudioWorklet only work over `http://localhost` or HTTPS. Double-clicking
`index.html` won't work.

```bash
python -m http.server 5173
```

Then open http://localhost:5173.

## Deploy (free)

Any static host works. For example:

- **GitHub Pages:** push these files to a repo, then go to Settings → Pages → Deploy from branch → `main` / root.
- **Cloudflare Pages / Netlify / Vercel:** drag and drop the folder, no build step.

All of these give you HTTPS, which the microphone needs.

## Notes

- Change the model name or target language under **Advanced settings** if Google renames the preview model.
- `echoTargetLanguage` is `false`, so if someone speaks Sinhala the app stays silent instead of repeating it.
- Use headphones to stop the translated voice from feeding back into the mic.
