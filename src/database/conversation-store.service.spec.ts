import { ConversationStoreService } from './conversation-store.service';

describe('ConversationStoreService', () => {
  it('stores new turns without deleting older conversation messages', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    const service = new ConversationStoreService({ pool } as never);

    await service.saveTurn('15551234567', 'Hello', 'Hi there');

    const executedSql = client.query.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');

    expect(executedSql).not.toMatch(/DELETE FROM "ConversationMessage"/);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('returns the complete stored conversation in chronological order', async () => {
    const storedMessages = Array.from({ length: 45 }, (_, index) => ({
      id: index + 1,
      role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
      content: `Message ${index + 1}`,
      createdAt: '2026-07-16T00:00:00.000Z',
      needsHumanAttention: false,
      attentionReason: null,
    }));
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: storedMessages }),
    };
    const service = new ConversationStoreService({ pool } as never);

    await expect(service.findAllMessages('15551234567')).resolves.toEqual(
      storedMessages,
    );

    const [sql] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY id ASC');
    expect(sql).not.toContain('LIMIT');
  });
});
