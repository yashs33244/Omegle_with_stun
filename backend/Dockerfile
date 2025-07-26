# Use the official Bun image
FROM oven/bun:1-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy TypeScript configuration
COPY tsconfig.json ./

# Copy source code
COPY src/ ./src/

# Build the TypeScript project
RUN bun run build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S bunuser -u 1001

# Change ownership of the app directory
RUN chown -R bunuser:nodejs /app
USER bunuser

# Expose the port (configurable via environment variable)
EXPOSE 3004

# Health check
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#   CMD curl -f http://localhost:3004/health || exit 1

# Start the application
CMD ["bun", "run", "start"] 