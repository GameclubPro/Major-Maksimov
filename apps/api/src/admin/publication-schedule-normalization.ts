import type { PublicationScheduleInput } from '@maxim/contracts/publication';
import { BadRequestException } from '@nestjs/common';
import {
  assertPublicationTimezone,
  findNextPublicationRecurrenceSlot,
} from './publication-recurrence';

export function normalizePublicationSchedule(
  schedule: PublicationScheduleInput,
  now: Date,
  pastGraceMs: number,
): PublicationScheduleInput {
  try {
    assertPublicationTimezone(schedule.timezone);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new BadRequestException('Выберите корректный часовой пояс.');
    }
    throw error;
  }
  const normalized =
    schedule.mode === 'recurrence' && schedule.startsAt === null
      ? { ...schedule, startsAt: now.toISOString() }
      : schedule;
  const datedSlots =
    normalized.mode === 'once'
      ? [new Date(normalized.at)]
      : normalized.mode === 'slots'
        ? normalized.slots.map((slot) => new Date(slot))
        : [];
  if (datedSlots.some((slot) => slot.getUTCSeconds() !== 0 || slot.getUTCMilliseconds() !== 0)) {
    throw new BadRequestException('Укажите время с точностью до минуты, без секунд.');
  }
  if (datedSlots.some((slot) => slot.getTime() < now.getTime() - pastGraceMs)) {
    throw new BadRequestException('Время публикации уже прошло.');
  }
  return normalized;
}

export function assertPublishableSchedule(
  schedule: PublicationScheduleInput | null,
  initialSlots: Date[],
  now: Date,
): void {
  if (
    schedule?.mode !== 'recurrence' ||
    initialSlots.length > 0 ||
    schedule.endsAt === null ||
    findNextPublicationRecurrenceSlot(schedule, now, 0)
  ) {
    return;
  }

  throw new BadRequestException({
    code: 'PUBLICATION_SCHEDULE_EMPTY',
    message: 'Расписание не содержит ни одного будущего запуска.',
  });
}
