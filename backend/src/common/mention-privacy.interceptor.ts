import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { redactHiddenMentions, shouldExposeCuratedUrls } from './mention-privacy.util';

/**
 * Registered globally (see AppModule's APP_INTERCEPTOR provider), so it covers every controller
 * that exists now and every one added later — GET /mentions, GET /mentions/stats,
 * PATCH /mentions/:id/sentiment and anything else that ever serializes a mention.
 *
 * `CURATED_LINKS_EXPOSE_URLS=true` turns the redaction off for the REST API and the frontend
 * only — an escape hatch for an operator who is looking at their own data. It has no effect on
 * the Telegram bot, which reads through CuratedSearchService and never selects the url column at
 * all (ПРОМПТ 1): the bot does not show pool links under any configuration.
 *
 * `process.env` is read per request rather than cached in the constructor so the flag can be
 * flipped without a rebuild of this class's state; the cost is one string comparison per
 * response.
 */
@Injectable()
export class MentionPrivacyInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((payload) => (shouldExposeCuratedUrls() ? payload : redactHiddenMentions(payload))));
  }
}
