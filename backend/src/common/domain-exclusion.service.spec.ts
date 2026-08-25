import { DomainExclusionService } from './domain-exclusion.service';

describe('DomainExclusionService', () => {
  const originalEnv = process.env.EXCLUDED_DOMAINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXCLUDED_DOMAINS;
    } else {
      process.env.EXCLUDED_DOMAINS = originalEnv;
    }
  });

  it('excludes an exact domain listed in EXCLUDED_DOMAINS', () => {
    process.env.EXCLUDED_DOMAINS = 'goszakup.gov.kz, zakup.nationalbank.kz, qazcloud.kz, cloud.qazcloud.kz';
    const service = new DomainExclusionService();

    expect(service.isDomainExcluded('goszakup.gov.kz')).toBe(true);
    expect(service.isUrlExcluded('https://goszakup.gov.kz/ru/some-page')).toBe(true);
  });

  it('excludes a subdomain of a listed domain (e.g. cloud.qazcloud.kz under qazcloud.kz)', () => {
    process.env.EXCLUDED_DOMAINS = 'qazcloud.kz';
    const service = new DomainExclusionService();

    expect(service.isUrlExcluded('https://cloud.qazcloud.kz/dashboard')).toBe(true);
    expect(service.isUrlExcluded('http://www.qazcloud.kz/')).toBe(true);
  });

  it('does not exclude an unrelated domain that merely contains the blacklisted one as a substring', () => {
    process.env.EXCLUDED_DOMAINS = 'qazcloud.kz';
    const service = new DomainExclusionService();

    expect(service.isUrlExcluded('https://notqazcloud.kz/')).toBe(false);
    expect(service.isUrlExcluded('https://example.com/')).toBe(false);
  });

  it('is case-insensitive and ignores a leading www. on both sides', () => {
    process.env.EXCLUDED_DOMAINS = 'WWW.Zakup.NationalBank.kz';
    const service = new DomainExclusionService();

    expect(service.isUrlExcluded('https://ZAKUP.nationalbank.kz/tender/1')).toBe(true);
  });

  it('accepts a bare domain (no scheme) as input', () => {
    process.env.EXCLUDED_DOMAINS = 'qazcloud.kz';
    const service = new DomainExclusionService();

    expect(service.isUrlExcluded('qazcloud.kz')).toBe(true);
    expect(service.isUrlExcluded('cloud.qazcloud.kz')).toBe(true);
  });

  it('excludes nothing when EXCLUDED_DOMAINS is unset or empty', () => {
    delete process.env.EXCLUDED_DOMAINS;
    const service = new DomainExclusionService();

    expect(service.isUrlExcluded('https://goszakup.gov.kz/')).toBe(false);
  });
});