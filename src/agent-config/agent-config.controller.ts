import { Body, Controller, Get, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentConfigService,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  StoredAgentConfig,
} from './agent-config.service';

type AgentConfigInput = {
  systemPrompt?: string | null;
  model?: string | null;
};

type AgentConfigResponse = StoredAgentConfig & {
  effectiveSystemPrompt: string;
  effectiveModel: string;
};

@Controller('agent-config')
export class AgentConfigController {
  constructor(
    private readonly agentConfigService: AgentConfigService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  async getConfig(): Promise<AgentConfigResponse> {
    const stored = await this.agentConfigService.getConfig();
    return this.withEffectiveValues(stored);
  }

  @Put()
  async updateConfig(
    @Body() body: AgentConfigInput,
  ): Promise<AgentConfigResponse> {
    const systemPrompt = body.systemPrompt?.trim() || null;
    const model = body.model?.trim() || null;
    const stored = await this.agentConfigService.updateConfig(
      systemPrompt,
      model,
    );

    return this.withEffectiveValues(stored);
  }

  private withEffectiveValues(stored: StoredAgentConfig): AgentConfigResponse {
    return {
      ...stored,
      effectiveSystemPrompt:
        stored.systemPrompt?.trim() ||
        this.configService.get<string>('CHATBOT_SYSTEM_PROMPT')?.trim() ||
        DEFAULT_SYSTEM_PROMPT,
      effectiveModel:
        stored.model?.trim() ||
        this.configService.get<string>('OPENAI_MODEL')?.trim() ||
        DEFAULT_MODEL,
    };
  }
}
