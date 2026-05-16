/**
 * Cron expression utilities for validation and preview
 */

import * as parser from 'cron-parser';

/**
 * Validate a cron expression
 */
export function validateCronExpression(cron: string): { valid: boolean; error?: string } {
  try {
    parser.parseExpression(cron);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression'
    };
  }
}

/**
 * Get the next run time for a cron expression
 */
export function getNextRunTime(cron: string, timezone?: string): Date | undefined {
  try {
    const options: parser.ParserOptions = {};
    if (timezone) {
      options.tz = timezone;
    }
    const interval = parser.parseExpression(cron, options);
    return interval.next().toDate();
  } catch {
    return undefined;
  }
}

/**
 * Get a human-readable description of a cron expression
 */
export function getCronDescription(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) {
    return 'Invalid cron expression';
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (cron === '0 0 * * *') {
    return 'Daily at midnight';
  }
  if (cron === '0 0 * * 0') {
    return 'Weekly on Sunday at midnight';
  }
  if (cron === '0 0 1 * *') {
    return 'Monthly on the 1st at midnight';
  }
  if (cron === '0 0 * * 1') {
    return 'Weekly on Monday at midnight';
  }
  if (cron === '0 9 * * 1-5') {
    return 'Weekdays at 9:00 AM';
  }

  // Try to build a description
  let description = '';
  
  if (minute !== '*' && hour !== '*') {
    description = `At ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  } else if (hour !== '*') {
    description = `At ${hour.padStart(2, '0')}:00`;
  } else if (minute !== '*') {
    description = `Every hour at minute ${minute}`;
  } else {
    description = 'Every minute';
  }

  if (dayOfWeek !== '*') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (dayOfWeek.includes('-')) {
      const [start, end] = dayOfWeek.split('-').map(Number);
      description += ` on ${days[start]}-${days[end]}`;
    } else if (dayOfWeek.includes(',')) {
      const selectedDays = dayOfWeek.split(',').map(d => days[Number(d)]).join(', ');
      description += ` on ${selectedDays}`;
    } else {
      description += ` on ${days[Number(dayOfWeek)]}`;
    }
  } else if (dayOfMonth !== '*') {
    if (dayOfMonth.includes(',')) {
      description += ` on days ${dayOfMonth}`;
    } else {
      description += ` on day ${dayOfMonth} of the month`;
    }
  }

  if (month !== '*') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (month.includes(',')) {
      const selectedMonths = month.split(',').map(m => months[Number(m) - 1]).join(', ');
      description += ` in ${selectedMonths}`;
    } else {
      description += ` in ${months[Number(month) - 1]}`;
    }
  }

  return description || cron;
}

/**
 * Get next run time with human-readable format
 */
export function getNextRunTimeFormatted(cron: string, timezone?: string): string {
  const nextRun = getNextRunTime(cron, timezone);
  if (!nextRun) {
    return 'Invalid schedule';
  }
  return nextRun.toLocaleString();
}
