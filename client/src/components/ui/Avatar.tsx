import { useState } from 'react';
import { cn } from '@/lib/cn';
import { initialsOf } from '@/lib/format';

const SIZES = {
  xs: 'size-6 text-[0.625rem]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-base',
} as const;

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  /** A per-person tint, usually StaffProfile.color. */
  color?: string | null;
}

/**
 * Initials with an optional photo over the top.
 *
 * The image is `aria-hidden` and the whole avatar carries the person's name as
 * a title-less accessible label only when it stands alone — beside a name in a
 * list it would double-announce, so callers pass their own wrapper text and the
 * avatar stays decorative.
 */
export function Avatar({ name, src, size = 'md', className, color }: AvatarProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const showImage = typeof src === 'string' && src.length > 0 && !failed;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border border-border font-semibold',
        SIZES[size],
        showImage ? 'bg-surface-sunken' : 'bg-brand-subtle text-brand-text',
        className,
      )}
      style={color && !showImage ? { backgroundColor: `${color}22`, color } : undefined}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          // A broken avatar URL falls back to initials rather than a torn icon.
          onError={() => setFailed(true)}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
