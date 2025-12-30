import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import moment from 'moment';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';

import { COMMON_CONSTANT } from '@n-constants';
import { LoggingModel } from '@n-models';
import { logger } from '@n-utils';
import { BaseException } from '../filter-exceptions';

export interface Response<T> {
  message: string;
  statusCode: number;
  result: T;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, Response<T>> {
  private readonly logger = logger({
    infoFile: 'response-info.log',
    errorFile: 'response-error.log',
  });

  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    return next.handle().pipe(
      map((res: T) => this.responseHandler(res, context)),
      catchError((error) => throwError(() => error)),
    );
  }

  responseHandler(res: T, context: ExecutionContext): Response<T> {
    if (res instanceof BaseException) {
      throw res;
    }

    const ctx = context.switchToHttp();
    const request = ctx.getRequest();
    const requestId = uuidv4();

    // Custom replacer to handle BigInt serialization
    const bigIntReplacer = (key: string, value: any) => 
      typeof value === 'bigint' ? value.toString() : value;

    const rawReqBody = request.body;
    const rawResBody = typeof res === 'object' ? JSON.parse(JSON.stringify(res, bigIntReplacer)) : res;

    const requestBody = typeof rawReqBody === 'object' ? JSON.parse(JSON.stringify(rawReqBody, bigIntReplacer)) : rawReqBody;
    const responseBody = rawResBody;

    const responseLog: LoggingModel = {
      timestamp: moment().format(COMMON_CONSTANT.LOG_TIMESTAMP_FORMAT),
      id: requestId,
      request: {
        type: 'http',
        body: requestBody,
        ip: request.ip,
        userAgent: request.get('user-agent'),
        path: request?.path,
      },
      response: {
        body: responseBody,
      },
    };

    this.logger.info(responseLog);

    return {
      message: 'Success',
      statusCode: HttpStatus.OK,
      result: responseBody,
    };
  }
}

