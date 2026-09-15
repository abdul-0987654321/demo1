FROM node:18-alpine

# Install build dependencies for native C++ npm packages
RUN apk add --no-cache python3 make g++ graphicsmagick

WORKDIR /app

COPY package*.json ./

# Clean npm cache and install packages
RUN npm ci || npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "bot.js"]
