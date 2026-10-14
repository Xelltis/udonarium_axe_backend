import { AppError } from '../../../src/http/errors/app-error.js';

describe('AppError', () => {
  it('carries code, status, message, and name', () => {
    const err = new AppError('VALIDATION_FAILED', 400, 'bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad input');
    expect(err.name).toBe('AppError');
  });
});
