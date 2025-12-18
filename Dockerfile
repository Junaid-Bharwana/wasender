# Use a Node image that includes Chrome dependencies
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install any extra tools if needed (not needed here but good practice)
USER root

# Set working directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install

# Copy the rest of your backend code
COPY . .

# Set environment variables
ENV PORT=8000
ENV NODE_ENV=production

# Expose the port
EXPOSE 8000

# Start the server
CMD ["node", "server.js"]
