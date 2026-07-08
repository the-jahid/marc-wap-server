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
OPENAI_MODEL=gpt-5.5
WHATSAPP_API_KEY=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_GRAPH_API_VERSION=v23.0
CHATBOT_SYSTEM_PROMPT=
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marc?schema=public
```

`WHATSAPP_API_KEY` is the Meta Graph API access token. `WHATSAPP_VERIFY_TOKEN` is any private string you choose and then enter in Meta's webhook setup.

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

Prisma is configured for PostgreSQL. After setting `DATABASE_URL`, generate the Prisma client and run migrations when models are added:

```bash
npm run prisma:generate
npm run prisma:migrate
```

Conversation memory is stored in the `ConversationMessage` table, keyed by the WhatsApp sender phone number. The chatbot loads the latest 15 user/assistant turns for each sender before generating a reply.

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

## Test

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```
