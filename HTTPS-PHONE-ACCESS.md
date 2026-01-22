# Access Church Intercom on Your Phone with HTTPS

## ✅ HTTPS is Now Enabled!

Your Church Intercom is now running with HTTPS, allowing microphone access from mobile browsers.

## Access URLs

**On your computer:**
- https://localhost:3443 (accept the security warning)

**On your phone (same WiFi network):**
- https://192.168.18.152:3443 (accept the security warning)

**Login credentials:**
- Username: `admin`
- Password: `admin123`

## Step-by-Step: Access from Phone

### 1. Make Sure Your Phone is on the Same WiFi Network

Your phone must be connected to the same WiFi network as your computer.

### 2. Open Browser on Phone

Use one of these browsers:
- **Safari** (iPhone/iPad) - Recommended
- **Chrome** (Android)
- **Firefox** (Android)

### 3. Navigate to the URL

Type in the address bar:
```
https://192.168.18.152:3443
```

### 4. Accept the Security Warning

Since this is a self-signed certificate, you'll see a security warning.

**On iPhone/Safari:**
1. Tap "Show Details"
2. Tap "visit this website"
3. Confirm by tapping "Visit Website"

**On Android/Chrome:**
1. Tap "Advanced"
2. Tap "Proceed to 192.168.18.152 (unsafe)"

**On Android/Firefox:**
1. Tap "Advanced"
2. Tap "Accept the Risk and Continue"

### 5. Login

Use the admin credentials:
- Username: `admin`
- Password: `admin123`

### 6. Allow Microphone Access

When prompted, tap "Allow" to grant microphone access to the browser.

### 7. Join a Room and Talk!

Select a room and start communicating!

---

## Important Notes

### Security Warning is Normal

The security warning appears because we're using a self-signed certificate (not from a trusted Certificate Authority). This is perfectly safe for local network use.

### If Your IP Changes

If your computer's IP address changes (e.g., after reconnecting to WiFi), you'll need to:

1. Find your new IP:
   ```bash
   ifconfig | grep "inet " | grep -v 127.0.0.1
   ```

2. Update `.env`:
   ```bash
   ANNOUNCED_IP=your_new_ip
   ```

3. Restart:
   ```bash
   docker-compose restart app
   ```

### Firewall Issues

If you can't connect from your phone:

**On macOS:**
```bash
# Allow incoming connections on port 3443
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/bin/docker
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblock /usr/bin/docker
```

Or disable the firewall temporarily:
- System Preferences → Security & Privacy → Firewall → Turn Off Firewall

**On Linux:**
```bash
sudo ufw allow 3443/tcp
```

### Port Forwarding

If you want to access from outside your local network (e.g., over the internet), you'll need to:

1. Set up port forwarding on your router (forward port 3443 to your computer)
2. Use your public IP address
3. Consider using a dynamic DNS service
4. For production, get a real SSL certificate (Let's Encrypt)

---

## Troubleshooting

### "This site can't be reached"

1. Verify you're on the same WiFi network
2. Check your computer's IP hasn't changed
3. Make sure the Docker containers are running:
   ```bash
   docker-compose ps
   ```
4. Check firewall settings

### "ERR_SSL_PROTOCOL_ERROR"

This usually means HTTPS isn't enabled. Verify:
```bash
docker-compose logs app | grep -i https
```

Should see: `HTTPS server enabled`

### Microphone Not Working

1. Make sure you're using HTTPS (not HTTP)
2. Grant microphone permission when browser asks
3. Try reloading the page
4. Check browser permissions: Settings → Site Settings → Microphone

### "Invalid credentials" on login

The database may not have persisted. Reset with:
```bash
./reset-admin-password.sh
```

---

## Production Deployment

For production use with a real domain:

### 1. Get a Domain Name

Register a domain (e.g., `intercom.yourchurch.org`)

### 2. Get a Real SSL Certificate

**Option A: Let's Encrypt (Recommended)**

```bash
# Install certbot
sudo apt-get install certbot

# Get certificate
sudo certbot certonly --standalone -d intercom.yourchurch.org

# Copy to certs directory
sudo cp /etc/letsencrypt/live/intercom.yourchurch.org/fullchain.pem certs/ssl_cert.pem
sudo cp /etc/letsencrypt/live/intercom.yourchurch.org/privkey.pem certs/ssl_key.pem
```

**Option B: Purchase from CA**

Buy an SSL certificate from a Certificate Authority and place files in `certs/` directory.

### 3. Update .env

```bash
ANNOUNCED_IP=intercom.yourchurch.org
PORT=443  # Standard HTTPS port
```

### 4. Update docker-compose.yml

Change port mapping:
```yaml
ports:
  - "443:443"  # Standard HTTPS port
```

### 5. Restart

```bash
docker-compose down
docker-compose up -d
```

Now access at: `https://intercom.yourchurch.org`

---

## Current Configuration

```
Protocol: HTTPS (TLS 1.2+)
Port: 3443
Certificate: Self-signed (valid for 365 days)
Local Access: https://localhost:3443
Network Access: https://192.168.18.152:3443
Certificate Location: certs/ssl_key.pem, certs/ssl_cert.pem
```

## Certificate Renewal

Self-signed certificate expires in 365 days. To renew:

```bash
# Generate new certificate
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/ssl_key.pem \
  -out certs/ssl_cert.pem \
  -days 365 \
  -subj "/C=US/ST=State/L=City/O=Church Intercom/CN=localhost"

# Restart application
docker-compose restart app
```

---

## Support

For issues:
1. Check logs: `docker-compose logs -f app`
2. Verify status: `docker-compose ps`
3. Test locally first: `https://localhost:3443`
4. Then test from phone

Enjoy secure audio communication! 🎤🔒
