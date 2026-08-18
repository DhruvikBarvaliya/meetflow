import { useCallback, useState } from 'react';
import { useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/apiClient';

/**
 * Downloading the appointment export.
 *
 * The endpoint is authenticated, so a plain `<a href>` cannot fetch it — the
 * browser would send the request without the bearer token and get a 401 page
 * saved as a spreadsheet. The file is therefore fetched through the same axios
 * instance as everything else and handed to the browser as a blob.
 *
 * Two response headers are load-bearing:
 *
 *  - `Content-Disposition` carries the filename the server chose, which already
 *    encodes the workspace and the period. Rebuilding it here would let the two
 *    drift.
 *  - `X-Report-Truncated` says whether the row cap cut the file short. A
 *    truncated export that looks complete is the worst possible outcome for a
 *    record-keeping tool, so it is reported rather than swallowed.
 */

const FILENAME_PATTERN = /filename="?([^"]+)"?/i;

function filenameFrom(disposition: unknown, fallback: string): string {
  if (typeof disposition !== 'string') return fallback;
  return FILENAME_PATTERN.exec(disposition)?.[1] ?? fallback;
}

export interface CsvExport {
  download: (url: string, fallbackFilename: string) => Promise<void>;
  isExporting: boolean;
}

export function useCsvExport(): CsvExport {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const download = useCallback(
    async (url: string, fallbackFilename: string) => {
      setIsExporting(true);
      try {
        const response = await http.get<Blob>(url, { responseType: 'blob' });
        const filename = filenameFrom(response.headers['content-disposition'], fallbackFilename);

        const objectUrl = URL.createObjectURL(response.data);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Freed on the next tick: revoking synchronously races the browser's
        // own read of the URL in some engines.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

        const truncated = response.headers['x-report-truncated'] === 'true';
        const matched = response.headers['x-report-matched-rows'];

        toast({
          tone: truncated ? 'warning' : 'success',
          title: truncated ? 'Export truncated' : 'Export downloaded',
          description: truncated
            ? `${String(matched)} rows matched, more than one file may hold. Narrow the window and export again.`
            : filename,
        });
      } catch (error) {
        // A failed blob request carries its error envelope *as a blob*, so the
        // usual message is unreadable here; the status is what is left to go on.
        const apiError = ApiError.from(error);
        toast({
          tone: 'error',
          title: 'Could not export',
          description: apiError.isForbidden
            ? 'Your role can read this report but not take a copy of it.'
            : apiError.status === 0
              ? apiError.message
              : 'The export failed. Narrow the window and try again.',
        });
      } finally {
        setIsExporting(false);
      }
    },
    [toast],
  );

  return { download, isExporting };
}
