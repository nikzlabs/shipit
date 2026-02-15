FROM node:20-slim

# Install git (needed for workspace git operations)
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Set up app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY . .

# Build the frontend
RUN npm run build:client

# Create workspace directory
RUN mkdir -p /workspace && cd /workspace && git init

# Expose ports: 3000 = app UI
EXPOSE 3000

CMD ["npm", "run", "dev"]
