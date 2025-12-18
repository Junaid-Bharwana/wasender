# Use a slim Node.js image (10x smaller than the Puppeteer one)
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install --production

# Copy the rest of your backend code
COPY . .

# Set environment variables
ENV PORT=8000
ENV NODE_ENV=production

# Expose the port
EXPOSE 8000

# Start the server
CMD ["node", "server.js"]
