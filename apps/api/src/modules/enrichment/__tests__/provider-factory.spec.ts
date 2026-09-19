import { ConfigService } from '@nestjs/config';
import {
  EnrichmentProviderFactory,
  type EnrichmentProvider,
} from '../providers/provider.factory';
import { ManualProvider } from '../providers/manual.provider';
import { SabiPtProvider } from '../providers/sabi-pt.provider';
import { ViesProvider } from '../providers/vies.provider';

/**
 * Sprint I — provider factory routing tests.
 *
 * Verifies the factory picks the right provider for every flavour of
 * Party.country + IBAN combination documented in scout §5.1. The
 * ManualProvider is included as a stub so the factory has something
 * concrete to return in every branch — every other provider is
 * mocked at the class level so the tests stay fast and offline.
 */
describe('EnrichmentProviderFactory', () => {
  const makeFactory = (): EnrichmentProviderFactory => {
    const sabi = Object.create(SabiPtProvider.prototype) as SabiPtProvider;
    Object.defineProperty(sabi, 'name', { value: 'sabi-pt' });
    const vies = Object.create(ViesProvider.prototype) as ViesProvider;
    Object.defineProperty(vies, 'name', { value: 'vies' });
    const manual = Object.create(ManualProvider.prototype) as ManualProvider;
    Object.defineProperty(manual, 'name', { value: 'manual' });
    return new EnrichmentProviderFactory(sabi, vies, manual);
  };

  /**
   * Fase 4.1 (P2.3) — a SABI está desligada: é uma base de dados paga
   * que a HotelEquip não subscreve, e a ficha de entidade mostrava
   * `sabi_api_key_missing` como se fosse uma avaria. Portugal passa a
   * ir pelo VIES, que é gratuito e não precisa de chave.
   */
  it('routes country=PT to vies (sabi-pt desligada na Fase 4.1)', () => {
    const factory = makeFactory();
    const picked = factory.pick('PT', null);
    expect(picked.name).toBe('vies');
  });

  it('routes PT50… IBAN to vies regardless of country', () => {
    const factory = makeFactory();
    const picked = factory.pick(null, 'PT50 0002 0123 1234 5678 9015 4');
    expect(picked.name).toBe('vies');
  });

  it('routes country=ES (EU non-PT) to vies', () => {
    const factory = makeFactory();
    const picked = factory.pick('ES', null);
    expect(picked.name).toBe('vies');
  });

  it('routes country=FR to vies', () => {
    const factory = makeFactory();
    expect(factory.pick('FR', null).name).toBe('vies');
    expect(factory.pick('DE', null).name).toBe('vies');
    expect(factory.pick('IT', null).name).toBe('vies');
    expect(factory.pick('NL', null).name).toBe('vies');
    expect(factory.pick('IE', null).name).toBe('vies');
  });

  it('routes non-PT EU IBAN prefix to vies', () => {
    const factory = makeFactory();
    expect(factory.pick(null, 'ES91 2100 0418 4502 0005 1332').name).toBe('vies');
    expect(factory.pick(null, 'FR76 3000 6000 0112 3456 7890 189').name).toBe('vies');
    expect(factory.pick(null, 'DE89 3704 0044 0532 0130 00').name).toBe('vies');
  });

  it('routes extra-EU country to manual', () => {
    const factory = makeFactory();
    expect(factory.pick('US', null).name).toBe('manual');
    expect(factory.pick('BR', null).name).toBe('manual');
    expect(factory.pick('CN', null).name).toBe('manual');
    expect(factory.pick('JP', null).name).toBe('manual');
  });

  it('routes extra-EU IBAN prefix to manual', () => {
    const factory = makeFactory();
    expect(factory.pick(null, 'US12 CHAS 0000 0000 0000 0000').name).toBe('manual');
    expect(factory.pick(null, 'BR15 0000 0000 0000 1093 2840 814').name).toBe('manual');
  });

  it('routes missing country + missing IBAN to manual', () => {
    const factory = makeFactory();
    expect(factory.pick(null, null).name).toBe('manual');
    expect(factory.pick('', '').name).toBe('manual');
  });

  it('is case-insensitive for both country and IBAN', () => {
    const factory = makeFactory();
    expect(factory.pick('pt', null).name).toBe('vies');
    expect(factory.pick('es', null).name).toBe('vies');
    expect(factory.pick('us', null).name).toBe('manual');
    expect(factory.pick(null, 'pt50 0002 0123 1234 5678 9015 4').name).toBe('vies');
  });

  it('strips whitespace from IBAN before checking the prefix', () => {
    const factory = makeFactory();
    expect(factory.pick(null, '   ES91 2100 0418 4502 0005 1332   ').name).toBe('vies');
  });

  it('static isEuCountry helper covers the canonical list', () => {
    expect(EnrichmentProviderFactory.isEuCountry('PT')).toBe(true);
    expect(EnrichmentProviderFactory.isEuCountry('DE')).toBe(true);
    expect(EnrichmentProviderFactory.isEuCountry('HR')).toBe(true); // joined 2013
    expect(EnrichmentProviderFactory.isEuCountry('RO')).toBe(true); // joined 2007
    expect(EnrichmentProviderFactory.isEuCountry('GB')).toBe(false); // post-Brexit
    expect(EnrichmentProviderFactory.isEuCountry('US')).toBe(false);
    expect(EnrichmentProviderFactory.isEuCountry(null)).toBe(false);
  });
});
