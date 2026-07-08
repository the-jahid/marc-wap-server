import { Module } from '@nestjs/common';
import { DocumentTextService } from './document-text.service';
import { KnowledgebaseVectorService } from './knowledgebase-vector.service';
import { KnowledgebaseController } from './knowledgebase.controller';
import { KnowledgebaseService } from './knowledgebase.service';

@Module({
  controllers: [KnowledgebaseController],
  providers: [
    DocumentTextService,
    KnowledgebaseService,
    KnowledgebaseVectorService,
  ],
  exports: [KnowledgebaseService],
})
export class KnowledgebaseModule {}
