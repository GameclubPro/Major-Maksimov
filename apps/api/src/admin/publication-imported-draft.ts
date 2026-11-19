import { publicationDraftStateSchema } from '@maxim/contracts/publication-draft';
import { BadRequestException } from '@nestjs/common';
import { PublicationAudienceSelection, PublicationLifecycle } from '../prisma/prisma-client';

export function isImportedEmptyPublicationDraft(publication: {
  lifecycle: PublicationLifecycle;
  audienceSelection: PublicationAudienceSelection;
  targets: readonly unknown[];
}): boolean {
  return (
    publication.lifecycle === PublicationLifecycle.DRAFT &&
    publication.audienceSelection === PublicationAudienceSelection.SELECTED &&
    publication.targets.length === 0
  );
}

export function assertPublicationImportReviewResolved(rule: unknown): void {
  if (!rule || typeof rule !== 'object' || !('importReview' in rule)) return;
  const parsed = publicationDraftStateSchema.safeParse(rule);
  const review = parsed.success ? parsed.data.importReview : null;
  if (!review || review.warnings.some((_, index) => !review.resolved.includes(index))) {
    throw new BadRequestException({
      code: 'PUBLICATION_IMPORT_REVIEW_REQUIRED',
      message: 'Проверьте, что не перенеслось, и выберите, как продолжить.',
    });
  }
}
