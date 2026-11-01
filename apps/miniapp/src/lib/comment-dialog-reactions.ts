import type { ChannelDialogResponse } from '@maxim/contracts/channel-dialog';

export function toggleDialogReactionLocally(
  dialog: ChannelDialogResponse | undefined,
  messageId: string,
  emoji: string,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  return {
    ...dialog,
    messages: dialog.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      const reactedEmoji = message.reactionGroups.find((group) => group.reactedByMe)?.emoji ?? null;
      const nextGroups = message.reactionGroups
        .map((group) => {
          if (group.reactedByMe) {
            const nextCount = group.count - 1;
            return nextCount > 0
              ? {
                  ...group,
                  count: nextCount,
                  reactedByMe: false,
                }
              : null;
          }

          if (reactedEmoji === emoji || group.emoji !== emoji) {
            return group;
          }

          return {
            ...group,
            count: group.count + 1,
            reactedByMe: true,
          };
        })
        .filter((group): group is NonNullable<typeof group> => group !== null);

      if (reactedEmoji !== emoji && !nextGroups.some((group) => group.emoji === emoji)) {
        nextGroups.push({
          emoji,
          count: 1,
          reactedByMe: true,
        });
      }

      return {
        ...message,
        reactionGroups: nextGroups.sort(
          (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji),
        ),
      };
    }),
  };
}
