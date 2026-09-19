import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logging/json-logger.service';

async function bootstrap(): Promise<void> {
  // ───────────── Logger selection ─────────────
  // In production we want structured JSON on stdout (log aggregators,
  // Kubernetes log scraping). The JsonLogger also pulls request-id +
  // tenant + user from AsyncLocalStorage so log lines carry their full
  // request context. In development we keep Nest's default pretty logs.
  const useJson = process.env.LOG_FORMAT === 'json';
  const jsonLogger = new JsonLogger();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger: useJson ? jsonLogger : new Logger(),
  });
  if (useJson) app.useLogger(jsonLogger);

  // Honor X-Forwarded-For from the LB / reverse proxy so that
  // IP-keyed rate limits (e.g. /auth/login) bucket by real client IP,
  // not by the proxy's IP. Required when running behind Coolify /
  // Traefik / nginx / Cloudflare.
  // When running behind Docker reverse proxy, trust proxy must be true (or 1)
  // so Express reads X-Forwarded-For rather than the internal Docker bridge IP.
  const expressApp = app.getHttpAdapter().getInstance();
  const trustProxyEnv = process.env.TRUST_PROXY;
  if (trustProxyEnv === 'true' || trustProxyEnv === '1') {
    expressApp.set('trust proxy', true);
  } else if (trustProxyEnv === 'false' || trustProxyEnv === '0') {
    expressApp.set('trust proxy', false);
  } else if (trustProxyEnv) {
    expressApp.set('trust proxy', trustProxyEnv);
  } else {
    // Default to true in production/behind reverse proxies (Coolify/Traefik)
    expressApp.set('trust proxy', true);
  }

  const logger = new Logger('Bootstrap');

  // ───────────── Security headers ─────────────
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production'
          ? {
              // API is JSON-only; no scripts, no embeds, no inline assets.
              directives: {
                defaultSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'none'"],
              },
            }
          : false,
      // HSTS only in production behind HTTPS termination
      strictTransportSecurity:
        process.env.NODE_ENV === 'production'
          ? { maxAge: 15552000, includeSubDomains: true, preload: false }
          : false,
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'deny' },
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // ───────────── Compression ─────────────
  app.use(compression());

  // ───────────── Raw body capture for SendGrid webhook ─────────────
  // SendGrid Inbound Parse signs the raw multipart payload via HMAC-SHA256
  // (header `x-sendgrid-signature`). By the time Nest's multer + ValidationPipe
  // mutate the request, the bytes have been re-serialised and the original
  // byte-for-byte signature no longer matches.
  //
  // Strategy: install a 'data' listener BEFORE multer (busboy) attaches
  // its own listeners, mirror every chunk into `req._rawBodyChunks`,
  // and let multer continue parsing. Once the upstream emits 'end', we
  // freeze the buffer into `req.rawBody`. The signature verifier reads
  // `req.rawBody` AFTER multer has finished (i.e. in the controller body),
  // so we never race multer.
  // SCOPED to the inbound-email webhook ONLY. A global 'data' listener drains
  // the request stream before multer/busboy can read it, which breaks EVERY
  // multipart upload in the app (documents, etc.) with "File is required".
  // The SendGrid HMAC only needs raw bytes on the webhook path, so we gate the
  // capture to that route and leave all other requests untouched.
  const RAW_BODY_PATHS = ['/api/v1/inbound/email', '/api/v1/inbound/mail'];
  const expressAppRaw = app.getHttpAdapter().getInstance();
  expressAppRaw.use((req: any, _res: any, next: any) => {
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const isRawBodyRoute = RAW_BODY_PATHS.some((p) => path.startsWith(p));
    if (isRawBodyRoute) {
      const chunks: Buffer[] = (req._rawBodyChunks ??= []);
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        req.rawBody = Buffer.concat(chunks);
      });
    }
    next();
  });

  // ───────────── HTTP request log ─────────────
  // morgan 'combined' in dev/prod stays human-readable for the request
  // envelope; the JSON logger takes over for everything else.
  app.use(
    morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
      stream: { write: (msg) => logger.log(msg.trim()) },
    }),
  );

  // ───────────── CORS ─────────────
  // `CORS_ORIGINS` is a comma-separated allowlist of origins. In staging
  // and production this is the explicit list of allowed web domains;
  // in dev it defaults to the local Next.js origin.
  // To allow '*' (DANGEROUS with credentials), set CORS_ORIGINS='*'.
  const origins =
    process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ??
    ['http://localhost:3000'];
  app.enableCors({
    origin: origins.includes('*') ? '*' : origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  // ───────────── Global prefix + validation ─────────────
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ───────────── Swagger (public on the API) ─────────────
  const swagger = new DocumentBuilder()
    .setTitle('DocFlow API')
    .setDescription(
      'Portuguese SaaS for documents, banking, CRM and fiscal compliance',
    )
    .setVersion(process.env.APP_VERSION ?? '0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('api/docs', app, document);

  // ───────────── Listen ─────────────
  const port = parseInt(process.env.PORT || '4000', 10);
  await app.listen(port);
  logger.log(`DocFlow API listening on http://localhost:${port}/api/v1`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});