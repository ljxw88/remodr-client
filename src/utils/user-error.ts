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

/**
 * Herdr refuses to prompt an agent that is waiting at its own dialog, and says
 * so in terms of the pane it manages. Neither the pane id nor the word
 * "interactive" means anything from the app, where the same state reads as
 * "Needs input".
 */
const AGENT_BLOCKED = /\bis blocked and requires interactive input\b/;

function rewriteAgentControlMessage(message: string): string {
  return AGENT_BLOCKED.test(message)
    ? 'This agent is waiting on a question of its own. Answer that first.'
    : message;
}

export function toUserMessage(error: unknown): string {
  if (error instanceof HostNotFoundError) {
    return 'That server is no longer saved.';
  }

  if (error instanceof RemoteOperationError) {
    return rewriteAgentControlMessage(error.remoteError.message);
  }

  if (error instanceof ZodError) {
    return 'Invalid server details.';
  }

  if (error instanceof Error && error.message) {
    return rewriteAgentControlMessage(unwrapNativeRejection(error.message));
  }

  return 'Something went wrong.';
}
