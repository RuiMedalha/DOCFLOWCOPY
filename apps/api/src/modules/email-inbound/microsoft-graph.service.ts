import { Injectable } from '@nestjs/common';
import { OutlookService } from './outlook.service';

@Injectable()
export class MicrosoftGraphService extends OutlookService {}

export type {
  GraphPollerStats,
  ExtractedEmailAttachment,
} from './outlook.service';

