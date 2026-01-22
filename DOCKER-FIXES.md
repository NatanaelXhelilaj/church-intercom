# Docker Setup - Important Notes

## Issues Fixed

### 1. Admin Password Hash
**Issue:** Default admin password hash in database.sql was a placeholder, causing login to fail.

**Fix:** Generated proper bcrypt hash for "admin123" password and updated database.sql.

**Reset Password:** Use the provided script if needed:
```bash
./reset-admin-password.sh
```

### 2. Package Installation
**Issue:** `npm ci` was failing due to missing packages in lock file.

**Fix:** Changed from `npm ci --only=production` to `npm install --production` in Dockerfile for better compatibility.

### 2. ES Modules Support
**Issue:** Server was crashing with "Cannot use import statement outside a module"

**Fix:** Added `"type": "module"` to `package.json`

### 3. Port Conflicts
**Issue:** PostgreSQL port 5432 conflicts with local PostgreSQL installation.

**Fix:** Changed Docker Compose to expose PostgreSQL on port 5433 externally:
```yaml
ports:
  - "5433:5432"  # External:Internal
```

The application container still connects to `postgres:5432` internally via Docker networking.

### 4. Build Tools for Native Modules
**Issue:** Native modules like `bcrypt` need compilation tools.

**Fix:** Added build dependencies to Dockerfile:
```dockerfile
RUN apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++
```

## Current Port Mapping

- **Application**: http://localhost:3000
- **PostgreSQL**: localhost:5433 (if you need to connect from host)
- **PostgreSQL (internal)**: postgres:5432 (used by app container)

## Verified Working

✅ Docker build completes successfully
✅ Containers start without errors
✅ Database initializes with schema
✅ Application connects to database
✅ API health check responds: `{"status":"ok"}`
✅ Authentication system ready
✅ WebRTC/mediasoup ready

## Quick Commands

```bash
# Check status
docker-compose ps

# View logs
docker-compose logs -f

# Restart after code changes
docker-compose restart app

# Rebuild after package.json changes
docker-compose up -d --build

# Stop everything
docker-compose down

# Stop and remove data
docker-compose down -v
```

## Access the Application

1. Open browser to http://localhost:3000
2. You'll be redirected to `/auth.html`
3. Login with default credentials:
   - Username: `admin`
   - Password: `admin123`
4. **Change the password immediately!**

## Database Access

To connect to PostgreSQL from your host machine:

```bash
# Using psql
psql -h localhost -p 5433 -U postgres -d church_intercom

# Connection string
postgresql://postgres:postgres@localhost:5433/church_intercom
```

## Troubleshooting

### Application won't start
```bash
# Check logs
docker-compose logs app

# Common issues:
# - Check SESSION_SECRET is set in .env
# - Check DB_PASSWORD matches in .env
# - Verify database is healthy: docker-compose ps
```

### Database connection errors
```bash
# Check database is running
docker-compose exec postgres pg_isready -U postgres

# Restart database
docker-compose restart postgres

# View database logs
docker-compose logs postgres
```

### Port already in use
If port 3000 or 5433 is in use:

1. Edit `docker-compose.yml`
2. Change the **first** number in the port mapping:
```yaml
ports:
  - "3001:3000"  # Change 3000 to 3001
```

## Production Checklist

Before deploying to production:

- [ ] Set strong `SESSION_SECRET` in `.env`
- [ ] Set strong `DB_PASSWORD` in `.env`
- [ ] Change default admin password
- [ ] Set `ANNOUNCED_IP` to your server's public IP
- [ ] Consider enabling HTTPS
- [ ] Review firewall rules
- [ ] Set up automated backups
- [ ] Configure audio streaming if needed

## Next Steps

1. Test the application at http://localhost:3000
2. Change admin password
3. Configure audio streaming features (optional)
4. Set up production environment variables
5. Deploy to production server

For more details, see:
- [DOCKER.md](DOCKER.md) - Full Docker documentation
- [DOCKER-QUICKSTART.md](DOCKER-QUICKSTART.md) - Quick start guide
- [README.md](README.md) - Application documentation
