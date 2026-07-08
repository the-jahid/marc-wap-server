import { Module } from '@nestjs/common';
import { AgentConfigController } from './agent-config.controller';
import { AgentConfigService } from './agent-config.service';

@Module({
  controllers: [AgentConfigController],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
