# Use a small Node.js image
FROM node:20-alpine AS deps
WORKDIR /app

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
# Respect PORT if provided by env; default to 3000 at runtime
EXPOSE 3000

# Drop privileges
USER nodeusr

# If your package.json has "start": "node server.js"
# this will work; otherwise change to the right command.
CMD ["npm", "start"]