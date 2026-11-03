import { useState } from 'react';

type PersonAvatarProps = {
  avatarUrl: string | null;
  fallback: string;
  className: string;
};

export function PersonAvatar({ avatarUrl, fallback, className }: PersonAvatarProps) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const showImage = Boolean(avatarUrl) && avatarUrl !== brokenUrl;

  return (
    <span className={`${className} ${showImage ? `${className}--image` : ''}`.trim()}>
      {showImage ? (
        <img
          src={avatarUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBrokenUrl(avatarUrl)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
