FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY bun.lockb ./

# Install dependencies
RUN npm ci

# Copy project files
COPY . .

# Build the app
RUN npm run build

# Expose port
EXPOSE 5173

# Start the app using vite preview
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]

# Health check
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#   CMD curl -f http://localhost:80 || exit 1