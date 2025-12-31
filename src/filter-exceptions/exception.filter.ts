import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Request, Response } from 'express';
import moment from 'moment';
import { v4 as uuidv4 } from 'uuid';

import { COMMON_CONSTANT, Errors } from '@n-constants';
import { LoggingModel } from '@n-models';
import { logger } from '@n-utils';
import { Socket } from 'socket.io';

export type Exceptions = BaseException | BaseWsException | HttpException;

export interface BaseErrorFormat {
  message: string;
  statusCode: number;
  errorCode: string;
}

export class BaseException extends HttpException {
  constructor(response: BaseErrorFormat, cause?: any) {
    super(response, response.statusCode || HttpStatus.INTERNAL_SERVER_ERROR);
    this.stack = cause;
  }
}

export class BaseWsException extends WsException {
  private readonly errorCode: string;

  constructor(response: BaseErrorFormat, cause?: any) {
    super(response);
    this.errorCode = response.errorCode;
    if (cause) {
      this.stack = cause;
    }
  }

  getErrorCode(): string {
    return this.errorCode;
  }
}

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly loggerTerminal = new Logger('😟😕 AllExceptionFilter');

  private readonly logger = logger({
    infoFile: 'access-info.log',
    errorFile: 'access-error.log',
  });

  private readonly stacktraceEnabled: boolean;

  constructor() {
    this.stacktraceEnabled = Boolean(process.env.STACKTRACE_ENABLE);
  }

  catch(exception: Exceptions, host: ArgumentsHost) {
    const contextType = host.getType();
    const errorDetails = this.getErrorDetails(exception, contextType);
    console.log(exception);

    const errorLog = this.createErrorLog(errorDetails, contextType, host);
    this.logError(errorLog);

    return this.handleException(errorDetails, contextType, host);
  }

  private getErrorDetails(exception: unknown, contextType: string): BaseErrorFormat {
    let errorDetails: BaseErrorFormat;

    if (exception instanceof InternalServerErrorException || exception instanceof BadRequestException) {
      errorDetails = this.handleInternalOrBadRequestException(exception, contextType);
    } else if (exception instanceof HttpException || exception instanceof WsException || exception instanceof BaseException || exception instanceof BaseWsException) {
      errorDetails = this.handleHttpOrWsException(exception as Exceptions);
    } else {
      errorDetails = {
        message: exception instanceof Error ? exception.message : 'Internal server error',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: Errors.DEFAULT.errorCode,
      };
    }

    return errorDetails;
  }

  private handleInternalOrBadRequestException(exception: InternalServerErrorException | BadRequestException, contextType: string): BaseErrorFormat {
    if (contextType === 'http') {
      return new BaseException(Errors.DEFAULT, exception.stack).getResponse() as BaseErrorFormat;
    }
    return new BaseWsException(Errors.DEFAULT, exception.stack).getError() as BaseErrorFormat;
  }

  private handleHttpOrWsException(exception: Exceptions): BaseErrorFormat {
    if (exception instanceof BaseException) {
      return exception.getResponse() as BaseErrorFormat;
    }
    if (exception instanceof BaseWsException) {
      return exception.getError() as BaseErrorFormat;
    }
    
    // Handle standard NestJS HttpExceptions (UnauthorizedException, ForbiddenException, etc.)
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const status = exception.getStatus();
      
      if (typeof response === 'string') {
        return {
          message: response,
          statusCode: status,
          errorCode: `HTTP_${status}`,
        };
      }
      
      if (typeof response === 'object' && response !== null) {
        const responseObj = response as Record<string, any>;
        return {
          message: responseObj.message || 'An error occurred',
          statusCode: status,
          errorCode: responseObj.error || `HTTP_${status}`,
        };
      }
    }

    return Errors.DEFAULT;
  }

  private createErrorLog(errorDetails: BaseErrorFormat, contextType: string, host: ArgumentsHost): LoggingModel {
    const requestDetails = this.getRequestDetails(contextType, host);

    return {
      timestamp: moment().format(COMMON_CONSTANT.LOG_TIMESTAMP_FORMAT),
      id: uuidv4(),
      request: requestDetails,
      response: {
        body: this.stacktraceEnabled
          ? {
            ...errorDetails,
            stacktrace: errorDetails instanceof Object ? { ...errorDetails } : { message: errorDetails },
          }
          : errorDetails,
      },
    };
  }

  private getRequestDetails(contextType: string, host: ArgumentsHost): any {
    if (contextType === 'http') {
      const httpCtx = host.switchToHttp();
      const request = httpCtx.getRequest<Request>();
      const requestBody = request.body;

      return {
        type: 'http',
        method: request.method,
        path: request.path,
        ip: request.ip,
        userAgent: request.get('user-agent'),
        body: requestBody,
        params: request.params,
      };
    }
    const wsCtx = host.switchToWs();
    const client = wsCtx.getClient<Socket>();
    const data = wsCtx.getData();

    return {
      type: 'ws',
      clientId: client.id,
      data,
    };
  }

  private logError(errorLog: LoggingModel) {
    this.logger.error(JSON.stringify(errorLog));
    this.loggerTerminal.error(JSON.stringify(errorLog));
  }

  private handleException(errorDetails: BaseErrorFormat, contextType: string, host: ArgumentsHost) {
    if (contextType === 'http') {
      const httpCtx = host.switchToHttp();
      const response = httpCtx.getResponse<Response>();
      response.status(errorDetails.statusCode || HttpStatus.BAD_REQUEST).json(errorDetails);
    } else if (contextType === 'ws') {
      const wsCtx = host.switchToWs();
      const client = wsCtx.getClient<Socket>();
      client.emit('exception', errorDetails);
    }
  }
}

