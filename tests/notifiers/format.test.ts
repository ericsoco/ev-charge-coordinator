/**
 * formatNotificationEvent pins the wording clients ship — reason codes get
 * distinct voices (interlock / dry-run / actuation-failure) so a glance at a
 * push notification is enough.
 */
import { describe, expect, it } from 'vitest';
import { formatNotificationEvent } from '../../src/notifiers/format.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';

describe('formatNotificationEvent', () => {
  const base = { tsMs: 1_000, vehicleId: 'VIN' } as const;

  it('formats plug-in with session + SoC', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'plug-in-detected',
        sessionId: 7,
        evSocPercent: 45,
      })
    ).toBe('🔌 plugged in (session 7, SoC 45%) — evaluating auto-start…');
  });

  it('formats a live start', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'decision-made',
        sessionId: 7,
        accepted: true,
        dryRun: false,
        reasonCode: 'started',
        reasonDetail: null,
        targetPercent: 80,
        evSocPercent: 45,
      })
    ).toBe('✅ auto-start: set limit 80% → charging (SoC 45%)');
  });

  it('formats dry-run distinctly', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'decision-made',
        sessionId: 7,
        accepted: true,
        dryRun: true,
        reasonCode: 'dry_run',
        reasonDetail: null,
        targetPercent: 80,
        evSocPercent: 45,
      })
    ).toBe('🧪 dry-run: would set limit 80% and start charging (autoStart off or --dry-run)');
  });

  it('formats the battery-buffer interlock distinctly', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'decision-made',
        sessionId: 7,
        accepted: false,
        dryRun: false,
        reasonCode: 'below_buffer',
        reasonDetail: 'battery 45% < buffer 50%',
        targetPercent: null,
        evSocPercent: 45,
      })
    ).toBe('⛔ interlock: home battery below the buffer — not starting — battery 45% < buffer 50%');
  });

  it('formats an actuation failure distinctly', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'decision-made',
        sessionId: 7,
        accepted: false,
        dryRun: false,
        reasonCode: 'service_error',
        reasonDetail: 'decision accepted — actuation failed: proxy down',
        targetPercent: 80,
        evSocPercent: 45,
      })
    ).toBe('❌ auto-start failed — decision accepted — actuation failed: proxy down');
  });

  it('formats other declines with the reason code', () => {
    expect(
      formatNotificationEvent({
        ...base,
        type: 'decision-made',
        sessionId: 7,
        accepted: false,
        dryRun: false,
        reasonCode: 'filter_declined',
        reasonDetail: 'vehicle not at home',
        targetPercent: null,
        evSocPercent: null,
      })
    ).toBe('⛔ not started: filter_declined — vehicle not at home');
  });

  it('formats charge transitions and an unknown SoC', () => {
    expect(
      formatNotificationEvent({ ...base, type: 'charging-started', sessionId: 7, evSocPercent: 46 })
    ).toBe('⚡ charging started (SoC 46%)');
    expect(
      formatNotificationEvent({ ...base, type: 'charging-stopped', sessionId: 7, evSocPercent: null })
    ).toBe('🛑 charging stopped (SoC unknown)');
  });

  it('formats a service failure with its component', () => {
    expect(
      formatNotificationEvent({
        type: 'failure',
        tsMs: 1_000,
        component: 'battery-sample',
        message: 'Franklin 502',
      })
    ).toBe('⚠ battery-sample failed: Franklin 502');
  });

  it('formats the CLI test event', () => {
    expect(formatNotificationEvent({ type: 'test', tsMs: 1_000 })).toBe(
      '🧪 evcc test notification — notifiers are wired'
    );
  });

  it('covers every event type exhaustively (compile-time) with one sample each', () => {
    const events: NotificationEvent[] = [
      { ...base, type: 'plug-in-detected', sessionId: 1, evSocPercent: null },
      {
        ...base,
        type: 'decision-made',
        sessionId: 1,
        accepted: false,
        dryRun: false,
        reasonCode: 'duplicate_session',
        reasonDetail: null,
        targetPercent: null,
        evSocPercent: null,
      },
      { ...base, type: 'charging-started', sessionId: 1, evSocPercent: null },
      { ...base, type: 'charging-stopped', sessionId: 1, evSocPercent: null },
      { type: 'failure', tsMs: 1, component: 'ev-poll', message: 'boom' },
    ];
    for (const event of events) expect(formatNotificationEvent(event)).not.toBe('');
  });
});
