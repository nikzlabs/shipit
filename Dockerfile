FROM node:20-slim

# Install git (needed for workspace git operations)
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Set up app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build the frontend
RUN npm run build:client

# Create workspace directory
RUN mkdir -p /workspace && cd /workspace && git init

# Expose ports: 3000 = app UI, 5173 = Vite preview
EXPOSE 3000 5173

CMD ["npm", "run", "dev"]
