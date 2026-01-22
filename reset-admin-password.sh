#!/bin/bash

# Reset Admin Password Script for Docker
# This script resets the admin password in the Docker container

set -e

echo "============================================"
echo "Church Intercom - Reset Admin Password"
echo "============================================"
echo ""

# Check if Docker Compose is running
if ! docker-compose ps | grep -q "church-intercom-app.*Up"; then
    echo "Error: Docker containers are not running."
    echo "Please start them with: docker-compose up -d"
    exit 1
fi

# Prompt for new password
echo "Enter new admin password:"
read -s NEW_PASSWORD

if [ -z "$NEW_PASSWORD" ]; then
    echo "Error: Password cannot be empty"
    exit 1
fi

echo ""
echo "Confirm password:"
read -s CONFIRM_PASSWORD

if [ "$NEW_PASSWORD" != "$CONFIRM_PASSWORD" ]; then
    echo ""
    echo "Error: Passwords do not match"
    exit 1
fi

echo ""
echo "Generating password hash..."

# Generate bcrypt hash
HASH=$(docker-compose exec -T app node -e "
const bcrypt = require('bcrypt');
bcrypt.hash('$NEW_PASSWORD', 10).then(hash => {
    console.log(hash);
    process.exit(0);
}).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
")

# Remove any trailing whitespace/newlines
HASH=$(echo "$HASH" | tr -d '\n\r')

if [ -z "$HASH" ]; then
    echo "Error: Failed to generate password hash"
    exit 1
fi

echo "Updating admin password in database..."

# Update password in database
docker-compose exec -T postgres psql -U postgres -d church_intercom -c \
    "UPDATE users SET password_hash = '$HASH' WHERE username = 'admin';" > /dev/null

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Admin password updated successfully!"
    echo ""
    echo "You can now login with:"
    echo "  Username: admin"
    echo "  Password: (your new password)"
    echo ""
else
    echo "Error: Failed to update password in database"
    exit 1
fi
