FROM node:22-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with clean cache
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Create non-root user and group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S bsv-tracker -u 1001 -G nodejs

# Change ownership
RUN chown -R bsv-tracker:nodejs /app
USER bsv-tracker

# Health check using API endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "src/index.js"]