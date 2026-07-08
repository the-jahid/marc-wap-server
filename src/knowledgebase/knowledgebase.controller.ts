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
} from '@nestjs/common';
import {
  KnowledgeEntry,
  KnowledgebaseService,
} from './knowledgebase.service';

type KnowledgeEntryInput = {
  title?: string;
  content?: string;
};

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
