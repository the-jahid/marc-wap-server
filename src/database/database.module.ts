import { Global, Module } from '@nestjs/common';
import { CONVERSATION_STORE } from './conversation-store.constants';
import { ConversationStoreService } from './conversation-store.service';
import { PgPoolService } from './pg-pool.service';

@Global()
@Module({
  providers: [
    PgPoolService,
    ConversationStoreService,
    {
      provide: CONVERSATION_STORE,
      useExisting: ConversationStoreService,
    },
  ],
  exports: [PgPoolService, ConversationStoreService, CONVERSATION_STORE],
})
export class DatabaseModule {}
