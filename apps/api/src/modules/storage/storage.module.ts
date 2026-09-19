import { Module } from '@nestjs/common';
import { StorageModule as DocumentsStorageModule } from '../documents/storage/storage.module';
import { StorageController } from './storage.controller';

/**
 * StorageModule — exposes the filesystem tree of a tenant's uploads root.
 *
 * Re-uses the same `LocalFilesystemStorage` driver the document upload
 * pipeline uses, so the controller lists EXACTLY the same bytes the
 * pipeline wrote. When we swap to S3/MinIO, replace
 * `LocalFilesystemStorage` here with `S3StorageAdapter` and the route
 * surface stays the same.
 */
@Module({
  imports: [DocumentsStorageModule],
  controllers: [StorageController],
})
export class StorageBrowseModule {}
