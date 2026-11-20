import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublicationController } from './publication.controller';

describe('PublicationController', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
  };

  it('exposes all publication handlers exclusively to Publik', () => {
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublicationController.prototype.create),
    ).toEqual(['publisher']);
    expect(
      Reflect.getMetadata(
        MINIAPP_PROFILES_METADATA,
        PublicationController.prototype.calendarAvailability,
      ),
    ).toEqual(['publisher']);
    expect(
      Reflect.getMetadata(
        MINIAPP_PROFILES_METADATA,
        PublicationController.prototype.refreshTargets,
      ),
    ).toEqual(['publisher']);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublicationController.prototype.listLegacy),
    ).toEqual(['publisher']);

    for (const handler of [
      PublicationController.prototype.list,
      PublicationController.prototype.get,
      PublicationController.prototype.update,
      PublicationController.prototype.pause,
      PublicationController.prototype.resume,
      PublicationController.prototype.cancel,
      PublicationController.prototype.remove,
      PublicationController.prototype.deliveries,
      PublicationController.prototype.skipOccurrence,
      PublicationController.prototype.rescheduleOccurrence,
      PublicationController.prototype.retryOccurrence,
      PublicationController.prototype.resolveAmbiguous,
    ]) {
      expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, handler)).toEqual(['publisher']);
    }
  });

  it('maps every profile-scoped operation to its immutable dispatch profile', () => {
    const publicationService = {
      list: jest.fn(),
      create: jest.fn(),
      getCalendarAvailability: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      cancel: jest.fn(),
      listDeliveries: jest.fn(),
      rescheduleOccurrence: jest.fn(),
      retryOccurrence: jest.fn(),
      resolveAmbiguousDelivery: jest.fn(),
      sendTest: jest.fn(),
    };
    const publisherTargetRefresh = { request: jest.fn() };
    const controller = new PublicationController(
      publicationService as never,
      publisherTargetRefresh as never,
    );
    const query = { view: 'plan' };
    const body = { requestId: 'request-1' };

    controller.list(user, query, 'publisher');
    controller.create(user, body, 'publisher');
    controller.calendarAvailability(user, body, 'publisher');
    controller.refreshTargets('publication-1', user);
    controller.get('publication-1', user, 'publisher');
    controller.update('publication-1', user, body, 'publisher');
    controller.pause('publication-1', user, body, 'publisher');
    controller.resume('publication-1', user, body, 'publisher');
    controller.cancel('publication-1', user, body, 'publisher');
    controller.remove('publication-1', user, body, 'publisher');
    controller.deliveries('publication-1', user, query, 'publisher');
    controller.rescheduleOccurrence('publication-1', 'occurrence-1', user, body, 'publisher');
    controller.retryOccurrence('publication-1', 'occurrence-1', user, body, 'publisher');
    controller.resolveAmbiguous('publication-1', 'occurrence-1', user, body, 'publisher');

    expect(publicationService.list).toHaveBeenCalledWith(
      user,
      query,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.create).toHaveBeenCalledWith(
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.getCalendarAvailability).toHaveBeenCalledWith(
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publisherTargetRefresh.request).toHaveBeenCalledWith('publication-1', user);
    expect(publicationService.get).toHaveBeenCalledWith(
      'publication-1',
      user,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.update).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.pause).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.resume).toHaveBeenCalledWith(
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.cancel).toHaveBeenNthCalledWith(
      1,
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.cancel).toHaveBeenNthCalledWith(
      2,
      'publication-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.listDeliveries).toHaveBeenCalledWith(
      'publication-1',
      user,
      query,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.rescheduleOccurrence).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.retryOccurrence).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(publicationService.resolveAmbiguousDelivery).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      user,
      body,
      PublicationDispatchProfile.PUBLIK_V1,
    );
  });

  it('never exposes the retired test sender to either profile', () => {
    const publicationService = { sendTest: jest.fn() };
    const controller = new PublicationController(publicationService as never, {} as never);

    expect(() => controller.test(user, {}, 'publisher')).toThrow();
    expect(publicationService.sendTest).not.toHaveBeenCalled();

    expect(() => controller.test(user, {}, 'moderation')).toThrow();
    expect(publicationService.sendTest).not.toHaveBeenCalled();
  });
});
