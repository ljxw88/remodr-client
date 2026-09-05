import { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';
import { getRemoteCoreNativeModule } from '@/services/native-remote-client';

jest.mock('@/services/native-remote-client', () => ({ getRemoteCoreNativeModule: jest.fn() }));

describe('bridge transport generation and request identity', () => {
  const hello = JSON.stringify({
    protocol: 1, type: 'hello', bridgeVersion: '0.2.0', herdrVersion: 'test',
    herdrProtocol: 20, capabilities: { durableCommands: true },
  });
  let native: {
    addListener: jest.Mock; startHerdrBridge: jest.Mock; stopHerdrBridge: jest.Mock; requestHerdrBridge: jest.Mock;
  };
  beforeEach(() => {
    native = {
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      startHerdrBridge: jest.fn(async () => ({ bridgeId: 'bridge-1', hello })),
      stopHerdrBridge: jest.fn(async () => undefined),
      requestHerdrBridge: jest.fn(async (_bridge: string, raw: string) => {
        const request = JSON.parse(raw);
        return JSON.stringify({ protocol: 1, id: request.id, type: 'response', ok: true, payload: {} });
      }),
    };
    jest.mocked(getRemoteCoreNativeModule).mockReturnValue(native as unknown as ReturnType<typeof getRemoteCoreNativeModule>);
  });
  it('preserves command identity while assigning a new correlation ID on each attempt', async () => {
    const transport = new HerdrBridgeTransport();
    await transport.start('ssh-1');
    await transport.request('agent.send_message', { text: 'hello' }, 'command-1');
    await transport.request('agent.send_message', { text: 'hello' }, 'command-1');
    const requests = native.requestHerdrBridge.mock.calls.map((call) => JSON.parse(call[1]));
    expect(requests.map((request) => request.commandId)).toEqual(['command-1', 'command-1']);
    expect(requests[0].id).not.toBe(requests[1].id);
    await transport.stop();
  });
  it('disposes a native bridge that finishes starting after cancellation', async () => {
    let finish!: (value: { bridgeId: string; hello: string }) => void;
    native.startHerdrBridge.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const transport = new HerdrBridgeTransport();
    const pending = transport.start('ssh-1');
    await Promise.resolve();
    await transport.stop();
    finish({ bridgeId: 'bridge-1', hello });
    await expect(pending).rejects.toMatchObject({ code: 'ERR_BRIDGE_CLOSED' });
    expect(native.stopHerdrBridge).toHaveBeenCalledWith('bridge-1');
  });
  it('rejects a response with the wrong request ID', async () => {
    native.requestHerdrBridge.mockResolvedValue(JSON.stringify({
      protocol: 1, id: 'wrong', type: 'response', ok: true, payload: {},
    }));
    const transport = new HerdrBridgeTransport();
    await transport.start('ssh');
    await expect(transport.request('runtime.snapshot', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('preserves a fatal journal error instead of retrying it as transport closure', async () => {
    native.startHerdrBridge.mockResolvedValue({
      bridgeId: 'bridge-1',
      hello: JSON.stringify({ ...JSON.parse(hello), fatal: true, runtimeReady: false,
        error: { code: 'COMMAND_STORE_UNAVAILABLE', message: 'Journal needs repair' } }),
    });
    const transport = new HerdrBridgeTransport();
    await expect(transport.start('ssh')).rejects.toMatchObject({ code: 'COMMAND_STORE_UNAVAILABLE' });
    expect(native.stopHerdrBridge).toHaveBeenCalledWith('bridge-1');
  });
});
