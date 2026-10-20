import { describe, expect, it } from 'vitest';
import { isPgInputSyntaxError, isUniqueViolation } from './errorReporting.js';

const pgErr = (code: string, constraint_name?: string) =>
  Object.assign(new Error('invalid input syntax for type uuid: "info.php"'), {
    code,
    constraint_name,
  });

describe('isPgInputSyntaxError', () => {
  it('matches a bare Postgres 22P02', () => {
    expect(isPgInputSyntaxError(pgErr('22P02'))).toBe(true);
  });

  it('matches through the drizzle Failed-query wrapper (cause chain)', () => {
    const wrapped = new Error('Failed query: select …', { cause: pgErr('22P02') });
    expect(isPgInputSyntaxError(wrapped)).toBe(true);
  });

  it('rejects other Postgres codes and non-Postgres errors', () => {
    expect(isPgInputSyntaxError(pgErr('23505'))).toBe(false); // unique violation is a real bug
    expect(isPgInputSyntaxError(new Error('boom'))).toBe(false);
    expect(isPgInputSyntaxError('not an error')).toBe(false);
    expect(isPgInputSyntaxError(null)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('matches a bare Postgres 23505 with constraint', () => {
    expect(isUniqueViolation(pgErr('23505', 'messages_in_mid'), 'messages_in_mid')).toBe(true);
  });

  it('matches through the drizzle Failed-query wrapper (cause chain)', () => {
    // The ingress dedup race: drizzle wraps the PostgresError as
    // DrizzleQueryError — a shallow err.code check misses it and the
    // expected-race return never fires (the production bug).
    const wrapped = new Error('Failed query: insert into "messages" …', {
      cause: pgErr('23505', 'messages_in_mid'),
    });
    expect(isUniqueViolation(wrapped, 'messages_in_mid')).toBe(true);
  });

  it('rejects other constraints and codes', () => {
    expect(isUniqueViolation(pgErr('23505', 'other_idx'), 'messages_in_mid')).toBe(false);
    expect(isUniqueViolation(pgErr('22P02'), 'messages_in_mid')).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
