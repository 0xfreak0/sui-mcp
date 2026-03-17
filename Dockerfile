FROM node:20-slim

WORKDIR /app

# Install dependencies first
COPY package.json package-lock.json ./
RUN npm ci --silent

# Copy the rest
COPY . .

# Build the project
RUN npm run build

CMD ["node", "dist/index.js"]
