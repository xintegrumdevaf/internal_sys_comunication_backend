/**
 * Catalogo de errores de negocio (docs/spec/02_STATE_MACHINE.md §5).
 * Todo error hacia el cliente HTTP se mapea a este formato — nunca se
 * filtra un stack trace ni un mensaje crudo de Postgres/n8n.
 */
export type DomainErrorType =
  | "BUSINESS_ERROR"
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "EXTERNAL_SERVICE_ERROR"
  | "AI_ERROR"
  | "UNSUPPORTED"
  | "NOT_FOUND"
  | "AUTHORIZATION_ERROR";

export class DomainError extends Error {
  readonly type: DomainErrorType;
  readonly retryable: boolean;

  constructor(type: DomainErrorType, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "DomainError";
    this.type = type;
    this.retryable = options.retryable ?? false;
  }
}

export function notFound(message: string): DomainError {
  return new DomainError("NOT_FOUND", message);
}

export function validationError(message: string): DomainError {
  return new DomainError("VALIDATION_ERROR", message);
}

export function businessError(message: string): DomainError {
  return new DomainError("BUSINESS_ERROR", message);
}

export function authorizationError(message: string): DomainError {
  return new DomainError("AUTHORIZATION_ERROR", message);
}

export function externalServiceError(message: string, options: { retryable?: boolean } = {}): DomainError {
  return new DomainError("EXTERNAL_SERVICE_ERROR", message, options);
}

