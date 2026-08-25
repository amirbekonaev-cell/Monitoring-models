import { Body, Controller, Post } from '@nestjs/common';
import { SourceOnboardingService } from './source-onboarding.service';

@Controller('sources')
export class SourceOnboardingController {
  constructor(private readonly onboardingService: SourceOnboardingService) {}

  @Post()
  async addByLink(@Body() body: { url: string; name?: string }) {
    return this.onboardingService.addByLink(body.url, body.name?.trim() || null, 'admin');
  }
}