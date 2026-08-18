/**
 * Model registry and association graph.
 *
 * Every model file defines its own columns; this file is the single place where
 * relationships are declared, so the shape of the domain can be read in one
 * sitting instead of being reconstructed from forty files.
 *
 * Aliases are explicit and stable (`as: 'staffProfile'`, not Sequelize's
 * pluralisation guesswork) because they appear in `include` clauses across the
 * whole service layer and in the JSON the API returns.
 */
import { sequelize } from '../../config/database';

import { Appointment } from './Appointment';
import { AppointmentParticipant } from './AppointmentParticipant';
import { AppointmentResource } from './AppointmentResource';
import { AppointmentStaff } from './AppointmentStaff';
import { AppointmentStatusHistory } from './AppointmentStatusHistory';
import { AuditLog } from './AuditLog';
import { AutomationExecution } from './AutomationExecution';
import { AutomationRule } from './AutomationRule';
import { AvailabilityOverride } from './AvailabilityOverride';
import { BlackoutPeriod } from './BlackoutPeriod';
import { BookingLink } from './BookingLink';
import { BookingLinkService } from './BookingLinkService';
import { Business } from './Business';
import { BusinessHours } from './BusinessHours';
import { BusinessSettings } from './BusinessSettings';
import { Customer } from './Customer';
import { Holiday } from './Holiday';
import { IdempotencyKey } from './IdempotencyKey';
import { Location } from './Location';
import { Membership } from './Membership';
import { MembershipPermission } from './MembershipPermission';
import { Notification } from './Notification';
import { NotificationTemplate } from './NotificationTemplate';
import { Permission } from './Permission';
import { RefreshToken } from './RefreshToken';
import { RescheduleHistory } from './RescheduleHistory';
import { Resource } from './Resource';
import { Role } from './Role';
import { RolePermission } from './RolePermission';
import { Service } from './Service';
import { ServiceCategory } from './ServiceCategory';
import { ServiceLocation } from './ServiceLocation';
import { ServiceResourceRequirement } from './ServiceResourceRequirement';
import { ServiceStaff } from './ServiceStaff';
import { StaffAvailabilityRule } from './StaffAvailabilityRule';
import { StaffProfile } from './StaffProfile';
import { Team } from './Team';
import { TeamMember } from './TeamMember';
import { User } from './User';
import { WaitlistEntry } from './WaitlistEntry';
import { WebhookDelivery } from './WebhookDelivery';
import { WebhookEndpoint } from './WebhookEndpoint';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens', onDelete: 'CASCADE' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Membership, { foreignKey: 'userId', as: 'memberships' });
Membership.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Business, { foreignKey: 'ownerUserId', as: 'ownedBusinesses' });
Business.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner' });

// ---------------------------------------------------------------------------
// Tenant configuration
// ---------------------------------------------------------------------------
Business.hasOne(BusinessSettings, {
  foreignKey: 'businessId',
  as: 'settings',
  onDelete: 'CASCADE',
});
BusinessSettings.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(Membership, { foreignKey: 'businessId', as: 'memberships' });
Membership.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(Role, { foreignKey: 'businessId', as: 'roles' });
Role.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Membership.belongsTo(Role, { foreignKey: 'roleId', as: 'role' });
Role.hasMany(Membership, { foreignKey: 'roleId', as: 'memberships' });

Role.belongsToMany(Permission, {
  through: RolePermission,
  foreignKey: 'roleId',
  otherKey: 'permissionId',
  as: 'permissions',
});
Permission.belongsToMany(Role, {
  through: RolePermission,
  foreignKey: 'permissionId',
  otherKey: 'roleId',
  as: 'roles',
});

// Per-member GRANT/DENY overrides layered on top of the role.
Membership.belongsToMany(Permission, {
  through: MembershipPermission,
  foreignKey: 'membershipId',
  otherKey: 'permissionId',
  as: 'permissionOverrides',
});
Membership.hasMany(MembershipPermission, {
  foreignKey: 'membershipId',
  as: 'permissionOverrideRows',
});
MembershipPermission.belongsTo(Membership, { foreignKey: 'membershipId', as: 'membership' });
MembershipPermission.belongsTo(Permission, { foreignKey: 'permissionId', as: 'permission' });

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------
Business.hasMany(Location, { foreignKey: 'businessId', as: 'locations' });
Location.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(Team, { foreignKey: 'businessId', as: 'teams' });
Team.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(StaffProfile, { foreignKey: 'businessId', as: 'staffProfiles' });
StaffProfile.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
StaffProfile.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(StaffProfile, { foreignKey: 'userId', as: 'staffProfiles' });
StaffProfile.belongsTo(Membership, { foreignKey: 'membershipId', as: 'membership' });
Membership.hasOne(StaffProfile, { foreignKey: 'membershipId', as: 'staffProfile' });
StaffProfile.belongsTo(Location, { foreignKey: 'defaultLocationId', as: 'defaultLocation' });

Team.belongsToMany(StaffProfile, {
  through: TeamMember,
  foreignKey: 'teamId',
  otherKey: 'staffProfileId',
  as: 'members',
});
StaffProfile.belongsToMany(Team, {
  through: TeamMember,
  foreignKey: 'staffProfileId',
  otherKey: 'teamId',
  as: 'teams',
});
Team.hasMany(TeamMember, { foreignKey: 'teamId', as: 'teamMembers' });
TeamMember.belongsTo(Team, { foreignKey: 'teamId', as: 'team' });
TeamMember.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
StaffProfile.hasMany(TeamMember, { foreignKey: 'staffProfileId', as: 'teamMemberships' });

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
Business.hasMany(ServiceCategory, { foreignKey: 'businessId', as: 'serviceCategories' });
ServiceCategory.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(Service, { foreignKey: 'businessId', as: 'services' });
Service.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Service.belongsTo(ServiceCategory, { foreignKey: 'categoryId', as: 'category' });
ServiceCategory.hasMany(Service, { foreignKey: 'categoryId', as: 'services' });

Service.belongsToMany(StaffProfile, {
  through: ServiceStaff,
  foreignKey: 'serviceId',
  otherKey: 'staffProfileId',
  as: 'staff',
});
StaffProfile.belongsToMany(Service, {
  through: ServiceStaff,
  foreignKey: 'staffProfileId',
  otherKey: 'serviceId',
  as: 'services',
});
Service.hasMany(ServiceStaff, { foreignKey: 'serviceId', as: 'staffAssignments' });
ServiceStaff.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
ServiceStaff.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
StaffProfile.hasMany(ServiceStaff, { foreignKey: 'staffProfileId', as: 'serviceAssignments' });

Service.belongsToMany(Location, {
  through: ServiceLocation,
  foreignKey: 'serviceId',
  otherKey: 'locationId',
  as: 'locations',
});
Location.belongsToMany(Service, {
  through: ServiceLocation,
  foreignKey: 'locationId',
  otherKey: 'serviceId',
  as: 'services',
});
Service.hasMany(ServiceLocation, { foreignKey: 'serviceId', as: 'locationAssignments' });
ServiceLocation.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
ServiceLocation.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });

Business.hasMany(Resource, { foreignKey: 'businessId', as: 'resources' });
Resource.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Resource.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(Resource, { foreignKey: 'locationId', as: 'resources' });

Service.hasMany(ServiceResourceRequirement, {
  foreignKey: 'serviceId',
  as: 'resourceRequirements',
});
ServiceResourceRequirement.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
ServiceResourceRequirement.belongsTo(Resource, { foreignKey: 'resourceId', as: 'resource' });

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------
Business.hasMany(BusinessHours, { foreignKey: 'businessId', as: 'businessHours' });
BusinessHours.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
BusinessHours.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(BusinessHours, { foreignKey: 'locationId', as: 'businessHours' });

Business.hasMany(StaffAvailabilityRule, { foreignKey: 'businessId', as: 'staffAvailabilityRules' });
StaffAvailabilityRule.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
StaffProfile.hasMany(StaffAvailabilityRule, {
  foreignKey: 'staffProfileId',
  as: 'availabilityRules',
});
StaffAvailabilityRule.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
StaffAvailabilityRule.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });

Business.hasMany(AvailabilityOverride, { foreignKey: 'businessId', as: 'availabilityOverrides' });
AvailabilityOverride.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
StaffProfile.hasMany(AvailabilityOverride, {
  foreignKey: 'staffProfileId',
  as: 'availabilityOverrides',
});
AvailabilityOverride.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
AvailabilityOverride.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
AvailabilityOverride.belongsTo(Resource, { foreignKey: 'resourceId', as: 'resource' });

Business.hasMany(Holiday, { foreignKey: 'businessId', as: 'holidays' });
Holiday.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Holiday.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });

Business.hasMany(BlackoutPeriod, { foreignKey: 'businessId', as: 'blackoutPeriods' });
BlackoutPeriod.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
BlackoutPeriod.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
BlackoutPeriod.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
BlackoutPeriod.belongsTo(Resource, { foreignKey: 'resourceId', as: 'resource' });
StaffProfile.hasMany(BlackoutPeriod, { foreignKey: 'staffProfileId', as: 'blackoutPeriods' });
Resource.hasMany(BlackoutPeriod, { foreignKey: 'resourceId', as: 'blackoutPeriods' });

// ---------------------------------------------------------------------------
// Customers and booking links
// ---------------------------------------------------------------------------
Business.hasMany(Customer, { foreignKey: 'businessId', as: 'customers' });
Customer.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Customer.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(Customer, { foreignKey: 'userId', as: 'customerProfiles' });
Customer.belongsTo(StaffProfile, { foreignKey: 'preferredStaffProfileId', as: 'preferredStaff' });
Customer.belongsTo(Location, { foreignKey: 'preferredLocationId', as: 'preferredLocation' });

Business.hasMany(BookingLink, { foreignKey: 'businessId', as: 'bookingLinks' });
BookingLink.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
BookingLink.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
BookingLink.belongsTo(Team, { foreignKey: 'teamId', as: 'team' });
BookingLink.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
BookingLink.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });

BookingLink.belongsToMany(Service, {
  through: BookingLinkService,
  foreignKey: 'bookingLinkId',
  otherKey: 'serviceId',
  as: 'services',
});
Service.belongsToMany(BookingLink, {
  through: BookingLinkService,
  foreignKey: 'serviceId',
  otherKey: 'bookingLinkId',
  as: 'bookingLinks',
});
BookingLink.hasMany(BookingLinkService, { foreignKey: 'bookingLinkId', as: 'serviceLinks' });
BookingLinkService.belongsTo(BookingLink, { foreignKey: 'bookingLinkId', as: 'bookingLink' });
BookingLinkService.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
Business.hasMany(Appointment, { foreignKey: 'businessId', as: 'appointments' });
Appointment.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Appointment.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
Service.hasMany(Appointment, { foreignKey: 'serviceId', as: 'appointments' });
Appointment.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(Appointment, { foreignKey: 'locationId', as: 'appointments' });
Appointment.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
StaffProfile.hasMany(Appointment, { foreignKey: 'staffProfileId', as: 'appointments' });
Appointment.belongsTo(Team, { foreignKey: 'teamId', as: 'team' });
Appointment.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
Customer.hasMany(Appointment, { foreignKey: 'customerId', as: 'appointments' });
Appointment.belongsTo(BookingLink, { foreignKey: 'bookingLinkId', as: 'bookingLink' });
BookingLink.hasMany(Appointment, { foreignKey: 'bookingLinkId', as: 'appointments' });
Appointment.belongsTo(User, { foreignKey: 'createdByUserId', as: 'createdBy' });
Appointment.belongsTo(User, { foreignKey: 'cancelledByUserId', as: 'cancelledBy' });
// Self-reference: the appointment this one superseded, if any.
Appointment.belongsTo(Appointment, { foreignKey: 'rescheduledFromId', as: 'rescheduledFrom' });

Appointment.hasMany(AppointmentStaff, {
  foreignKey: 'appointmentId',
  as: 'staffReservations',
  onDelete: 'CASCADE',
});
AppointmentStaff.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
AppointmentStaff.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
StaffProfile.hasMany(AppointmentStaff, { foreignKey: 'staffProfileId', as: 'reservations' });

Appointment.hasMany(AppointmentParticipant, {
  foreignKey: 'appointmentId',
  as: 'participants',
  onDelete: 'CASCADE',
});
AppointmentParticipant.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
AppointmentParticipant.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
Customer.hasMany(AppointmentParticipant, { foreignKey: 'customerId', as: 'participations' });

Appointment.hasMany(AppointmentResource, {
  foreignKey: 'appointmentId',
  as: 'resourceReservations',
  onDelete: 'CASCADE',
});
AppointmentResource.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
AppointmentResource.belongsTo(Resource, { foreignKey: 'resourceId', as: 'resource' });
Resource.hasMany(AppointmentResource, { foreignKey: 'resourceId', as: 'reservations' });

Appointment.hasMany(AppointmentStatusHistory, {
  foreignKey: 'appointmentId',
  as: 'statusHistory',
  onDelete: 'CASCADE',
});
AppointmentStatusHistory.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
AppointmentStatusHistory.belongsTo(User, { foreignKey: 'actorUserId', as: 'actor' });

Appointment.hasMany(RescheduleHistory, {
  foreignKey: 'appointmentId',
  as: 'rescheduleHistory',
  onDelete: 'CASCADE',
});
RescheduleHistory.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
RescheduleHistory.belongsTo(User, { foreignKey: 'actorUserId', as: 'actor' });

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------
Business.hasMany(WaitlistEntry, { foreignKey: 'businessId', as: 'waitlistEntries' });
WaitlistEntry.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
WaitlistEntry.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
Customer.hasMany(WaitlistEntry, { foreignKey: 'customerId', as: 'waitlistEntries' });
WaitlistEntry.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });
Service.hasMany(WaitlistEntry, { foreignKey: 'serviceId', as: 'waitlistEntries' });
WaitlistEntry.belongsTo(StaffProfile, { foreignKey: 'staffProfileId', as: 'staffProfile' });
WaitlistEntry.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
WaitlistEntry.belongsTo(Appointment, {
  foreignKey: 'convertedAppointmentId',
  as: 'convertedAppointment',
});

// ---------------------------------------------------------------------------
// Notifications and automation
// ---------------------------------------------------------------------------
Business.hasMany(NotificationTemplate, { foreignKey: 'businessId', as: 'notificationTemplates' });
NotificationTemplate.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

Business.hasMany(Notification, { foreignKey: 'businessId', as: 'notifications' });
Notification.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
Notification.belongsTo(Customer, { foreignKey: 'recipientCustomerId', as: 'recipientCustomer' });
Notification.belongsTo(User, { foreignKey: 'recipientUserId', as: 'recipientUser' });
Notification.belongsTo(Appointment, { foreignKey: 'appointmentId', as: 'appointment' });
Appointment.hasMany(Notification, { foreignKey: 'appointmentId', as: 'notifications' });
Notification.belongsTo(WaitlistEntry, { foreignKey: 'waitlistEntryId', as: 'waitlistEntry' });

Business.hasMany(AutomationRule, { foreignKey: 'businessId', as: 'automationRules' });
AutomationRule.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
AutomationRule.hasMany(AutomationExecution, { foreignKey: 'ruleId', as: 'executions' });
AutomationExecution.belongsTo(AutomationRule, { foreignKey: 'ruleId', as: 'rule' });
AutomationExecution.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

// ---------------------------------------------------------------------------
// Audit and webhooks
// ---------------------------------------------------------------------------
Business.hasMany(AuditLog, { foreignKey: 'businessId', as: 'auditLogs' });
AuditLog.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
AuditLog.belongsTo(User, { foreignKey: 'actorUserId', as: 'actorUser' });
AuditLog.belongsTo(Customer, { foreignKey: 'actorCustomerId', as: 'actorCustomer' });

Business.hasMany(WebhookEndpoint, { foreignKey: 'businessId', as: 'webhookEndpoints' });
WebhookEndpoint.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });
WebhookEndpoint.hasMany(WebhookDelivery, { foreignKey: 'endpointId', as: 'deliveries' });
WebhookDelivery.belongsTo(WebhookEndpoint, { foreignKey: 'endpointId', as: 'endpoint' });
WebhookDelivery.belongsTo(Business, { foreignKey: 'businessId', as: 'business' });

export {
  sequelize,
  Appointment,
  AppointmentParticipant,
  AppointmentResource,
  AppointmentStaff,
  AppointmentStatusHistory,
  AuditLog,
  AutomationExecution,
  AutomationRule,
  AvailabilityOverride,
  BlackoutPeriod,
  BookingLink,
  BookingLinkService,
  Business,
  BusinessHours,
  BusinessSettings,
  Customer,
  Holiday,
  IdempotencyKey,
  Location,
  Membership,
  MembershipPermission,
  Notification,
  NotificationTemplate,
  Permission,
  RefreshToken,
  RescheduleHistory,
  Resource,
  Role,
  RolePermission,
  Service,
  ServiceCategory,
  ServiceLocation,
  ServiceResourceRequirement,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
  Team,
  TeamMember,
  User,
  WaitlistEntry,
  WebhookDelivery,
  WebhookEndpoint,
};

/** Registry used by the schema-parity check in tests and by tooling. */
export const models = {
  Appointment,
  AppointmentParticipant,
  AppointmentResource,
  AppointmentStaff,
  AppointmentStatusHistory,
  AuditLog,
  AutomationExecution,
  AutomationRule,
  AvailabilityOverride,
  BlackoutPeriod,
  BookingLink,
  BookingLinkService,
  Business,
  BusinessHours,
  BusinessSettings,
  Customer,
  Holiday,
  IdempotencyKey,
  Location,
  Membership,
  MembershipPermission,
  Notification,
  NotificationTemplate,
  Permission,
  RefreshToken,
  RescheduleHistory,
  Resource,
  Role,
  RolePermission,
  Service,
  ServiceCategory,
  ServiceLocation,
  ServiceResourceRequirement,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
  Team,
  TeamMember,
  User,
  WaitlistEntry,
  WebhookDelivery,
  WebhookEndpoint,
} as const;
