import { Global, Module } from '@nestjs/common';
import { CONVERSATION_STORE } from './conversation-store.constants';
import { ConversationStoreService } from './conversation-store.service';

@Global()
@Module({
  providers: [
    ConversationStoreService,
    {
      provide: CONVERSATION_STORE,
      useExisting: ConversationStoreService,
    },
  ],
  exports: [ConversationStoreService, CONVERSATION_STORE],
})
export class DatabaseModule {}
