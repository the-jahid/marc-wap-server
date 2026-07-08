import { Global, Module } from '@nestjs/common';
import { PRISMA_SERVICE } from './prisma.constants';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PRISMA_SERVICE,
      useExisting: PrismaService,
    },
  ],
  exports: [PrismaService, PRISMA_SERVICE],
})
export class PrismaModule {}
