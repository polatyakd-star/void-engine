# VOID Render

cPanel unutuldu. Token yakmayan motor Render Web Service.

Tek sira POST. Delay tabani 1200ms. 401/403 uc vurus sonrasi dead, ilk seferde olmez. allowed_mentions yok.

## Deploy

[Render](https://dashboard.render.com) → New → Web Service

- Root: `void/render`
- Build: `npm install`
- Start: `node server.js`
- Health: `/health`
- Env: `PANEL_KEY` = `mdwK1vU0EYtuoZInbBazkf9cMhXAiHW7`
- Env: `KEEP_URL` = `https://SENIN-SERVIS.onrender.com`  (4 dk self ping, free uyumasin)

Cikan URL: `https://<ad>.onrender.com`

UptimeRobot 5 dk `https://<ad>.onrender.com/health` da koy.

## Panel

VOID AYARLAR:

- panel url: `https://<ad>.onrender.com`
- panel key: `mdwK1vU0EYtuoZInbBazkf9cMhXAiHW7`
- delay 1200+  (panel 40 yazsa motor 1200 yapar)
- threads 1
- suffix acik
- START

Health: `https://<ad>.onrender.com/v1/health` → `{"ok":true,"engine":"render"}`
