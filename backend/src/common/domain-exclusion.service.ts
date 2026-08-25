import { Injectable } from '@nestjs/common';

/**
 * EXCLUDED_DOMAINS — comma-separated list of domains (and their subdomains) that must never end
 * up in `sources` or `mentions`, however they were found: neither as a manually added source nor
 * as a finding surfaced by a whole-web channel (К-1 NewsAPI, К-6 OpenAI web search) that has no
 * fixed list of sites to begin with. Read directly from process.env — same choice already made
 * for BACKFILL_DAYS/TELEGRAM_NOTIFY_SOURCE_TYPES in collector-run.util.ts — so this class works
 * identically whether Nest DI resolves it (SourceOnboardingService, the startup enforcer) or it's
 * instantiated directly in a plain function (collector-run.util.ts). Growing the list only ever
 * means editing .env, never redeploying code.
 */
@Injectable()
export class DomainExclusionService {
  private getExcludedDomains(): string[] {
    return (process.env.EXCLUDED_DOMAINS ?? '')
      .split(',')
      .map((d) => this.normalizeDomain(d))
      .filter(Boolean);
  }

  private normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/^www\./, '');
  }

  private extractDomain(urlOrDomain: string): string | null {
    const value = (urlOrDomain ?? '').trim();
    if (!value) {
      return null;
    }
    try {
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
      const parsed = new URL(hasScheme ? value : `https://${value}`);
      return this.normalizeDomain(parsed.hostname);
    } catch {
      return null;
    }
  }

  /** True if `domain` is exactly one of the excluded domains, or a subdomain of one. */
  isDomainExcluded(domain: string): boolean {
    const normalized = this.normalizeDomain(domain ?? '');
    if (!normalized) {
      return false;
    }
    return this.getExcludedDomains().some((excluded) => normalized === excluded || normalized.endsWith(`.${excluded}`));
  }

  /** Same check, starting from a full URL (or a bare domain) instead of an already-parsed hostname. */
  isUrlExcluded(urlOrDomain: string): boolean {
    const domain = this.extractDomain(urlOrDomain);
    return domain ? this.isDomainExcluded(domain) : false;
  }
}