import { RemoteOperationError } from '@/domain/errors';
import { HostNotFoundError } from '@/domain/hosts';
import { ZodError } from 'zod';

/**
 * Expo modules wrap a native rejection as
 * `Call to function 'X' has been rejected.\n→ Caused by: <reason>`.
 * Only the reason means anything to someone using the app.
 */
function unwrapNativeRejection(message: string): string {
  const cause = message.split(/→\s*Caused by:\s*/).pop()?.trim();
  return cause && cause !== message.trim() ? cause : message;
}

export function toUserMessage(error: unknown): string {
  if (error instanceof HostNotFoundError) {
    return 'That server is no longer saved.';
  }

  if (error instanceof RemoteOperationError) {
    return error.remoteError.message;
  }

  if (error instanceof ZodError) {
    return 'Invalid server details.';
  }

  if (error instanceof Error && error.message) {
    return unwrapNativeRejection(error.message);
  }

  return 'Something went wrong.';
}
