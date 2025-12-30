import { AccountPermission } from './account-permission.enum';
import { UserPermission } from './user-permission.enum';
import { AuditPermission } from './audit-permission.enum';
import { NotificationPermission } from './notification-permission.enum';

export const AamsPermission = {
  ...AccountPermission,
  ...UserPermission,
  ...AuditPermission,
  ...NotificationPermission,
};

export type AamsPermissionType =
  | AccountPermission
  | UserPermission
  | AuditPermission
  | NotificationPermission;

