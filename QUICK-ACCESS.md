# Quick Access Guide

## 🔒 HTTPS Enabled - Ready for Mobile Access!

### Access from Your Computer
```
https://localhost:3443
```

### Access from Your Phone (Same WiFi)
```
https://192.168.18.152:3443
```

### Login
- Username: `admin`
- Password: `admin123`

---

## Accept Security Warning

You'll see a security warning because we're using a self-signed certificate. This is **normal and safe** for local network use.

**Just click:**
- iPhone: "Show Details" → "visit this website"
- Android: "Advanced" → "Proceed to 192.168.18.152 (unsafe)"

---

## Grant Microphone Permission

When the browser asks for microphone access, tap **Allow**.

---

## Troubleshooting

**Can't connect from phone?**
1. Make sure phone is on same WiFi
2. Try: `docker-compose restart app`
3. Check firewall on your computer

**Need to change admin password?**
```bash
./reset-admin-password.sh
```

**View logs:**
```bash
docker-compose logs -f app
```

---

## Full Documentation

- [HTTPS-PHONE-ACCESS.md](HTTPS-PHONE-ACCESS.md) - Detailed phone setup
- [DOCKER-FIXES.md](DOCKER-FIXES.md) - Docker troubleshooting
- [README.md](README.md) - Application features

---

## Your Network Info

- **Local IP:** 192.168.18.152
- **HTTPS Port:** 3443
- **Certificate:** Self-signed (valid 365 days)
- **Status:** ✅ Running

Enjoy secure audio communication! 🎤✨
