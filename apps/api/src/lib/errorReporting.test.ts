import { describe, expect, it } from 'vitest';
import { isPgInputSyntaxError } from './errorReporting.js';

const pgErr = (code: string) =>
  Object.assign(new Error('invalid input syntax for type uuid: "info.php"'), { code });

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
