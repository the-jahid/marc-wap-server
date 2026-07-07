export interface WhatsappWebhookPayload {
  object?: string;
  entry?: WhatsappEntry[];
}

export interface WhatsappEntry {
  id?: string;
  changes?: WhatsappChange[];
}

export interface WhatsappChange {
  field?: string;
  value?: WhatsappChangeValue;
}

export interface WhatsappChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: {
      name?: string;
    };
    wa_id?: string;
  }>;
  messages?: WhatsappInboundMessage[];
  statuses?: unknown[];
}

export interface WhatsappInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
}

export interface WhatsappMessageEnvelope {
  message: WhatsappInboundMessage;
  phoneNumberId?: string;
}

export interface WhatsappWebhookResult {
  received: true;
  messagesReceived: number;
  messagesProcessed: number;
  repliesSent: number;
}
