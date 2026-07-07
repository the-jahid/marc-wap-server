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
OPENAI_MODEL=gpt-4o-mini
WHATSAPP_API_KEY=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_GRAPH_API_VERSION=v23.0
CHATBOT_SYSTEM_PROMPT=
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
