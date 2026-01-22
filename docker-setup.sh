#!/bin/bash

# Church Intercom Docker Setup Script
# This script helps set up and deploy Church Intercom using Docker

set -e

echo "==================================="
echo "Church Intercom Docker Setup"
echo "==================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed. Please install Docker first."
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "Error: Docker Compose is not installed. Please install Docker Compose first."
    echo "Visit: https://docs.docker.com/compose/install/"
    exit 1
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo "Creating .env file from template..."
    cp .env.docker .env

    echo ""
    echo "✓ Created .env file"
    echo ""
    echo "IMPORTANT: You need to configure the following in .env:"
    echo ""

    # Generate a session secret
    if command -v node &> /dev/null; then
        SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        echo "1. SESSION_SECRET (suggested value below):"
        echo "   SESSION_SECRET=$SESSION_SECRET"
        echo ""

        # Update the .env file with generated secret
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/SESSION_SECRET=.*/SESSION_SECRET=$SESSION_SECRET/" .env
        else
            sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$SESSION_SECRET/" .env
        fi
        echo "   ✓ Automatically set in .env"
        echo ""
    else
        echo "1. SESSION_SECRET - Generate a random string"
        echo ""
    fi

    echo "2. DB_PASSWORD - Choose a strong database password"
    echo "   Current: postgres (CHANGE THIS!)"
    echo ""

    echo "3. ANNOUNCED_IP - Set your server's public IP address"
    echo "   Current: 127.0.0.1 (OK for local testing)"
    echo ""

    read -p "Press Enter to edit .env now, or Ctrl+C to exit and edit manually: "
    ${EDITOR:-nano} .env
fi

echo ""
echo "==================================="
echo "Starting Church Intercom..."
echo "==================================="
echo ""

# Build and start containers
docker-compose up -d --build

echo ""
echo "==================================="
echo "Setup Complete!"
echo "==================================="
echo ""
echo "Services started:"
docker-compose ps
echo ""
echo "Access the application at:"
echo "  → http://localhost:3000"
echo ""
echo "Default admin credentials:"
echo "  Username: admin"
echo "  Password: admin123"
echo ""
echo "⚠️  IMPORTANT: Change the admin password after first login!"
echo ""
echo "Useful commands:"
echo "  View logs:        docker-compose logs -f"
echo "  Stop services:    docker-compose stop"
echo "  Restart services: docker-compose restart"
echo "  Remove all:       docker-compose down -v"
echo ""
echo "For more information, see DOCKER.md"
echo ""
