FROM docker.io/node:lts as builder

WORKDIR /app
COPY . .
RUN npm i && npx nx build web

FROM docker.io/node:lts-alpine

ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

RUN addgroup --system web && \
          adduser --system -G web web

COPY --from=builder /app/dist/web ./web
RUN chown -R web:web .

RUN npm --prefix web --omit=dev -f install

CMD [ "node", "web" ]
