FROM node:20-alpine
WORKDIR /app
COPY package.json proxy.js ./
USER node
ENV PORT=9000
EXPOSE 9000
CMD ["node", "proxy.js"]
