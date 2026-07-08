import { Module } from '@nestjs/common';
import { KnowledgebaseController } from './knowledgebase.controller';
import { KnowledgebaseService } from './knowledgebase.service';

@Module({
  controllers: [KnowledgebaseController],
  providers: [KnowledgebaseService],
  exports: [KnowledgebaseService],
})
export class KnowledgebaseModule {}
