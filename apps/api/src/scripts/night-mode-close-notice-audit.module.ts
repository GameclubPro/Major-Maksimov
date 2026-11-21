import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateEnv } from '../config/env.schema';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      expandVariables: true,
    }),
    PrismaModule,
  ],
  providers: [
    {
      provide: MaxBotRegistryService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new MaxBotRegistryService(config),
    },
  ],
})
export class NightModeCloseNoticeAuditModule {}
