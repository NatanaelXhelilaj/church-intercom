# Use Node.js LTS version
FROM node:18-slim

# Install system dependencies including build tools for native modules
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# Note: Using npm install instead of npm ci for better compatibility
RUN npm install --production

# Copy application files
COPY . .

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
