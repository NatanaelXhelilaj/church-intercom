Setup:
1. cd /Users/natanaelxhelilaj/Documents/Intercom/church-intercom
2. npm install
3. npm start
4. Open http://localhost:3000

Usage:
- Use /generate?room=room1 to get a token (JSON).
- Use /qr?room=room1 to get a QR PNG that encodes a join URL with token.
- Scan QR or open URL like: http://localhost:3000/?room=room1&token=...
- Admin: use ADMIN_SECRET (default ADMIN-DEMO-TOKEN-CHANGEME) or generate admin=true tokens to kick users.

Notes:
- This demo uses in-memory tokens and a mesh WebRTC model (each peer connects to every other peer).
- For production: secure admin tokens, persist tokens, and consider an SFU for many participants.
