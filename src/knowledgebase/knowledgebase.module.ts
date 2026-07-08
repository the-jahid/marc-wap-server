import { Module } from '@nestjs/common';
import { KnowledgebaseService } from './knowledgebase.service';

@Module({
  providers: [KnowledgebaseService],
  exports: [KnowledgebaseService],
})
export class KnowledgebaseModule {}
