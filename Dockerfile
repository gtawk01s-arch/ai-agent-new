FROM node:22-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application sources
COPY . .

# Create cache directory
RUN mkdir -p audio_cache && chown -R node:node /app

USER node

EXPOSE 3000

ENV PORT=3000 \
    NODE_ENV=production \
    HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
