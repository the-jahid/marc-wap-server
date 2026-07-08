import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KnowledgeEntry, KnowledgebaseService } from './knowledgebase.service';
import type { UploadedKnowledgeFile } from './uploaded-knowledge-file.type';

type KnowledgeEntryInput = {
  title?: string;
  content?: string;
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller('knowledgebase')
export class KnowledgebaseController {
  constructor(private readonly knowledgebaseService: KnowledgebaseService) {}

  @Get()
  list(): Promise<KnowledgeEntry[]> {
    return this.knowledgebaseService.list();
  }

  @Post()
  create(@Body() body: KnowledgeEntryInput): Promise<KnowledgeEntry> {
    const { title, content } = this.validate(body);
    return this.knowledgebaseService.create(title, content);
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: UploadedKnowledgeFile | undefined,
    @Body('title') title?: string,
  ): Promise<KnowledgeEntry> {
    if (!file) {
      throw new BadRequestException('A document file is required');
    }

    return this.knowledgebaseService.uploadDocument(file, title);
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: KnowledgeEntryInput,
  ): Promise<KnowledgeEntry> {
    const { title, content } = this.validate(body);
    const entry = await this.knowledgebaseService.update(id, title, content);

    if (!entry) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }

    return entry;
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ deleted: boolean }> {
    const deleted = await this.knowledgebaseService.remove(id);

    if (!deleted) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }

    return { deleted };
  }

  private validate(body: KnowledgeEntryInput): {
    title: string;
    content: string;
  } {
    const title = body.title?.trim();
    const content = body.content?.trim();

    if (!title || !content) {
      throw new BadRequestException('Both title and content are required');
    }

    return { title, content };
  }
}
