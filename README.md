Setup:
1. cd /Users/natanaelxhelilaj/Documents/Intercom/church-intercom
2. npm install
3. npm start
4. Open http://localhost:3000

Environment configuration:
- Runtime configuration is managed through environment files at the project root.
- `.env.default` contains the committed defaults that ship with the project.
- `.env` overrides values from `.env.default` and is loaded automatically on start.
- Update `SSL_KEY_PATH`, `SSL_CERT_PATH`, and `SSL_CA_PATH` in `.env` when enabling HTTPS, along with any other deployment-specific values.

HTTPS:
- Browsers require HTTPS (or localhost) for microphone access. To serve this app over HTTPS, set the following environment variables before running `npm start`:
  - `HTTPS=true`
  - `SSL_KEY_PATH=/absolute/path/to/your/server.key`
  - `SSL_CERT_PATH=/absolute/path/to/your/server.crt`
- Optionally set `SSL_CA_PATH` if your certificate chain requires it.
- You can generate a self-signed certificate for local use with a command such as:
  - `openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt -days 365`
  - Then point `SSL_KEY_PATH` and `SSL_CERT_PATH` at the generated files.
  - For local development you can reuse the committed sample pair in `certs/ssl_key.pem` and `certs/ssl_cert.pem` by leaving the
    defaults provided in `.env`/`.env.default`.

Usage:
- Use /generate?room=room1 to get a token (JSON).
- Use /qr?room=room1 to get a QR PNG that encodes a join URL with token.
- Scan QR or open URL like: http://localhost:3000/?room=room1&token=...
- Admin: use ADMIN_SECRET (default ADMIN-DEMO-TOKEN-CHANGEME) or generate admin=true tokens to kick users.

Notes:
- This demo uses in-memory tokens and a mesh WebRTC model (each peer connects to every other peer).
- For production: secure admin tokens, persist tokens, and consider an SFU for many participants.
