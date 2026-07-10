import { BadRequestException } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';

describe('ConversationsController', () => {
  const conversationStore = {
    listConversations: jest.fn(),
    findAllMessages: jest.fn(),
    saveMessage: jest.fn(),
  };
  const whatsappService = {
    sendManualText: jest.fn(),
  };
  const controller = new ConversationsController(
    conversationStore as never,
    whatsappService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends and stores a manual WhatsApp reply', async () => {
    const storedMessage = {
      id: 42,
      role: 'ASSISTANT' as const,
      content: 'Hello there',
      createdAt: '2026-07-10T12:00:00.000Z',
    };
    whatsappService.sendManualText.mockResolvedValue(undefined);
    conversationStore.saveMessage.mockResolvedValue(storedMessage);

    await expect(
      controller.sendMessage('+15551234567', { message: ' Hello there ' }),
    ).resolves.toEqual(storedMessage);

    expect(whatsappService.sendManualText).toHaveBeenCalledWith(
      '15551234567',
      'Hello there',
    );
    expect(conversationStore.saveMessage).toHaveBeenCalledWith(
      '15551234567',
      'ASSISTANT',
      'Hello there',
    );
  });

  it('rejects an empty manual reply without calling WhatsApp', async () => {
    await expect(
      controller.sendMessage('15551234567', { message: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(whatsappService.sendManualText).not.toHaveBeenCalled();
    expect(conversationStore.saveMessage).not.toHaveBeenCalled();
  });

  it('rejects an invalid recipient phone number', async () => {
    await expect(
      controller.sendMessage('not-a-number', { message: 'Hello' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(whatsappService.sendManualText).not.toHaveBeenCalled();
  });
});
