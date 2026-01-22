# Quick Setup Guide

Follow these steps to get Church Intercom up and running.

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Set Up PostgreSQL

### Install PostgreSQL (if not already installed)

**macOS (Homebrew):**
```bash
brew install postgresql@15
brew services start postgresql@15
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

**Windows:**
Download and install from https://www.postgresql.org/download/windows/

### Create Database

```bash
# Connect to PostgreSQL
psql -U postgres

# In psql prompt:
CREATE DATABASE church_intercom;
\q
```

### Run Schema

```bash
psql -U postgres -d church_intercom -f database.sql
```

## Step 3: Configure Environment

```bash
# Copy default config
cp .env.default .env

# Generate a strong session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env` and update:

```bash
# Set your database password
DB_PASSWORD=your_postgres_password

# Set the session secret (use the one generated above)
SESSION_SECRET=your_generated_secret_here
```

## Step 4: Start the Server

```bash
npm start
```

## Step 5: Access the Application

1. Open your browser to `http://localhost:3000`
2. You'll be redirected to `/auth.html`
3. Login with default admin credentials:
   - **Username:** admin
   - **Password:** admin123

**⚠️ IMPORTANT:** Change the admin password immediately!

```bash
# Generate new password hash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your-new-password', 10).then(hash => console.log(hash));"

# Update in database (replace <hash> with output above)
psql -U postgres -d church_intercom -c "UPDATE users SET password_hash='<hash>' WHERE username='admin';"
```

## Common Issues

### "Database connection failed"
- Make sure PostgreSQL is running: `brew services list` (macOS) or `sudo systemctl status postgresql` (Linux)
- Check your DB_PASSWORD in `.env`

### "connect-pg-simple" module not found
- Run `npm install` again

### "Cannot find module 'bcrypt'"
- You may need to rebuild bcrypt: `npm rebuild bcrypt`

## Next Steps

- Create additional user accounts at `/auth.html`
- Configure HTTPS for production (see README.md)
- Set up house feed audio streaming (optional)

For more details, see [README.md](README.md).
