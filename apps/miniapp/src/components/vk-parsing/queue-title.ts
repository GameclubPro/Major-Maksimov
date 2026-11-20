import type { VkParsingPost } from '@maxim/contracts/vk-parsing';

export function getQueuePostTitle(post: VkParsingPost): string {
  return (
    post.text.trim().split(/\n/u, 1)[0]?.trim() ||
    (post.photoUrls.length
      ? 'Пост с фото'
      : post.videoUrls.length
        ? 'Пост с видео'
        : 'Пост без текста')
  );
}
