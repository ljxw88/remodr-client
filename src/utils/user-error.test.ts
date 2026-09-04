import { RemoteOperationError } from '@/domain/errors';
import { toUserMessage } from '@/utils/user-error';

describe('messages shown to the user', () => {
  it('explains a blocked agent instead of naming the pane holding it', () => {
    // Herdr answers in terms of the pane it manages. "w2:p4" is not something
    // the app ever shows, and the app calls this state "Needs input".
    const message = toUserMessage(
      new RemoteOperationError({
        type: 'unknown',
        message: 'agent w2:p4 is blocked and requires interactive input',
      }),
    );
    expect(message).toBe('This agent is waiting on a question of its own. Answer that first.');
  });

  it('explains it however the refusal reaches us', () => {
    const message = toUserMessage(
      new Error('agent w9:p1 is blocked and requires interactive input'),
    );
    expect(message).toBe('This agent is waiting on a question of its own. Answer that first.');
  });

  it('leaves an unrelated remote message alone', () => {
    const message = toUserMessage(
      new RemoteOperationError({ type: 'network', message: 'Connection refused.' }),
    );
    expect(message).toBe('Connection refused.');
  });

  it('keeps unwrapping a native rejection to its cause', () => {
    const message = toUserMessage(
      new Error("Call to function 'x' has been rejected.\n→ Caused by: no such file"),
    );
    expect(message).toBe('no such file');
  });
});
