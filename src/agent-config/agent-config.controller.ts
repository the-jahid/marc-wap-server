import { Body, Controller, Get, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentConfigService,
  DEFAULT_CHAT_MODELS,
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

type OpenAiModelList = {
  data?: Array<{ id: string }>;
};

type ModelListResponse = {
  models: string[];
  source: 'openai' | 'default';
};

// Model families that make sense for generating chat replies. Everything
// else in the OpenAI list (embeddings, tts, whisper, dall-e, …) is noise.
const CHAT_MODEL_PATTERN = /^(gpt-|chatgpt-|o\d)/;
const NON_CHAT_KEYWORDS = [
  'audio',
  'realtime',
  'transcribe',
  'tts',
  'search',
  'embedding',
  'image',
  'moderation',
  'instruct',
];

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

@Controller('agent-config')
export class AgentConfigController {
  private modelsCache: (ModelListResponse & { fetchedAt: number }) | null =
    null;

  constructor(
    private readonly agentConfigService: AgentConfigService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  async getConfig(): Promise<AgentConfigResponse> {
    const stored = await this.agentConfigService.getConfig();
    return this.withEffectiveValues(stored);
  }

  @Get('models')
  async listModels(): Promise<ModelListResponse> {
    const cached = this.modelsCache;
    if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
      return { models: cached.models, source: cached.source };
    }

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      return { models: DEFAULT_CHAT_MODELS, source: 'default' };
    }

    let payload: OpenAiModelList;
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        throw new Error(`OpenAI responded with status ${response.status}`);
      }
      payload = (await response.json()) as OpenAiModelList;
    } catch {
      return { models: DEFAULT_CHAT_MODELS, source: 'default' };
    }

    const models = this.orderModels(
      (payload.data ?? [])
        .map((model) => model.id)
        .filter(
          (id) =>
            CHAT_MODEL_PATTERN.test(id) &&
            !NON_CHAT_KEYWORDS.some((keyword) => id.includes(keyword)),
        ),
    );

    this.modelsCache = { models, source: 'openai', fetchedAt: Date.now() };
    return { models, source: 'openai' };
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

  private orderModels(models: string[]): string[] {
    const uniqueModels = Array.from(new Set(models));
    const recommendedModels = DEFAULT_CHAT_MODELS.filter((model) =>
      uniqueModels.includes(model),
    );
    const remainingModels = uniqueModels
      .filter((model) => !DEFAULT_CHAT_MODELS.includes(model))
      .sort();

    return [...recommendedModels, ...remainingModels];
  }
}
