import { Module } from '@nestjs/common';
import { DocumentTextService } from './document-text.service';
import { KnowledgebaseVectorService } from './knowledgebase-vector.service';
import { KnowledgebaseService } from './knowledgebase.service';

@Module({
  providers: [
    DocumentTextService,
    KnowledgebaseService,
    KnowledgebaseVectorService,
  ],
  exports: [KnowledgebaseService],
})
export class KnowledgebaseModule {}
