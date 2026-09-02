import { RemoteOperationError } from '@/domain/errors';
import { HostNotFoundError } from '@/domain/hosts';
import { ZodError } from 'zod';

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
    return error.message;
  }

  return 'Something went wrong.';
}
