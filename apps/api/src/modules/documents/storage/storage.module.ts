import { Logger, Module } from '@nestjs/common';
import { LocalFilesystemStorage } from './local-filesystem.storage';
import { S3Storage } from './s3.storage';
import { StorageService } from './storage-service.interface';

/**
 * StorageModule — wires the active StorageService implementation.
 *
 * Driver selection is by `STORAGE_DRIVER` (read at DI time, i.e. after
 * ConfigModule.forRoot() has loaded `.env`):
 *   - `local` (default) -> LocalFilesystemStorage under UPLOADS_DIR
 *   - `s3` | `minio`    -> S3Storage (aws-sdk v3, path-style, presigned URLs)
 *
 * Any other value falls back to `local` with a loud log so a typo in the
 * env never silently changes where bytes go. Every other module depends
 * on the `StorageService` token via DI — no call sites change.
 */
export function resolveStorageDriver(raw: string | undefined): 'local' | 's3' {
  const v = (raw ?? 'local').trim().toLowerCase();
  if (v === 's3' || v === 'minio') return 's3';
  if (v !== 'local' && v !== '') {
    new Logger('StorageModule').error(
      `Unknown STORAGE_DRIVER="${raw}" — falling back to "local"`,
    );
  }
  return 'local';
}

@Module({
  providers: [
    LocalFilesystemStorage,
    S3Storage,
    {
      provide: StorageService,
      useFactory: (local: LocalFilesystemStorage, s3: S3Storage) => {
        const driver = resolveStorageDriver(process.env.STORAGE_DRIVER);
        new Logger('StorageModule').log(`Storage driver: ${driver}`);
        return driver === 's3' ? s3 : local;
      },
      inject: [LocalFilesystemStorage, S3Storage],
    },
  ],
  exports: [StorageService, LocalFilesystemStorage, S3Storage],
})
export class StorageModule {}
