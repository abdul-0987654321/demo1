FROM node:20-alpine

# Install build dependencies for native C++ npm packages
RUN apk add --no-cache python3 make g++ graphicsmagick

WORKDIR /app

COPY package*.json ./

# Install dependencies using standard install
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "bot.js"]
