import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentOrigin } from '@prisma/client';
import { DocumentQueryDto } from '../dto/document.dto';

/**
 * Sprint F — origin filter on `GET /documents`.
 *
 * The DTO accepts either:
 *   - a single value   (?origin=GMAIL)
 *   - a CSV string     (?origin=GMAIL,OUTLOOK)
 *   - repeated params  (?origin=GMAIL&origin=OUTLOOK)
 * and rejects values that are not part of the `DocumentOrigin` enum.
 *
 * These tests cover the transform + validation layer that runs BEFORE
 * the service so the downstream `buildWhere` can trust the shape.
 */

async function parseOrigin(query: Record<string, unknown>) {
  const instance = plainToInstance(DocumentQueryDto, query);
  const errors = await validate(instance, { whitelist: true });
  return { instance, errors };
}

describe('DocumentQueryDto origin filter', () => {
  it('accepts a single value as a 1-element array', async () => {
    const { instance, errors } = await parseOrigin({ origin: 'GMAIL' });
    expect(errors).toHaveLength(0);
    expect(instance.origin).toEqual([DocumentOrigin.GMAIL]);
  });

  it('splits a CSV string into an array', async () => {
    const { instance, errors } = await parseOrigin({ origin: 'GMAIL,OUTLOOK' });
    expect(errors).toHaveLength(0);
    expect(instance.origin).toEqual([
      DocumentOrigin.GMAIL,
      DocumentOrigin.OUTLOOK,
    ]);
  });

  it('accepts a pre-split array (Express repeated params)', async () => {
    const { instance, errors } = await parseOrigin({
      origin: ['GMAIL', 'OUTLOOK'],
    });
    expect(errors).toHaveLength(0);
    expect(instance.origin).toEqual([
      DocumentOrigin.GMAIL,
      DocumentOrigin.OUTLOOK,
    ]);
  });

  it('rejects values outside the DocumentOrigin enum', async () => {
    const { errors } = await parseOrigin({ origin: 'GMAIL,NOT_A_REAL_VALUE' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats an empty / missing origin as undefined (no filter)', async () => {
    const { instance, errors } = await parseOrigin({});
    expect(errors).toHaveLength(0);
    expect(instance.origin).toBeUndefined();
  });

  it('survives blank tokens in CSV (whitespace trimmed, empties dropped)', async () => {
    const { instance, errors } = await parseOrigin({ origin: 'GMAIL, ,OUTLOOK' });
    expect(errors).toHaveLength(0);
    expect(instance.origin).toEqual([
      DocumentOrigin.GMAIL,
      DocumentOrigin.OUTLOOK,
    ]);
  });

  it('coexists with status / type filters (whitelist stays intact)', async () => {
    const { instance, errors } = await parseOrigin({
      origin: 'SCANNER',
      status: 'NOVO',
      type: 'FATURA_RECEBIDA',
    });
    expect(errors).toHaveLength(0);
    expect(instance.origin).toEqual([DocumentOrigin.SCANNER]);
  });
});
