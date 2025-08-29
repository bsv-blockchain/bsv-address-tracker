FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S bsv-tracker -u 1001

# Change ownership
RUN chown -R bsv-tracker:nodejs /app
USER bsv-tracker

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('./src/index.js')" || exit 1

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "src/index.js"]