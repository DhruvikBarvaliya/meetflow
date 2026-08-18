import { useCallback, useState } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { isApiError, type ApiError } from '@/lib/apiClient';

/**
 * Translates a failed request into form state.
 *
 * Field-scoped problems (`details[].field`) go onto the matching input so the
 * message sits where the mistake is; anything else becomes a form-level banner.
 * Without this split, a 422 naming `email` would show up as a generic "check
 * your details" and leave the user hunting.
 */
export function useFormApiError<TValues extends FieldValues>(
  setError: UseFormSetError<TValues>,
  knownFields: ReadonlyArray<Path<TValues>>,
): {
  formError: string | null;
  clearFormError: () => void;
  handleApiError: (error: unknown) => void;
} {
  const [formError, setFormError] = useState<string | null>(null);

  const clearFormError = useCallback(() => setFormError(null), []);

  const handleApiError = useCallback(
    (error: unknown) => {
      if (!isApiError(error)) {
        setFormError('Something went wrong. Please try again.');
        return;
      }

      const apiError: ApiError = error;
      let matchedAny = false;

      for (const [field, message] of Object.entries(apiError.fieldErrors)) {
        const path = field as Path<TValues>;
        if (!knownFields.includes(path)) continue;
        setError(path, { type: 'server', message });
        matchedAny = true;
      }

      // A validation error whose fields we do not render would otherwise fail
      // silently, so it still surfaces as a banner.
      setFormError(matchedAny ? null : apiError.message);
    },
    [setError, knownFields],
  );

  return { formError, clearFormError, handleApiError };
}
