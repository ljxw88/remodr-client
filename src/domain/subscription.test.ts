import {
  canAddDevice,
  canStartAgent,
  FREE_TIER_LIMITS,
  getAgentQuota,
  getDeviceQuota,
} from './subscription';

describe('subscription domain', () => {
  describe('free tier rules', () => {
    it('allows up to 1 device on free tier (<= 1 device)', () => {
      expect(canAddDevice(0, false)).toBe(true);
      expect(canAddDevice(1, false)).toBe(false);
      expect(canAddDevice(2, false)).toBe(false);
    });

    it('allows unlimited agent sessions on free tier', () => {
      expect(canStartAgent(0, false)).toBe(true);
      expect(canStartAgent(1, false)).toBe(true);
      expect(canStartAgent(2, false)).toBe(true);
      expect(canStartAgent(5, false)).toBe(true);
    });

    it('formats quota labels accurately for free tier', () => {
      const deviceQuota = getDeviceQuota(1, false);
      expect(deviceQuota.used).toBe(1);
      expect(deviceQuota.limit).toBe(FREE_TIER_LIMITS.maxDevices);
      expect(deviceQuota.isLimitReached).toBe(true);
      expect(deviceQuota.label).toBe('1/1');

      const agentQuota = getAgentQuota(1, false);
      expect(agentQuota.used).toBe(1);
      expect(agentQuota.isLimitReached).toBe(false);
      expect(agentQuota.label).toBe('1 (Unlimited)');
    });
  });

  describe('pro tier rules', () => {
    it('allows unlimited devices and agents on pro tier', () => {
      expect(canAddDevice(5, true)).toBe(true);
      expect(canStartAgent(10, true)).toBe(true);
    });

    it('formats quota labels as unlimited for pro tier', () => {
      const deviceQuota = getDeviceQuota(3, true);
      expect(deviceQuota.isLimitReached).toBe(false);
      expect(deviceQuota.label).toBe('3 (Unlimited)');

      const agentQuota = getAgentQuota(7, true);
      expect(agentQuota.isLimitReached).toBe(false);
      expect(agentQuota.label).toBe('7 (Unlimited)');
    });
  });
});
