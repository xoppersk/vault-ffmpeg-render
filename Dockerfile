FROM node:20-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json .
RUN npm install --production

# Copy server code
COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
