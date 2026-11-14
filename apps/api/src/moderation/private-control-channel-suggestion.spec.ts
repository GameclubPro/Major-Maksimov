import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { describePrivateSuggestionReviewError } from './private-control-channel-suggestion';
import { MaxApiInternalRateLimitError } from '../max/max-api-internal-rate-limit.error';
import { MaxApiCircuitOpenError } from '../max/max-client.service';

describe('private suggestion review errors', () => {
  it.each([
    [new MaxApiInternalRateLimitError('source limit exceeded', 5000), 'временно ограничил'],
    [new MaxApiCircuitOpenError('major', 5000), 'временно ограничил'],
    [
      new ServiceUnavailableException(
        'MAX API временно ограничил проверку прав администратора. Повторите попытку.',
      ),
      'временно ограничил проверку прав',
    ],
    [new BadRequestException('Предложка требует проверки.'), 'Предложка требует проверки.'],
    [
      new ServiceUnavailableException('Очередь временно недоступна.'),
      'Очередь временно недоступна.',
    ],
    [{ response: { status: 403 } }, 'администраторы канала'],
    [{ response: { status: 429 } }, 'временно ограничил'],
    [
      Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }),
      'MAX не подтвердил результат',
    ],
    [new Error('database password=private'), 'Не удалось подтвердить результат'],
  ])('returns actionable, sanitized copy for %#', (error, expected) => {
    const message = describePrivateSuggestionReviewError(error);
    expect(message).toContain(expected);
    expect(message).not.toContain('password');
  });
});
