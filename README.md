# Church Intercom

A real-time audio communication web application with user authentication for group conversations in churches and similar venues.

## Features

- 🔐 **User Authentication** - Secure registration and login with PostgreSQL backend
- 🎤 **WebRTC Audio Streaming** - Low-latency peer-to-peer audio using mediasoup
- 👥 **Multiple Rooms** - Support for multiple concurrent audio rooms
- 🎛️ **Admin Controls** - Kick users, manage house feed (admin-only)
- 🔊 **House Feed** - Stream venue audio to all participants
- 📱 **Device Selection** - Choose microphone and speaker devices (desktop admins only)
- 🎧 **Push-to-Talk** - Physical headset button support
- 🌙 **Dark Mode** - Automatic dark mode support

## Prerequisites

- Node.js (v18 or higher recommended)
- PostgreSQL (v12 or higher)
- Modern web browser with WebRTC support

**OR**

- Docker and Docker Compose (for containerized deployment)

## Installation

### Quick Start with Docker (Recommended)

The easiest way to run Church Intercom is using Docker:

```bash
# Copy environment configuration
cp .env.docker .env

# Edit .env and set SESSION_SECRET and DB_PASSWORD
nano .env

# Start the application
docker-compose up -d

# Access at http://localhost:3000
```

For detailed Docker instructions, see [DOCKER.md](DOCKER.md).

### Manual Installation

### 1. Clone the repository

```bash
cd /Users/natanaelxhelilaj/Documents/Intercom/church-intercom
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up PostgreSQL database

Create a new PostgreSQL database:

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE church_intercom;

# Exit psql
\q
```

Run the database schema:

```bash
psql -U postgres -d church_intercom -f database.sql
```

### 4. Configure environment variables

Copy the default environment file:

```bash
cp .env.default .env
```

Edit `.env` and configure your settings:

```bash
# Database connection
DB_HOST=localhost
DB_PORT=5432
DB_NAME=church_intercom
DB_USER=postgres
DB_PASSWORD=your_password_here

# Session secret (IMPORTANT: Change this!)
SESSION_SECRET=your-random-secret-here

# Server configuration
PORT=3000
ANNOUNCED_IP=127.0.0.1

# HTTPS (optional, for production)
HTTPS=false
```

**Important:** Generate a strong session secret for production:

```bash
# Generate a random secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Create the first admin user

After running the database schema, a default admin user is created:

- **Username:** admin
- **Password:** admin123

**⚠️ SECURITY WARNING:** Change this password immediately after first login!

You can update the password directly in the database:

```bash
# Generate a new password hash with bcrypt
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your-new-password', 10).then(hash => console.log(hash));"

# Update in database
psql -U postgres -d church_intercom -c "UPDATE users SET password_hash='<hash-from-above>' WHERE username='admin';"
```

## Running the Application

### Development

```bash
npm start
```

The server will start on `http://localhost:3000` (or your configured port).

### First-time setup

1. Visit `http://localhost:3000` - you'll be redirected to the login page
2. Login with the default admin credentials (or register a new account)
3. Select a room and start communicating!

## Usage

### For Users

1. **Register/Login** - Create an account or login at `/auth.html`
2. **Select a Room** - Choose from available rooms
3. **Join** - Click a room button to join
4. **Audio Controls:**
   - **Mute/Unmute** - Control your microphone
   - **Push to Talk** - Hold to temporarily unmute
   - **Leave Room** - Disconnect from current room
   - **Logout** - Sign out of your account

### For Admins

Admins have additional capabilities:

- **View All Participants** - See everyone in the room
- **Kick Users** - Remove disruptive users
- **House Feed Control** - Start/stop venue audio streaming (per-user)
- **Stream to Server** - Stream microphone audio to server's speakers/headphone jack
- **Device Management** - Access to device selection controls

### House Feed (Server Audio)

Configure venue audio streaming by setting the `SERVER_AUDIO_COMMAND` environment variable. This allows users to receive audio from the server's audio input device:

```bash
# Example: Stream from ALSA audio input (Linux)
SERVER_AUDIO_COMMAND="ffmpeg -hide_banner -loglevel error -f alsa -i default -ac 2 -ar 48000 -acodec libopus -b:a 128k -payload_type {payloadType} -ssrc {ssrc} -f rtp rtp://{ip}:{port}"

# Example: Stream from macOS audio input
SERVER_AUDIO_COMMAND="ffmpeg -hide_banner -loglevel error -f avfoundation -i ':0' -ac 2 -ar 48000 -acodec libopus -b:a 128k -payload_type {payloadType} -ssrc {ssrc} -f rtp rtp://{ip}:{port}"

# Custom display name for house feed
SERVER_AUDIO_NAME="Main Sanctuary Audio"
```

The placeholders `{ip}`, `{port}`, `{payloadType}`, and `{ssrc}` are automatically replaced at runtime.

### Admin-to-Server Streaming

Admins can stream their microphone audio directly to the server's speakers/headphone jack by configuring the `ADMIN_TO_SERVER_COMMAND` environment variable:

```bash
# Example: Play to ALSA audio output (Linux)
ADMIN_TO_SERVER_COMMAND="ffmpeg -hide_banner -loglevel error -protocol_whitelist file,rtp,udp -i rtp://0.0.0.0:{port}?localrtcpport={port} -f alsa default"

# Example: Play to macOS audio output (CoreAudio)
ADMIN_TO_SERVER_COMMAND="ffmpeg -hide_banner -loglevel error -protocol_whitelist file,rtp,udp -i rtp://0.0.0.0:{port}?localrtcpport={port} -f avfoundation -audio_device_index 0 -"

# Example: Play to specific audio device
ADMIN_TO_SERVER_COMMAND="ffmpeg -hide_banner -loglevel error -protocol_whitelist file,rtp,udp -i rtp://0.0.0.0:{port}?localrtcpport={port} -f pulse 'alsa_output.usb-device.analog-stereo'"
```

The `{port}` placeholder is automatically replaced with the port mediasoup assigns to the PlainTransport. This feature is useful for:
- Making announcements through the venue's PA system
- Testing audio routing
- Remote sound checks

## Architecture

### Backend (Node.js)

- **Express.js** - Web server
- **Socket.IO** - Real-time bidirectional communication
- **mediasoup** - WebRTC SFU (Selective Forwarding Unit)
- **PostgreSQL** - User database and session storage
- **bcrypt** - Password hashing

### Frontend (Vanilla JavaScript)

- **mediasoup-client** - WebRTC client library
- **Socket.IO Client** - Real-time communication
- **HTML5 Media APIs** - getUserMedia, WebRTC

### Authentication Flow

1. User registers/logs in via `/api/register` or `/api/login`
2. Server creates session with PostgreSQL-backed storage
3. Session cookie is set with `httpOnly` and `sameSite` flags
4. Socket.IO connections validate session before allowing room access
5. User info (including admin status) is attached to socket

## Security Features

✅ **Implemented:**
- User authentication with bcrypt password hashing
- Session-based authentication with PostgreSQL storage
- Admin authorization for privileged operations
- Input validation and sanitization
- Secure session cookies (httpOnly, sameSite)
- SQL injection prevention (parameterized queries)
- HTTPS support
- Improved error logging
- Race condition fixes

⚠️ **Production Recommendations:**
- Enable HTTPS in production
- Use a strong `SESSION_SECRET`
- Set up rate limiting (not included, but recommended)
- Configure firewall rules for mediasoup ports
- Regular security audits
- Keep dependencies updated

## Troubleshooting

### Database Connection Errors

```
Error: Failed to connect to database
```

**Solution:** Verify PostgreSQL is running and credentials are correct in `.env`

```bash
# Test connection
psql -U postgres -d church_intercom -c "SELECT 1;"
```

### mediasoup-client Loading Errors

```
Error: Unable to load mediasoup-client
```

**Solution:** The client attempts multiple fallback CDNs. Check browser console for specific errors. Ensure `mediasoup-client` is installed:

```bash
npm install mediasoup-client
```

### Audio Not Working

1. **Check browser permissions** - Allow microphone access
2. **Check device selection** - Try different input devices (admin only)
3. **Check network** - Ensure UDP ports are not blocked
4. **Check ANNOUNCED_IP** - Must be reachable by clients

### Session/Authentication Issues

```
Error: Authentication required
```

**Solution:**
- Clear browser cookies
- Verify `SESSION_SECRET` is set
- Check PostgreSQL sessions table exists

## API Endpoints

### Authentication

- `POST /api/register` - Register new user
- `POST /api/login` - Login
- `POST /api/logout` - Logout
- `GET /api/user` - Get current user info (authenticated)

### Health Check

- `GET /api/health` - Server health status

### Socket.IO Events

**Client → Server:**
- `joinRoom` - Join a room
- `getRtpCapabilities` - Get router capabilities
- `createTransport` - Create WebRTC transport
- `connectTransport` - Connect transport
- `produce` - Create audio producer
- `consume` - Create audio consumer
- `getProducers` - List producers in room
- `kick` - Kick user (admin only)
- `setServerFeed` - Toggle house feed (per-user)
- `setAdminToServer` - Toggle admin-to-server streaming (admin only)

**Server → Client:**
- `peers` - List of peers in room
- `peer-joined` - New peer joined
- `peer-left` - Peer left
- `new-producer` - New audio producer available
- `producer-closed` - Producer closed
- `server-feed-state` - House feed status update
- `admin-to-server-state` - Admin-to-server streaming status update

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HTTPS` | false | Enable HTTPS |
| `SSL_KEY_PATH` | certs/ssl_key.pem | TLS private key path |
| `SSL_CERT_PATH` | certs/ssl_cert.pem | TLS certificate path |
| `SSL_CA_PATH` | (empty) | Optional certificate chain |
| `ANNOUNCED_IP` | 127.0.0.1 | Public IP for clients |
| `MAX_INCOMING_BITRATE` | 800000 | Max incoming bitrate (bps) |
| `INITIAL_AVAILABLE_BITRATE` | 1000000 | Initial outgoing bitrate (bps) |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_NAME` | church_intercom | Database name |
| `DB_USER` | postgres | Database user |
| `DB_PASSWORD` | (empty) | Database password |
| `DB_POOL_MAX` | 20 | Max database connections |
| `DB_IDLE_TIMEOUT` | 30000 | Connection idle timeout (ms) |
| `DB_CONNECTION_TIMEOUT` | 5000 | Connection timeout (ms) |
| `SESSION_SECRET` | (required) | Session encryption secret |
| `SERVER_AUDIO_COMMAND` | (empty) | Command to capture venue audio |
| `SERVER_AUDIO_NAME` | House Feed | Display name for server audio |
| `SERVER_AUDIO_PAYLOAD_TYPE` | 100 | RTP payload type for server audio |
| `ADMIN_TO_SERVER_COMMAND` | (empty) | Command to play admin audio to server speakers |

## Development

### Database Migrations

When making database schema changes, create a new migration file and apply manually:

```bash
psql -U postgres -d church_intercom -f your_migration.sql
```

### Testing

Currently, there are no automated tests. Consider adding:
- Unit tests for authentication functions
- Integration tests for Socket.IO events
- End-to-end tests for the full user flow

## HTTPS Setup

Browsers require HTTPS (or localhost) for microphone access. To serve this app over HTTPS:

1. Generate a certificate (for development):
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt -days 365
```

2. Update `.env`:
```bash
HTTPS=true
SSL_KEY_PATH=/absolute/path/to/server.key
SSL_CERT_PATH=/absolute/path/to/server.crt
```

For local development, you can use the sample certificates in `certs/ssl_key.pem` and `certs/ssl_cert.pem`.

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]

## Support

For issues and questions, please use the GitHub issue tracker or contact [your-contact-info].
