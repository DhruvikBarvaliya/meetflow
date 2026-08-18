import { useId, type FormEventHandler, type ReactNode } from 'react';
import { Button, Drawer } from '@/components/ui';
import { FormBanner } from '@/pages/auth/FormBanner';

export interface FormDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  isSubmitting: boolean;
  /** Form-level failure, from `useFormApiError`. */
  formError: string | null;
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

/**
 * A side sheet containing one form.
 *
 * The submit button lives in the drawer's footer but belongs to the form, which
 * is what the `form` attribute is for: nesting the footer inside the `<form>`
 * would put a scrolling region inside a flex column that has to stay pinned,
 * and moving the button into the body would bury Save below a long form.
 *
 * The backdrop does not dismiss — a stray click must not discard a half-filled
 * record — and Escape still does, because that is a deliberate act.
 */
export function FormDrawer({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  isSubmitting,
  formError,
  width = 'md',
  children,
}: FormDrawerProps): JSX.Element {
  const formId = useId();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width={width}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormBanner message={formError} />
        {children}
      </form>
    </Drawer>
  );
}
