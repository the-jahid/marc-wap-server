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

## Test

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```
