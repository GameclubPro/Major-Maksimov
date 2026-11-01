import { SafetyDeskController } from './safety-desk.controller';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';

describe('SafetyDeskController night-mode runtime pagination', () => {
  it('keeps commercial feedback under the closed owner guard and forwards the trusted actor', () => {
    const commercial = {
      getQueue: jest.fn().mockReturnValue({ items: [] }),
      labelItem: jest.fn().mockReturnValue({}),
      adjudicateItem: jest.fn().mockReturnValue({}),
      exportIndependentEvidence: jest.fn().mockReturnValue({}),
      exportAiIndependentEvidence: jest.fn().mockReturnValue({}),
      exportSamplingFrame: jest.fn().mockReturnValue({}),
    };
    const controller = new SafetyDeskController({} as never, commercial as never);
    expect(Reflect.getMetadata(GUARDS_METADATA, SafetyDeskController)).toContain(
      SafetyDeskAdminGuard,
    );
    controller.getCommercialReview({ limit: '50', status: 'PENDING' }, 'trusted-owner');
    expect(commercial.getQueue).toHaveBeenCalledWith(
      { limit: '50', status: 'PENDING' },
      'trusted-owner',
    );
    const body = { label: 'NOT_COMMERCIAL', expectedUpdatedAt: '2026-10-01T10:00:00.000Z' };
    controller.labelCommercialReview('sample-1', 'trusted-owner', body);
    expect(commercial.labelItem).toHaveBeenCalledWith('sample-1', 'trusted-owner', body);
    controller.adjudicateCommercialReview('sample-1', 'third-owner', body);
    expect(commercial.adjudicateItem).toHaveBeenCalledWith('sample-1', 'third-owner', body);
    const window = {
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-05T00:00:00.000Z',
      limit: '50',
    };
    controller.exportCommercialReview(window, 'trusted-owner');
    expect(commercial.exportIndependentEvidence).toHaveBeenCalledWith(window, 'trusted-owner');
    controller.exportCommercialAiReview(window, 'trusted-owner');
    expect(commercial.exportAiIndependentEvidence).toHaveBeenCalledWith(window, 'trusted-owner');
    controller.exportCommercialSamplingFrame(window, 'trusted-owner');
    expect(commercial.exportSamplingFrame).toHaveBeenCalledWith(window, 'trusted-owner');
  });
  it.each([undefined, '0', '50', '1000'])(
    'passes the raw offset query value %p to the bounded service read',
    (offset) => {
      const response = { offset: offset === undefined ? 0 : Number(offset), items: [] };
      const safetyDeskService = {
        getNightModeTransitionRuntime: jest.fn().mockReturnValue(response),
      };
      const controller = new SafetyDeskController(safetyDeskService as never);

      expect(controller.getNightModeTransitionRuntime(offset)).toBe(response);
      expect(safetyDeskService.getNightModeTransitionRuntime).toHaveBeenCalledWith(offset);
    },
  );
});
