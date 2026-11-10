/**
 * The one place the app asks "what time is it?".
 * Injectable so tests and the eval/seed scripts can create conversations
 * "on 3 November" and then ask about them "on 10 November".
 */
let fixed: Date | null = process.env.HINDSIGHT_NOW ? new Date(process.env.HINDSIGHT_NOW) : null;

export const clock = {
  now(): Date {
    return fixed ? new Date(fixed) : new Date();
  },
  set(date: Date | null): void {
    fixed = date ? new Date(date) : null;
  },
};
