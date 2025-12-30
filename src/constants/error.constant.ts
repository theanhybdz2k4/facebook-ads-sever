import { HttpStatus } from '@nestjs/common';

export const Errors = {
  TOO_MANY_REQUESTS: {
    message: 'Too many requests',
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    errorCode: 'CO01',
  },
  DEFAULT: {
    message: 'An error occurred. Please try again later',
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: 'CO02',
  },
  INVALID_INPUT: {
    message: 'Invalid input. Please check your input data',
    statusCode: HttpStatus.BAD_REQUEST,
    errorCode: 'CO03',
  },
  RESOURCE_NOT_FOUND: {
    message: 'The requested resource was not found',
    statusCode: HttpStatus.NOT_FOUND,
    errorCode: 'CO04',
  },
  UPLOAD_FILE_FAILED: {
    message: 'There was an error with the uploading of the file. Please try again later',
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: 'CO05',
  },
  VALIDATION_ERROR: {
    message: 'Validation failed. Please check your input data',
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    errorCode: 'CO06',
  },
  AUTH: {
    ROLE_NOT_PERMIT: {
      message: 'This user role is not permitted in our system!',
      statusCode: HttpStatus.FORBIDDEN,
      errorCode: 'AU01',
    },
    EMAIL_EXISTED: {
      message: 'This email already exists',
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'AU02',
    },
    EXPIRED_TOKEN: {
      message: 'Token has expired',
      statusCode: HttpStatus.UNAUTHORIZED,
      errorCode: 'AU03',
    },
    INVALID_TOKEN: {
      message: 'Invalid token in request',
      statusCode: HttpStatus.UNAUTHORIZED,
      errorCode: 'AU04',
    },
    INVALID_REFRESH_TOKEN: {
      message: 'Invalid refresh token in request',
      statusCode: HttpStatus.UNAUTHORIZED,
      errorCode: 'AU05',
    },
    INVALID_ROLE: {
      message: 'One or more of the provided role IDs are invalid',
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'AU06',
    },
    WRONG_CREDENTIALS: {
      message: 'Incorrect email or password',
      statusCode: HttpStatus.UNAUTHORIZED,
      errorCode: 'AU07',
    },
    WRONG_EMAIL: {
      message: 'Incorrect email',
      statusCode: HttpStatus.UNAUTHORIZED,
      errorCode: 'AU08',
    },
    USER_NOT_FOUND: {
      message: 'User not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'AU09',
    },
    USER_ARCHIVED: {
      message: 'Your account has been locked',
      statusCode: HttpStatus.FORBIDDEN,
      errorCode: 'AU10',
    },
  },
  ROLE: {
    ROLE_NAME_EXISTS: {
      message: 'The provided role name already exists',
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'R01',
    },
    PERMISSION_NOT_FOUND: {
      message: 'Permission not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'R02',
    },
    ROLE_NOT_FOUND: {
      message: 'Role not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'R03',
    },
  },
  ACCOUNT: {
    ACCOUNT_NOT_FOUND: {
      message: 'Account not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'AC01',
    },
    ACCOUNT_ALREADY_ASSIGNED: {
      message: 'Account is already assigned to another user',
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'AC02',
    },
    ACCOUNT_NOT_AVAILABLE: {
      message: 'Account is not available for claiming',
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'AC03',
    },
    ACCOUNT_CLAIM_LIMIT_EXCEEDED: {
      message: 'You have reached the maximum number of accounts you can claim',
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'AC04',
    },
    ACCOUNT_NOT_OWNED: {
      message: 'You do not own this account',
      statusCode: HttpStatus.FORBIDDEN,
      errorCode: 'AC05',
    },
    INVALID_PASSWORD: {
      message: 'Invalid password provided',
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'AC06',
    },
    ACCOUNT_ALREADY_EXISTS: {
      message: 'Account with this username already exists',
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'AC07',
    },
    IMPORT_FAILED: {
      message: 'Failed to import accounts from file',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'AC08',
    },
  },
  USER: {
    USER_NOT_FOUND: {
      message: 'User not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'U01',
    },
    USER_ALREADY_EXISTS: {
      message: 'User with this email already exists',
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'U02',
    },
  },
  AUDIT: {
    AUDIT_LOG_NOT_FOUND: {
      message: 'Audit log not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'AL01',
    },
  },
  NOTIFICATION: {
    NOTIFICATION_NOT_FOUND: {
      message: 'Notification not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'N01',
    },
  },
};

