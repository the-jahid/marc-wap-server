# Marc WhatsApp AI Server

NestJS server for a WhatsApp Cloud API chatbot. Incoming WhatsApp messages are received through a Meta webhook, answered with LangChain + OpenAI, and sent back through the WhatsApp Messages API.

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env` with your real credentials.

## Environment Variables

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-luna
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=
WHATSAPP_API_KEY=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_GRAPH_API_VERSION=v23.0
CHATBOT_SYSTEM_PROMPT=
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marc?schema=public
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
PINECONE_INDEX_HOST=
PINECONE_NAMESPACE=knowledgebase
KNOWLEDGEBASE_CHUNK_CHARS=1400
KNOWLEDGEBASE_CHUNK_OVERLAP_CHARS=180
```

`WHATSAPP_API_KEY` is the Meta Graph API access token. `WHATSAPP_VERIFY_TOKEN` is any private string you choose and then enter in Meta's webhook setup. Voice messages are downloaded from WhatsApp, converted to a supported audio format when needed, transcribed with `OPENAI_TRANSCRIPTION_MODEL`, and answered through the same agent flow as text messages.

Knowledgebase uploads are extracted to text, chunked, embedded with `OPENAI_EMBEDDING_MODEL`, and upserted to Pinecone. Set `PINECONE_INDEX_NAME` or `PINECONE_INDEX_HOST`; the Pinecone index dimension must match the embedding model/dimensions you configure. If Pinecone is not configured, entries still save in PostgreSQL and the agent falls back to stored text context.

## Run

```bash
npm run start:dev
```

Production:

```bash
npm run build
npm run start:prod
```

## Database

PostgreSQL is used for conversation memory. On startup, the server creates the lightweight `ConversationMessage` table and index if they do not already exist.

Conversation memory is keyed by the WhatsApp sender phone number. The chatbot loads the latest 15 user/assistant turns for each sender before generating a reply.

For external Render PostgreSQL connections, include SSL in the URL:

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

## WhatsApp Webhook

Use this callback URL in Meta after deploying the server:

```text
https://your-domain.com/webhooks/whatsapp
```

Subscribe the WhatsApp webhook to `messages`.

## Abandoned Checkout Recovery

The server can win back abandoned Shopify checkouts over WhatsApp. It polls
Shopify on an interval and, for each checkout that has been abandoned long
enough, sends the customer a plain WhatsApp text message — written and edited by
the operator in the dashboard (Cart Recovery tab) — with the cart recovery link
filled in. When the customer replies, the normal inbound agent flow takes over:
it answers questions about size, model, shipping, exchanges or payment, resends
the link if they want to buy, and flags the conversation for a human advisor
when it cannot resolve the request.

How a checkout is chosen each cycle:

1. Shopify lists checkouts that were started but not completed.
2. Only checkouts older than the configured delay (default 60 min) are
   considered — this is the "wait 60 minutes" step, made restart-safe by polling
   instead of per-cart timers.
3. Checkouts that were since completed (`completedAt` is set) are skipped.
4. Checkouts without a valid, dialable phone number are skipped.
5. Each checkout is claimed atomically in the `AbandonedCheckoutReminder` table,
   so a customer is never messaged twice about the same cart — even across
   restarts or multiple instances.
6. The operator's message is rendered with `{{name}}` (customer first name) and
   `{{link}}` (recovery URL) and sent as a WhatsApp text.

The reminder message, the wait time, and the on/off switch are stored in the
`AbandonedCheckoutConfig` table and edited from the dashboard, so no message
template lives in the environment. The poller runs whenever Shopify Admin API
credentials (`SHOPIFY_STORE`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`) and
a configured `WHATSAPP_PHONE_NUMBER_ID` are present, but it only sends once the
operator switches recovery **on** — so flipping it on or off in the dashboard
takes effect without a redeploy. `ABANDONED_CHECKOUT_POLL_MINUTES` (default 5)
and `ABANDONED_CHECKOUT_LOOKBACK_HOURS` (default 24) tune the poll cadence and
scan window.

> **WhatsApp policy note:** the Cloud API only delivers a free-form text message
> to a customer who has messaged your number within the last 24 hours. A shopper
> who abandoned a checkout usually has **not**, so Meta will reject these
> reminders (error 131047) unless there is an open 24-hour window. Delivering
> reliably to cold contacts requires an approved Meta message template; this
> feature deliberately uses editable text instead, per product decision.

Endpoints:

```text
GET  /abandoned-checkouts/status   # poller state (running, enabled, timings)
GET  /abandoned-checkouts/config   # the editable reminder settings
PUT  /abandoned-checkouts/config   # update message / delay / on-off
POST /abandoned-checkouts/run      # run one recovery pass now (testing / external cron)
```

`POST /abandoned-checkouts/run` lets an external scheduler (for example a Render
cron job) drive the pass instead of the built-in interval.

## Test

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```
