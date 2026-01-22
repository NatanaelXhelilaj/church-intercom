# Docker Quick Start Guide

Get Church Intercom running in under 5 minutes with Docker!

## Step 1: Install Docker

If you don't have Docker installed:

- **macOS/Windows:** [Docker Desktop](https://www.docker.com/products/docker-desktop)
- **Linux:**
  ```bash
  curl -fsSL https://get.docker.com -o get-docker.sh
  sudo sh get-docker.sh
  ```

Verify installation:
```bash
docker --version
docker-compose --version
```

## Step 2: Quick Setup Script (Easiest)

Run the automated setup script:

```bash
./docker-setup.sh
```

This will:
1. Create and configure your `.env` file
2. Generate a secure session secret
3. Build and start all services
4. Display access information

**That's it!** Go to http://localhost:3000

---

## Step 3: Manual Setup (Alternative)

If you prefer manual setup:

### 3.1 Configure Environment

```bash
# Copy template
cp .env.docker .env

# Generate session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Edit .env and paste the session secret
nano .env
```

Set these values in `.env`:
```bash
SESSION_SECRET=<paste-generated-secret>
DB_PASSWORD=your_strong_password
ANNOUNCED_IP=127.0.0.1  # or your server IP
```

### 3.2 Start Services

```bash
docker-compose up -d
```

### 3.3 Access Application

Open http://localhost:3000

Default login:
- Username: `admin`
- Password: `admin123`

⚠️ **Change the password immediately!**

**Reset admin password:**
```bash
./reset-admin-password.sh
```

---

## Common Commands

```bash
# View logs
docker-compose logs -f app

# Stop services
docker-compose stop

# Start services
docker-compose start

# Restart services
docker-compose restart

# Stop and remove (data persists)
docker-compose down

# Stop and remove everything including data
docker-compose down -v

# Rebuild after code changes
docker-compose build
docker-compose up -d
```

---

## Troubleshooting

### Port already in use?

Change port in `.env`:
```bash
PORT=3001
```

Or in `docker-compose.yml`:
```yaml
ports:
  - "3001:3000"
```

### Can't connect to database?

```bash
# Check if PostgreSQL is ready
docker-compose exec postgres pg_isready -U postgres

# View database logs
docker-compose logs postgres
```

### View all logs

```bash
docker-compose logs -f
```

---

## Next Steps

- [ ] Change admin password at http://localhost:3000/auth.html
- [ ] Configure `ANNOUNCED_IP` for network access (if needed)
- [ ] Enable HTTPS for production (see [DOCKER.md](DOCKER.md))
- [ ] Set up audio streaming features (optional)

## Full Documentation

For complete Docker documentation, see [DOCKER.md](DOCKER.md)

For application features and usage, see [README.md](README.md)
