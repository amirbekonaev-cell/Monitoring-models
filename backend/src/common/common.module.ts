import { Global, Module } from '@nestjs/common';
import { DomainExclusionService } from './domain-exclusion.service';

/**
 * @Global so DomainExclusionService is available everywhere via constructor DI without every
 * feature module having to import CommonModule explicitly — imported once from AppModule.
 */
@Global()
@Module({
  providers: [DomainExclusionService],
  exports: [DomainExclusionService],
})
export class CommonModule {}