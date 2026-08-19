/**
 * Shared pieces of the management surface.
 *
 * One import site so a page never has to know which file a helper lives in.
 * Everything here is built on `@/components/ui` and the design tokens — nothing
 * in this folder defines a colour, a spacing value or a control of its own.
 */

export { AppointmentActions, type AppointmentActionsProps } from './AppointmentActions';
export {
  AppointmentDetailDrawer,
  type AppointmentDetailDrawerProps,
} from './AppointmentDetailDrawer';
export {
  BookAppointmentDrawer,
  type BookAppointmentDrawerProps,
  type BookedAppointment,
} from './BookAppointmentDrawer';
export {
  EventBlock,
  MonthGrid,
  TimeGrid,
  hourWindow,
  layoutDay,
  type MonthGridProps,
  type TimeGridProps,
} from './CalendarViews';
export {
  ChartFrame,
  ChartTooltip,
  type ChartDataTable,
  type ChartFrameProps,
  type ChartTooltipProps,
} from './ChartFrame';
export {
  seriesColour,
  sequentialColour,
  useAxisStyle,
  useChartTheme,
  type ChartTheme,
} from './chartTheme';
export { CopyButton, CopyableUrl, type CopyButtonProps } from './CopyButton';
export { DataState, type DataStateProps } from './DataState';
export { FilterBar, FilterField, SearchField, useDebouncedValue } from './filters';
export { FormDrawer, type FormDrawerProps } from './FormDrawer';
export { minorUnitDigits, priceStep, toMajorUnits, toMinorUnits } from './money';
export {
  MAX_RANGE_DAYS,
  RangeControl,
  defaultRange,
  rangeSpanDays,
  type DateRange,
  type RangeControlProps,
} from './RangeControl';
export { RescheduleDialog, type RescheduleTarget } from './RescheduleDialog';
export { StatTile, StatTileGrid, type StatTileProps } from './StatTile';
export {
  ActiveBadge,
  AppointmentStatusBadge,
  CustomerStatusBadge,
  MembershipStatusBadge,
  WaitlistStatusBadge,
} from './StatusBadge';
export { ownerKeys, toSearchParams, type QueryScope } from './queryKeys';
export {
  TRANSITION_SPECS,
  availableTransitions,
  useAppointmentActions,
  type TransitionAction,
} from './useAppointmentActions';
export { useCsvExport, type CsvExport } from './useCsvExport';
export { APPOINTMENT_EVENTS, useInvalidatePrefix, useLiveRefresh } from './useLiveRefresh';
export {
  DAY_NAMES,
  MINUTES_PER_DAY,
  WEEK_ORDER,
  WeeklyWindowEditor,
  clockToMinutes,
  minutesToClock,
  newWindowKey,
  type WeeklyWindow,
  type WeeklyWindowEditorProps,
} from './WeeklyWindowEditor';
export {
  filterOptions,
  useLocationsLookup,
  useResourcesLookup,
  useServiceCategoriesLookup,
  useServicesLookup,
  useStaffLookup,
  useTeamsLookup,
  type LookupList,
} from './useWorkspaceLookups';
export * from './types';
