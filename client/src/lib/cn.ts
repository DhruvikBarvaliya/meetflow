import clsx, { type ClassValue } from 'clsx';

/** Conditional class names. Thin alias so the import site reads the same everywhere. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
