// ai.module.ts — NestJS module registering all AI/Copilot services
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { VisionService } from './vision.service';
import { ZeroxService } from './zerox.service';
import { ExtractionService } from './extraction.service';
import { OcrService } from './ocr.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { RetrievalService } from './retrieval.service';
import { RagService } from './rag.service';
import { ClassificationService } from './classification.service';
import { DuplicateService } from './duplicate.service';
import { AnomalyService } from './anomaly.service';
import { LlmProvider } from './llm-provider';
import { FaturistaProvider } from './providers/faturista.provider';
import { AiManagementService } from './ai-management.service';
import { AiManagementController } from './ai-management.controller';

@Module({
  imports: [PrismaModule],
  controllers: [CopilotController, AiManagementController],
  providers: [
    LlmProvider,
    FaturistaProvider,
    AiManagementService,
    CopilotService,
    VisionService,
    ZeroxService,
    ExtractionService,
    OcrService,
    EmbeddingService,
    VectorStoreService,
    RetrievalService,
    RagService,
    ClassificationService,
    DuplicateService,
    AnomalyService,
  ],
  exports: [
    LlmProvider,
    FaturistaProvider,
    AiManagementService,
    CopilotService,
    VisionService,
    ZeroxService,
    // ExtractionService is intentionally not re-exported here — it's owned by
    // ExtractionModule to avoid a circular module dependency. ExtractionModule
    // imports AiModule so it can use VisionService, but AiModule does not
    // depend on ExtractionModule.
    OcrService,
    EmbeddingService,
    DuplicateService,
    AnomalyService,
  ],
})
export class AiModule {}