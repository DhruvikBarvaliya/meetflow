import { Hammer, type LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export interface PlaceholderPageProps {
  title: string;
  description: string;
  icon?: LucideIcon;
}

/**
 * A page that exists so the router and the navigation are complete before the
 * feature behind them is.
 *
 * It renders nothing that looks like data — no zeroed counters, no dashes in a
 * table — because a placeholder metric is indistinguishable from a real one
 * that happens to be empty, and that is exactly the confusion a scheduling
 * product cannot afford.
 */
export function PlaceholderPage({
  title,
  description,
  icon: Icon = Hammer,
}: PlaceholderPageProps): JSX.Element {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <EmptyState
          icon={<Icon className="size-6" aria-hidden={true} />}
          title={`${title} is not available yet`}
          description="This area of MeetFlow is still being built. Nothing is shown here rather than a stand-in, so you are never looking at a number that is not real."
        />
      </Card>
    </>
  );
}

/** Builds the default export a lazily-loaded route module needs. */
export function createPlaceholderPage(props: PlaceholderPageProps): () => JSX.Element {
  return function Placeholder(): JSX.Element {
    return <PlaceholderPage {...props} />;
  };
}
