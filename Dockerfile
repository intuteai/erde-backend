# Use a small Node.js image
FROM node:20-alpine AS deps
WORKDIR /app

# Toolchain for native deps (bcrypt, etc.) that may need to compile from
# source on alpine/musl if no prebuilt binary matches this platform.
RUN apk add --no-cache python3 make g++

# Install only production deps
COPY package*.json ./
# If you have a "prepare" or dev-only scripts, prefer npm ci --omit=dev
RUN npm ci --omit=dev

# Copy the rest of the app
FROM node:20-alpine AS runner
WORKDIR /app

# Create a non-root user for security
RUN addgroup -S nodegrp && adduser -S nodeusr -G nodegrp

# Copy node_modules from deps stage and app files
COPY --from=deps /app/node_modules /app/node_modules
COPY . .

# Environment
ENV NODE_ENV=production
# server.js listens on process.env.SERVER_PORT || 5000 — EXPOSE here must
# match that real default, not an unrelated placeholder.
EXPOSE 5000

# Drop privileges
USER nodeusr

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

# If your package.json has "start": "node server.js"
# this will work; otherwise change to the right command.
CMD ["npm", "start"]