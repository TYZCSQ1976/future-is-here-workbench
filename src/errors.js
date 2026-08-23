class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = options.expose !== false;
    this.cause = options.cause;
  }
}

function asAppError(error) {
  if (error instanceof AppError) return error;
  if (error && error.userMessage) {
    return new AppError(502, error.code || 'PROVIDER_FAILED', error.userMessage, { cause: error });
  }
  return new AppError(500, 'INTERNAL_ERROR', '服务器内部错误', { expose: true, cause: error });
}

module.exports = { AppError, asAppError };
