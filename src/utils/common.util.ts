import { COMMON_CONSTANT } from '@n-constants';
import moment from 'moment';
import 'moment-timezone';

export function makePaginationResponse(
  data: any,
  page: number,
  pageSize: number,
  total: number,
) {
  if (pageSize) {
    const limit = pageSize || COMMON_CONSTANT.DEFAULT_PAGE_SIZE;

    return {
      page: page || COMMON_CONSTANT.DEFAULT_PAGE,
      pageSize: limit,
      totalPage: Math.ceil(total / limit),
      total,
      data,
    };
  }
  return {
    page: COMMON_CONSTANT.DEFAULT_PAGE,
    pageSize: 0,
    totalPage: 1,
    total,
    data,
  };
}

export function isValidDateRange(startDate: string, endDate: string): boolean {
  const start = new Date(startDate);
  const end = new Date(endDate);

  return start <= end;
}

// random string
export function randomString(length: number = 32) {
  return Math.random().toString(36).substring(2, length + 2);
}

// convert date to vietnam timezone
export function convertToVietnamTimezone(date: Date) {
  return moment(date).tz('Asia/Ho_Chi_Minh').toDate();
}

// Get date string (YYYY-MM-DD) in Vietnam timezone
export function getVietnamDateString(date: Date = new Date()): string {
  return moment(date).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
}

// Get current hour in Vietnam timezone (0-23)
export function getVietnamHour(date: Date = new Date()): number {
  return moment(date).tz('Asia/Ho_Chi_Minh').hour();
}

// Get current minute in Vietnam timezone (0-59)
export function getVietnamMinute(date: Date = new Date()): number {
  return moment(date).tz('Asia/Ho_Chi_Minh').minute();
}

// Get moment object in Vietnam timezone
export function getVietnamMoment(date: Date = new Date()) {
  return moment(date).tz('Asia/Ho_Chi_Minh');
}

export function getDateAgo(days: number) {
  const date = new Date();
  const startDate = new Date(date.setDate(date.getDate() - days));
  return startDate;
}

// remove keys from object
export function removeKeys(obj: any, keys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
}

export function collectAcceptKeys(obj: any, keys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => keys.includes(key)));
}

