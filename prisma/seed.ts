import { PrismaClient, AuthType, AccountStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create Roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: {},
    create: {
      name: 'Admin',
      description: 'Administrator with full access',
    },
  });

  const staffRole = await prisma.role.upsert({
    where: { name: 'Staff' },
    update: {},
    create: {
      name: 'Staff',
      description: 'Staff member with limited access',
    },
  });

  console.log('Roles created:', { adminRole, staffRole });

  // Create Permissions
  const permissions = [
    // Account permissions
    { name: 'account:create', description: 'Create accounts' },
    { name: 'account:read', description: 'Read accounts' },
    { name: 'account:update', description: 'Update accounts' },
    { name: 'account:delete', description: 'Delete accounts' },
    { name: 'account:claim', description: 'Claim accounts' },
    { name: 'account:release', description: 'Release accounts' },
    { name: 'account:report_error', description: 'Report account errors' },
    { name: 'account:import', description: 'Import accounts' },
    { name: 'account:view_password', description: 'View account passwords' },
    { name: 'account:view_all', description: 'View all accounts' },
    // User permissions
    { name: 'user:create', description: 'Create users' },
    { name: 'user:read', description: 'Read users' },
    { name: 'user:update', description: 'Update users' },
    { name: 'user:delete', description: 'Delete users' },
    { name: 'user:view_all', description: 'View all users' },
    // Audit permissions
    { name: 'audit:read', description: 'Read audit logs' },
    { name: 'audit:view_all', description: 'View all audit logs' },
    // Notification permissions
    { name: 'notification:read', description: 'Read notifications' },
    { name: 'notification:update', description: 'Update notifications' },
    { name: 'notification:delete', description: 'Delete notifications' },
  ];

  const createdPermissions = [];
  for (const perm of permissions) {
    const permission = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
    createdPermissions.push(permission);
  }

  console.log(`Created ${createdPermissions.length} permissions`);

  // Assign all permissions to Admin role
  for (const permission of createdPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: {
        roleId: adminRole.id,
        permissionId: permission.id,
      },
    });
  }

  // Assign limited permissions to Staff role
  const staffPermissions = [
    'account:read',
    'account:claim',
    'account:release',
    'account:report_error',
    'account:view_password',
    'notification:read',
    'notification:update',
  ];

  for (const permName of staffPermissions) {
    const permission = createdPermissions.find(p => p.name === permName);
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: staffRole.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: staffRole.id,
          permissionId: permission.id,
        },
      });
    }
  }

  console.log('Permissions assigned to roles');

  // Create Admin User
  const hashedPassword = await bcrypt.hash('admin123', 10);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@aams.com' },
    update: {},
    create: {
      email: 'admin@aams.com',
      name: 'Admin User',
      password: hashedPassword,
      authType: AuthType.EMAIL,
      roleId: adminRole.id,
    },
  });

  console.log('Admin user created:', adminUser.email);

  // Create Staff User
  const staffPassword = await bcrypt.hash('staff123', 10);
  const staffUser = await prisma.user.upsert({
    where: { email: 'staff@aams.com' },
    update: {},
    create: {
      email: 'staff@aams.com',
      name: 'Staff User',
      password: staffPassword,
      authType: AuthType.EMAIL,
      roleId: staffRole.id,
    },
  });

  console.log('Staff user created:', staffUser.email);

  console.log('Seeding completed!');
  console.log('Admin credentials: admin@aams.com / admin123');
  console.log('Staff credentials: staff@aams.com / staff123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

