import type { KaravanMarketplaceResolverService } from '../karavan-marketplace/karavan-marketplace-resolver.service';
import { KaravanStorefrontRelayService } from './karavan-storefront-relay.service';

function createConfigMock(overrides: Record<string, unknown> = {}) {
  const values = {
    KARAVAN_STOREFRONT_RELAY_ENABLED: true,
    KARAVAN_API_BASE_URL: 'https://api2.major-maksimov.ru/karavan/api',
    KARAVAN_INTEGRATION_TOKEN: 'test-karavan-integration-token',
    KARAVAN_STOREFRONT_CATALOG_URL: 'https://max.ru/se13381675_1_bot?startapp=',
    KARAVAN_STOREFRONT_CREATE_URL: 'https://max.ru/se13381675_bot?startapp=storefront',
    KARAVAN_STOREFRONT_LOOKUP_TIMEOUT_MS: 500,
    KARAVAN_STOREFRONT_CACHE_TTL_SEC: 120,
    KARAVAN_STOREFRONT_RELAY_LOCK_TTL_SEC: 3600,
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key as keyof typeof values]),
  };
}

function createService(
  options: {
    config?: Record<string, unknown>;
    resolver?: Pick<KaravanMarketplaceResolverService, 'shouldUseScopedRelay' | 'resolve'>;
    authorization?: { canPublish: jest.Mock };
    fetchResponse?: unknown;
    lockToken?: string | null;
    sendRejects?: boolean;
    sendError?: unknown;
  } = {},
) {
  const maxClient = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  };
  if (options.sendRejects) {
    maxClient.sendMessage.mockRejectedValue(options.sendError ?? new Error('send timeout'));
  }

  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-pending-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const redisCounter = {
    acquireLock: jest
      .fn()
      .mockResolvedValue(options.lockToken === undefined ? 'lock-1' : options.lockToken),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    renewLock: jest.fn().mockResolvedValue(true),
  };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(
      options.fetchResponse ?? {
        exists: true,
        store: {
          id: 'store-1',
          slug: 'severnaya-lavka',
          name: 'Северная лавка',
          sellerAccountId: 'seller-1',
          url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
          inviteUrl:
            'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/severnaya-lavka/invite',
        },
      },
    ),
  });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as never;

  const service = new KaravanStorefrontRelayService(
    maxClient as never,
    prisma as never,
    redisCounter as never,
    createConfigMock(options.config) as never,
    options.authorization as never,
    options.resolver as never,
  );

  return {
    service,
    maxClient,
    prisma,
    redisCounter,
    fetchMock,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

const baseContext = {
  karavanStorefrontEnabled: true,
  updateType: 'message_created',
  chatId: 'chat-1',
  messageId: 'mid-source-1',
  senderId: '1001',
  senderName: 'Мария & Ко',
  text: '$ свежая клубника',
  raw: {
    message: {
      body: {
        text: '$ свежая клубника',
      },
    },
  },
  botId: '777000_bot',
};

describe('KaravanStorefrontRelayService', () => {
  it('keeps legacy for never-enrolled chats while selfservice is enabled', async () => {
    const resolver = {
      shouldUseScopedRelay: jest.fn().mockResolvedValue(false),
      resolve: jest.fn(),
    };
    const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: true }, resolver });
    try {
      expect(await f.service.handleMessageCreated(baseContext)).toBe('handled');
      expect(f.fetchMock).toHaveBeenCalledTimes(1);
      expect(resolver.resolve).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it.each(['$', '$ Продам цветы'])(
    'publishes the common administration shop for %s without inventing a personal storefront',
    async (text) => {
      const publication = {
        chatId: baseContext.chatId,
        actorMaxUserId: baseContext.senderId,
        subjectMaxUserId: baseContext.senderId,
        sourceMessageId: baseContext.messageId,
        botId: baseContext.botId,
        marketplaceId: '7d6aac8f-060b-4758-bc51-a63e07ae29a2',
        bindingGeneration: 3,
        format: 'storefront',
        formatRevision: 2,
        storeId: null,
        url: 'https://max.ru/synthetic_bot?startapp=m_synthetic',
        sourceFingerprint: 'a'.repeat(64),
      };
      const resolver = {
        shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
        resolve: jest.fn().mockResolvedValue({
          result: { status: 'published', publicationTarget: 'administration_shop', stores: [] },
          publication,
        }),
      };
      const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: true }, resolver });
      try {
        expect(
          await f.service.handleMessageCreated({
            ...baseContext,
            text,
            raw: { message: { body: { text } } },
          }),
        ).toBe('handled');
        expect(f.fetchMock).not.toHaveBeenCalled();
        const args = f.maxClient.sendMessage.mock.calls[0];
        expect(args[2].buttons).toEqual([[expect.objectContaining({ url: publication.url })]]);
        expect(args[3]).toMatchObject({
          routing: { requiredBotId: baseContext.botId },
          ledgerContext: { karavanMarketplacePublication: publication },
        });
      } finally {
        f.restore();
      }
    },
  );

  it.each([true, false])(
    'never downgrades enrolled chats after resolver failure (feature=%s)',
    async (enabled) => {
      const resolver = {
        shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
        resolve: jest.fn().mockRejectedValue(new Error('Synthetic unknown binding')),
      };
      const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: enabled }, resolver });
      try {
        expect(await f.service.handleMessageCreated(baseContext)).toBe('failed');
        expect(f.fetchMock).not.toHaveBeenCalled();
        expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
      } finally {
        f.restore();
      }
    },
  );
  it('does not publish a global catalog for an enrolled disconnected chat', async () => {
    const resolver = {
      shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({
        result: { status: 'unbound', stores: [], marketplace: null, binding: null },
        publication: null,
      }),
    };
    const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: true }, resolver });
    try {
      expect(
        await f.service.handleMessageCreated({
          ...baseContext,
          text: '$',
          raw: { message: { body: { text: '$' } } },
        }),
      ).toBe('noop');
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it('keeps an ambiguous storefront choice private without sending a generic fallback', async () => {
    const resolver = {
      shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
      resolve: jest
        .fn()
        .mockResolvedValue({ result: { status: 'choose_store', stores: [] }, publication: null }),
    };
    const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: true }, resolver });
    try {
      expect(await f.service.handleMessageCreated(baseContext)).toBe('noop');
      expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(f.fetchMock).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it('persists scoped target and exact bot so final queued dispatch can revalidate', async () => {
    const publication = {
      chatId: baseContext.chatId,
      actorMaxUserId: baseContext.senderId,
      subjectMaxUserId: baseContext.senderId,
      sourceMessageId: baseContext.messageId,
      botId: baseContext.botId,
      marketplaceId: '7d6aac8f-060b-4758-bc51-a63e07ae29a2',
      bindingGeneration: 3,
      storeId: 'b20c5040-e501-4221-84d6-b52778ce56a8',
      url: 'https://max.ru/synthetic_bot?startapp=m_synthetic__s_test',
      sourceFingerprint: 'a'.repeat(64),
    };
    const resolver = {
      shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({
        result: {
          status: 'published',
          stores: [
            {
              id: publication.storeId,
              slug: 'test',
              name: 'Test',
              url: publication.url,
              inviteUrl: publication.url,
            },
          ],
        },
        publication,
      }),
    };
    const f = createService({ config: { KARAVAN_MARKETPLACE_ENABLED: true }, resolver });
    try {
      expect(await f.service.handleMessageCreated(baseContext)).toBe('handled');
      expect(f.fetchMock).not.toHaveBeenCalled();
      const args = f.maxClient.sendMessage.mock.calls[0];
      expect(args[2].buttons).toEqual([[expect.objectContaining({ url: publication.url })]]);
      expect(args[3]).toMatchObject({
        routing: { requiredBotId: baseContext.botId },
        ledgerContext: { karavanMarketplacePublication: publication },
      });
    } finally {
      f.restore();
    }
  });

  it.each([true, false])(
    'sends configured plain copy and preserves button destinations (store=%s)',
    async (hasStore) => {
      const fixture = createService(
        hasStore ? {} : { fetchResponse: { exists: false, store: null } },
      );
      const storefrontTexts = {
        karavanStorefrontMessageText: '<Товары> *продавца*\nВыберите магазин',
        karavanStorefrontOpenButtonText: 'К продавцу',
        karavanStorefrontCatalogButtonText: 'Все магазины',
        karavanStorefrontCreateButtonText: 'Создать магазин',
      };
      try {
        await expect(
          fixture.service.handleMessageCreated({
            ...baseContext,
            text: '$',
            raw: { message: { body: { text: '$' } } },
            storefrontTexts,
          }),
        ).resolves.toBe('handled');
        expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
          'chat-1',
          storefrontTexts.karavanStorefrontMessageText,
          {
            messageLink: { type: 'reply', mid: 'mid-source-1' },
            buttons: hasStore
              ? [
                  [
                    {
                      type: 'link',
                      text: 'К продавцу',
                      url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
                    },
                  ],
                ]
              : [
                  [
                    {
                      type: 'link',
                      text: 'Все магазины',
                      url: 'https://max.ru/se13381675_1_bot?startapp=',
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Создать магазин',
                      url: 'https://max.ru/se13381675_bot?startapp=storefront',
                    },
                  ],
                ],
          },
          expect.anything(),
        );
        expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              payload: expect.objectContaining({
                messageText: storefrontTexts.karavanStorefrontMessageText,
              }),
            }),
          }),
        );
      } finally {
        fixture.restore();
      }
    },
  );

  it.each([true, false])(
    'requires send-time custom copy before promoting a reply audit (matches=%s)',
    async (matches) => {
      const fixture = createService();
      fixture.prisma.auditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'audit-custom',
        payload: { sourceMessageId: 'source-custom', messageText: 'Сохранённый текст продавца' },
      });
      try {
        await expect(
          fixture.service.recognizeCompanionMessage({
            chatId: 'chat-1',
            messageId: 'companion-custom',
            text: matches ? 'Сохранённый текст продавца' : 'Другой ответ бота',
            raw: { message: { link: { type: 'reply', message: { mid: 'source-custom' } } } },
          }),
        ).resolves.toBe(matches);
        expect(fixture.prisma.auditLog.update).toHaveBeenCalledTimes(matches ? 1 : 0);
      } finally {
        fixture.restore();
      }
    },
  );

  it('does not query the audit log for unrelated non-reply bot copy', async () => {
    const fixture = createService();
    try {
      await expect(
        fixture.service.recognizeCompanionMessage({
          chatId: 'chat-1',
          messageId: 'other',
          text: 'Другой текст',
        }),
      ).resolves.toBe(false);
      expect(fixture.prisma.auditLog.findFirst).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('denies relay before a lock or storefront lookup when admin-only authorization fails', async () => {
    const authorization = { canPublish: jest.fn().mockResolvedValue(false) };
    const fixture = createService({ authorization });

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          karavanStorefrontAdminsOnly: true,
        }),
      ).resolves.toBe('noop');
      expect(authorization.canPublish).toHaveBeenCalledWith({
        chatId: 'chat-1',
        actorUserId: '1001',
        adminsOnly: true,
      });
      expect(fixture.redisCounter.acquireLock).not.toHaveBeenCalled();
      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps actor authorization separate from a forwarded seller lookup', async () => {
    const authorization = { canPublish: jest.fn().mockResolvedValue(true) };
    const fixture = createService({ authorization });

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          karavanStorefrontAdminsOnly: true,
          storefrontOwnerUserId: 'seller-42',
          raw: {
            message: {
              body: { text: '' },
              link: {
                type: 'forward',
                sender: { user_id: 'seller-42' },
                message: { text: '$ товар' },
              },
            },
          },
        }),
      ).resolves.toBe('handled');
      expect(authorization.canPublish).toHaveBeenCalledWith({
        chatId: 'chat-1',
        actorUserId: '1001',
        adminsOnly: true,
      });
      expect(fixture.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/by-max-user/seller-42'),
        expect.anything(),
      );
    } finally {
      fixture.restore();
    }
  });

  it('returns disabled before acquiring a lock when the chat setting is off', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          karavanStorefrontEnabled: false,
        }),
      ).resolves.toBe('disabled');
      expect(fixture.redisCounter.acquireLock).not.toHaveBeenCalled();
      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('adds a storefront reply button for dollar-prefixed seller messages without touching the original post', async () => {
    const fixture = createService();

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledWith(
        'https://api2.major-maksimov.ru/karavan/api/v1/integrations/maxim/storefronts/by-max-user/1001',
        expect.objectContaining({
          headers: {
            authorization: 'Bearer test-karavan-integration-token',
          },
        }),
      );
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        'Витрина продавца',
        {
          messageLink: {
            type: 'reply',
            mid: 'mid-source-1',
          },
          buttons: [
            [
              {
                type: 'link',
                text: 'Открыть витрину',
                url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
              },
            ],
          ],
        },
        expect.objectContaining({
          idempotencyKey: 'karavan-storefront-relay:v2:chat-1:mid-source-1',
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: 'karavan_storefront_relay',
          ledgerContext: {
            karavanStorefrontRelay: expect.objectContaining({
              sourceMessageId: 'mid-source-1',
              senderId: '1001',
              requestedBotId: '777000_bot',
              storeId: 'store-1',
            }),
          },
        }),
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(fixture.redisCounter.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.fetchMock.mock.invocationCallOrder[0]!,
      );
      expect(fixture.redisCounter.renewLock).toHaveBeenCalledWith(
        'karavan-storefront-relay:v1:chat-1:mid-source-1',
        'lock-1',
        3_600_000,
      );
      expect(fixture.redisCounter.releaseLock).not.toHaveBeenCalled();
      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'KARAVAN_STOREFRONT_RELAY',
            payload: expect.objectContaining({
              sourceMessageId: 'mid-source-1',
              companionMessageId: null,
              deliveryStatus: 'pending',
            }),
          }),
          select: { id: true },
        }),
      );
      expect(fixture.prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'audit-pending-1' },
        data: {
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: expect.objectContaining({
            sourceMessageId: 'mid-source-1',
            deliveryStatus: 'queued',
          }),
        },
      });
    } finally {
      fixture.restore();
    }
  });

  it('resolves the active storefront again for every dollar-prefixed message', async () => {
    const fixture = createService();
    fixture.fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          exists: true,
          store: {
            id: 'store-1',
            slug: 'severnaya-lavka',
            name: 'Северная лавка',
            sellerAccountId: 'seller-1',
            url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
            inviteUrl:
              'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/severnaya-lavka/invite',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          exists: true,
          store: {
            id: 'store-2',
            slug: 'tsvety-max',
            name: 'Цветы MAX',
            sellerAccountId: 'seller-1',
            url: 'https://max.ru/se13381675_1_bot?startapp=s_tsvety-max__r_seller-1',
            inviteUrl:
              'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/tsvety-max/invite',
          },
        }),
      });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('handled');
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          messageId: 'mid-source-2',
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
      expect(fixture.maxClient.sendMessage).toHaveBeenLastCalledWith(
        'chat-1',
        'Витрина продавца',
        expect.objectContaining({
          buttons: [
            [
              {
                type: 'link',
                text: 'Открыть витрину',
                url: 'https://max.ru/se13381675_1_bot?startapp=s_tsvety-max__r_seller-1',
              },
            ],
          ],
        }),
        expect.objectContaining({
          trafficClass: 'interactive',
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('ignores messages without a dollar marker', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: 'обычное сообщение без маркера',
          raw: {
            message: {
              body: {
                text: 'обычное сообщение без маркера',
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('accepts a dollar marker after leading whitespace in raw body text', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: null,
          raw: {
            message: {
              body: {
                text: '  $ клубника с доставкой',
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('adds a storefront button for a forwarded seller post with a blank outer body', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('supports a forwarded seller post when MAX omits the outer body and forward sender', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: null,
              link: {
                type: 'forward',
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('reads a forwarded seller post from a webhook event envelope', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            update_type: 'message_created',
            message_created: {
              message: {
                body: {
                  text: '',
                },
                link: {
                  type: 'forward',
                  sender: {
                    user_id: '1001',
                  },
                  message: {
                    text: '$ свежая клубника',
                  },
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('reads a forwarded seller marker from the nested message body after whitespace-only outer text', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '   ',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  body: {
                    text: '$ клубника с доставкой',
                  },
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it.each(['reply', 'quoted'])('ignores a dollar marker inside a %s preview', async (linkType) => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: linkType,
                message: {
                  text: '$ чужая витрина',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('ignores a forwarded marker whose author differs from the current sender', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: 'another-seller',
                },
                message: {
                  text: '$ чужая витрина',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('prioritizes direct current-message text over a forwarded marker', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: 'обычный ответ на пересылку',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps the normalized text fallback for raw-less compatibility contexts', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: undefined,
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('retries a failed lookup on a later dollar-prefixed message edit', async () => {
    const fixture = createService();
    fixture.fetchMock.mockRejectedValueOnce(new Error('lookup timeout')).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        exists: true,
        store: {
          id: 'store-2',
          slug: 'del-yarn',
          name: 'ДЭЛЬ',
          sellerAccountId: 'seller-2',
          url: 'https://max.ru/se13381675_1_bot?startapp=s_del-yarn__r_seller-2',
          inviteUrl: 'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/del-yarn/invite',
        },
      }),
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          updateType: 'message_edited',
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        'Витрина продавца',
        expect.objectContaining({
          buttons: [
            [
              {
                type: 'link',
                text: 'Открыть витрину',
                url: 'https://max.ru/se13381675_1_bot?startapp=s_del-yarn__r_seller-2',
              },
            ],
          ],
        }),
        expect.objectContaining({
          trafficClass: 'interactive',
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('does not add a button when the sender has no public storefront', async () => {
    const fixture = createService({
      fetchResponse: {
        exists: false,
        store: null,
      },
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('noop');

      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('sends catalog and seller buttons for a bare dollar when the sender has no storefront', async () => {
    const fixture = createService({
      fetchResponse: {
        exists: false,
        store: null,
      },
    });

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: '$',
          raw: {
            message: {
              body: {
                text: '$',
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        'Витрина продавца',
        {
          messageLink: {
            type: 'reply',
            mid: 'mid-source-1',
          },
          buttons: [
            [
              {
                type: 'link',
                text: 'Смотреть витрины',
                url: 'https://max.ru/se13381675_1_bot?startapp=',
              },
            ],
            [
              {
                type: 'link',
                text: 'Открыть витрину',
                url: 'https://max.ru/se13381675_bot?startapp=storefront',
              },
            ],
          ],
        },
        expect.objectContaining({
          ledgerContext: {
            karavanStorefrontRelay: expect.objectContaining({
              sourceMessageId: 'mid-source-1',
              senderId: '1001',
              storeId: null,
              storeSlug: null,
              variant: 'directory',
            }),
          },
        }),
      );
      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({
              sourceMessageId: 'mid-source-1',
              variant: 'directory',
              store: null,
              deliveryStatus: 'pending',
            }),
          }),
          select: { id: true },
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('keeps the personal storefront button for a bare dollar when the sender has a storefront', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: '  $  ',
          raw: {
            message: {
              body: {
                text: '  $  ',
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        'Витрина продавца',
        expect.objectContaining({
          buttons: [
            [
              {
                type: 'link',
                text: 'Открыть витрину',
                url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
              },
            ],
          ],
        }),
        expect.objectContaining({
          ledgerContext: {
            karavanStorefrontRelay: expect.objectContaining({
              storeId: 'store-1',
              storeSlug: 'severnaya-lavka',
              variant: 'storefront',
            }),
          },
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('does not add duplicate buttons when the message is already claimed', async () => {
    const fixture = createService({ lockToken: null });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('duplicate');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('releases the processing claim when durable queue acceptance fails', async () => {
    const fixture = createService({ sendRejects: true });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');

      expect(fixture.redisCounter.releaseLock).toHaveBeenCalledWith(
        'karavan-storefront-relay:v1:chat-1:mid-source-1',
        'lock-1',
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('releases the processing claim for any rejected queue request', async () => {
    const error = Object.assign(new Error('bad request'), {
      response: {
        status: 400,
      },
    });
    const fixture = createService({ sendRejects: true, sendError: error });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');

      expect(fixture.redisCounter.releaseLock).toHaveBeenCalledWith(
        'karavan-storefront-relay:v1:chat-1:mid-source-1',
        'lock-1',
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps the durable claim when BullMQ queue ownership is ambiguous', async () => {
    const fixture = createService({
      sendRejects: true,
      sendError: new Error('Ambiguous BullMQ ownership for MAX SEND_MESSAGE relay-1'),
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');

      expect(fixture.redisCounter.renewLock).toHaveBeenCalled();
      expect(fixture.redisCounter.releaseLock).not.toHaveBeenCalled();
      expect(fixture.prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'audit-pending-1' },
        data: {
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: expect.objectContaining({
            deliveryStatus: 'ambiguous',
          }),
        },
      });
    } finally {
      fixture.restore();
    }
  });

  it('coalesces concurrent fresh storefront lookups for the same seller', async () => {
    const fixture = createService();

    try {
      await expect(
        Promise.all([
          fixture.service.handleMessageCreated(baseContext),
          fixture.service.handleMessageCreated({
            ...baseContext,
            chatId: 'chat-2',
            messageId: 'mid-source-2',
          }),
        ]),
      ).resolves.toEqual(['handled', 'handled']);

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      fixture.restore();
    }
  });

  it('promotes a queued audit when the reply companion webhook arrives', async () => {
    const fixture = createService();
    fixture.prisma.auditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'audit-queued-1',
      payload: {
        sourceMessageId: 'mid-source-1',
        companionMessageId: null,
        deliveryStatus: 'queued',
      },
    });

    try {
      await expect(
        fixture.service.recognizeCompanionMessage({
          chatId: 'chat-1',
          messageId: 'mid-companion-1',
          text: 'Витрина продавца',
          raw: {
            message: {
              link: {
                type: 'reply',
                message: {
                  mid: 'mid-source-1',
                },
              },
            },
          },
        }),
      ).resolves.toBe(true);

      expect(fixture.prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'audit-queued-1' },
        data: {
          payload: expect.objectContaining({
            sourceMessageId: 'mid-source-1',
            companionMessageId: 'mid-companion-1',
            deliveryStatus: 'sent',
          }),
        },
      });
    } finally {
      fixture.restore();
    }
  });

  it('stays disabled unless explicitly configured', async () => {
    const fixture = createService({
      config: {
        KARAVAN_STOREFRONT_RELAY_ENABLED: false,
      },
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('disabled');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });
});
