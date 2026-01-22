# Docker Deployment Guide

This guide explains how to run Church Intercom using Docker and Docker Compose.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (version 20.10 or higher)
- [Docker Compose](https://docs.docker.com/compose/install/) (version 2.0 or higher)

## Quick Start

### 1. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.docker .env
```

Edit `.env` and update the following **critical** settings:

```bash
# Generate a strong session secret
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Set a strong database password
DB_PASSWORD=your_strong_password_here

# Set your server's public IP (important for WebRTC)
ANNOUNCED_IP=your.server.ip.address
```

### 2. Start the Application

```bash
docker-compose up -d
```

This will:
- Pull the PostgreSQL image
- Build the application image
- Create and initialize the database
- Start both services

### 3. Check Status

```bash
# View running containers
docker-compose ps

# View logs
docker-compose logs -f app
```

### 4. Access the Application

Open your browser to:
- **Local:** http://localhost:3000
- **Network:** http://your-server-ip:3000

### 5. Login

Default admin credentials:
- **Username:** admin
- **Password:** admin123

**⚠️ IMPORTANT:** Change the admin password immediately after first login!

## Stopping the Application

```bash
# Stop containers but keep data
docker-compose stop

# Stop and remove containers (data persists in volumes)
docker-compose down

# Stop, remove containers, AND delete all data
docker-compose down -v
```

## Configuration

### Environment Variables

All configuration is done through the `.env` file. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Application port | 3000 |
| `ANNOUNCED_IP` | Public IP for WebRTC | 127.0.0.1 |
| `DB_PASSWORD` | PostgreSQL password | postgres |
| `SESSION_SECRET` | Session encryption key | (required) |
| `HTTPS` | Enable HTTPS | false |

### Audio Streaming Features

#### House Feed (Server to Users)

To enable server audio streaming to users, add to `.env`:

```bash
# For Linux with ALSA
SERVER_AUDIO_COMMAND=ffmpeg -hide_banner -loglevel error -f alsa -i default -ac 2 -ar 48000 -acodec libopus -b:a 128k -payload_type {payloadType} -ssrc {ssrc} -f rtp rtp://{ip}:{port}

# Custom display name
SERVER_AUDIO_NAME=Main Sanctuary Audio
```

#### Admin-to-Server Streaming

To enable admin audio streaming to server speakers, add to `.env`:

```bash
# For Linux with ALSA
ADMIN_TO_SERVER_COMMAND=ffmpeg -hide_banner -loglevel error -protocol_whitelist file,rtp,udp -i rtp://0.0.0.0:{port}?localrtcpport={port} -f alsa default
```

Restart after changes:
```bash
docker-compose restart app
```

## Production Deployment

### 1. Security Checklist

- [ ] Change `SESSION_SECRET` to a strong random value
- [ ] Change `DB_PASSWORD` to a strong password
- [ ] Change admin password after first login
- [ ] Set `ANNOUNCED_IP` to your server's public IP
- [ ] Consider enabling HTTPS
- [ ] Restrict database port (5432) in firewall
- [ ] Keep Docker images updated

### 2. HTTPS Setup (Recommended)

Generate SSL certificates:

```bash
# Self-signed (for testing)
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/ssl_key.pem \
  -out certs/ssl_cert.pem \
  -days 365

# For production, use Let's Encrypt
```

Update `.env`:

```bash
HTTPS=true
```

The certificates are automatically mounted from `./certs` directory.

### 3. Firewall Configuration

Open required ports:

```bash
# Application port
sudo ufw allow 3000/tcp

# PostgreSQL (only if accessing externally)
sudo ufw allow 5432/tcp

# WebRTC UDP ports (if needed)
sudo ufw allow 10000:20000/udp
```

## Database Management

### Backup Database

```bash
# Create backup
docker-compose exec postgres pg_dump -U postgres church_intercom > backup.sql

# Or using docker directly
docker exec church-intercom-db pg_dump -U postgres church_intercom > backup.sql
```

### Restore Database

```bash
# Restore from backup
docker-compose exec -T postgres psql -U postgres church_intercom < backup.sql
```

### Access Database Shell

```bash
docker-compose exec postgres psql -U postgres -d church_intercom
```

### Reset Database

```bash
# Stop app
docker-compose stop app

# Drop and recreate database
docker-compose exec postgres psql -U postgres -c "DROP DATABASE church_intercom;"
docker-compose exec postgres psql -U postgres -c "CREATE DATABASE church_intercom;"

# Re-run schema
docker-compose exec -T postgres psql -U postgres church_intercom < database.sql

# Restart app
docker-compose start app
```

## Troubleshooting

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f app
docker-compose logs -f postgres
```

### Container Not Starting

```bash
# Check status
docker-compose ps

# Check logs
docker-compose logs app

# Rebuild
docker-compose build --no-cache
docker-compose up -d
```

### Database Connection Issues

```bash
# Check if PostgreSQL is ready
docker-compose exec postgres pg_isready -U postgres

# Verify database exists
docker-compose exec postgres psql -U postgres -l

# Check connection from app
docker-compose exec app npm run test-db
```

### Port Already in Use

If port 3000 or 5432 is already in use:

```bash
# Change ports in .env
PORT=3001

# Or in docker-compose.yml
ports:
  - "3001:3000"  # Change external port
```

### FFmpeg Audio Issues

```bash
# Check FFmpeg in container
docker-compose exec app ffmpeg -version

# List audio devices
docker-compose exec app ffmpeg -devices

# Test ALSA
docker-compose exec app aplay -l
```

## Updating the Application

### Pull Latest Changes

```bash
# Stop app
docker-compose down

# Pull updates (if using git)
git pull

# Rebuild and restart
docker-compose build
docker-compose up -d
```

### Update Docker Images

```bash
# Update PostgreSQL
docker-compose pull postgres

# Rebuild app
docker-compose build --no-cache app

# Restart
docker-compose up -d
```

## Development with Docker

### Live Development

For development with live reload, mount source code:

```yaml
# Add to docker-compose.yml under app service
volumes:
  - ./:/app
  - /app/node_modules
```

Then use nodemon:

```bash
docker-compose exec app npx nodemon server.js
```

### Running Commands

```bash
# Execute commands in container
docker-compose exec app npm install new-package
docker-compose exec app node script.js
```

## Performance Tuning

### PostgreSQL Optimization

Add to `docker-compose.yml` under postgres service:

```yaml
environment:
  POSTGRES_SHARED_BUFFERS: 256MB
  POSTGRES_EFFECTIVE_CACHE_SIZE: 1GB
  POSTGRES_MAX_CONNECTIONS: 100
```

### Resource Limits

Add to services in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '1.0'
      memory: 1G
    reservations:
      cpus: '0.5'
      memory: 512M
```

## Monitoring

### Health Checks

```bash
# Check app health
curl http://localhost:3000/api/health

# Check database health
docker-compose exec postgres pg_isready
```

### Container Stats

```bash
docker stats church-intercom-app church-intercom-db
```

## Advanced Configuration

### Custom Network

To use a custom Docker network:

```yaml
networks:
  default:
    external:
      name: my-custom-network
```

### External Database

To use an external PostgreSQL server, remove the postgres service and update app environment:

```yaml
environment:
  DB_HOST: external-postgres.example.com
  DB_PORT: 5432
  DB_NAME: church_intercom
  DB_USER: myuser
  DB_PASSWORD: mypassword
```

## Support

For issues and questions:
- Check logs: `docker-compose logs -f`
- Review [README.md](README.md) for application details
- Check [SETUP.md](SETUP.md) for non-Docker setup
