export const domainErrorCodes = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TENANT_CONTEXT_REQUIRED",
  "TENANT_SCOPE_VIOLATION",
  "ORGANIZATION_SUSPENDED",
  "MEMBERSHIP_SUSPENDED",
  "INVITATION_INVALID",
  "INVITATION_EXPIRED",
  "INVITATION_ALREADY_USED",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE",
  "IMPORT_ROW_FAILED",
  "RATE_LIMITED",
  "CONSENT_REQUIRED",
  "DEPENDENCY_UNAVAILABLE",
  "AI_UNSUPPORTED_CLAIM",
  "INTERNAL_ERROR",
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];
export type ErrorMetadataValue = string | number | boolean | null;

type DomainErrorOptions = Readonly<{
  cause?: unknown;
  code: DomainErrorCode;
  message: string;
  metadata?: Readonly<Record<string, ErrorMetadataValue>>;
  retryable?: boolean;
}>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly metadata: Readonly<Record<string, ErrorMetadataValue>> | undefined;
  override readonly name = "DomainError";
  readonly retryable: boolean;

  constructor(options: DomainErrorOptions) {
    super(options.message, { cause: options.cause });
    this.code = options.code;
    this.metadata = options.metadata;
    this.retryable = options.retryable ?? false;
  }
}
