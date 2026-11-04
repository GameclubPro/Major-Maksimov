import { KaravanMarketplaceBindingStatusService } from './karavan-marketplace-binding-status.service';
import { KaravanMarketplaceActorAccessService } from './karavan-marketplace-actor-access.service';
import { KaravanMarketplaceController } from './karavan-marketplace.controller';
import { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
import { KaravanMarketplaceConnectionsService } from './karavan-marketplace-connections.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MaxModule } from '../../max/max.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';
import {
  KaravanMarketplaceIntegrationController,
  KaravanMarketplaceIntegrationGuard,
} from './karavan-marketplace-integration.controller';

@Module({
  imports: [AuthModule, MaxModule, PrismaModule],
  controllers: [KaravanMarketplaceIntegrationController, KaravanMarketplaceController],
  providers: [
    KaravanMarketplaceBindingStatusService,
    KaravanMarketplaceActorAccessService,
    KaravanMarketplaceProxyService,
    KaravanMarketplaceConnectionsService,
    KaravanMarketplaceHandoffService,
    KaravanMarketplaceIntegrationGuard,
  ],
})
export class KaravanMarketplaceModule {}
