import {
  contextsFor,
  effortsFor,
  modelLabel,
  modelsFor,
  supportsTuning,
  tuningForModel,
  CONTEXT_TIERS,
  REASONING_EFFORTS,
} from '@/domain/agent-catalogue';
import { launchableAgentProviderSchema } from '@/domain/herdr';

describe('what a model can be asked for', () => {
  it('offers the efforts that model has and no others', () => {
    // The ranges are not the same shape, so a single shared list would offer
    // settings the CLI refuses at startup.
    expect(effortsFor('copilot', 'gpt-5.6-sol')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effortsFor('copilot', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor('copilot', 'gemini-3.6-flash')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('offers nothing for a model with no reasoning setting', () => {
    expect(effortsFor('copilot', 'claude-haiku-4.5')).toEqual([]);
  });

  it('offers nothing until a model is chosen', () => {
    // Which efforts exist depends on the model, so there is no honest list.
    expect(effortsFor('copilot', null)).toEqual([]);
    expect(effortsFor('copilot', 'something-we-do-not-ship')).toEqual([]);
  });

  it('offers a context choice only where there is more than one', () => {
    expect(contextsFor('copilot', 'gpt-5.6-sol')).toEqual(['default', 'long_context']);
    // A single tier is not a choice.
    expect(contextsFor('copilot', 'claude-haiku-4.5')).toEqual([]);
    expect(contextsFor('copilot', 'gpt-5.4-mini')).toEqual([]);
  });

  it('does not read one CLI\u2019s models against another', () => {
    // Two CLIs could ship the same model id with different capabilities, so
    // every lookup is answered for one provider only.
    expect(effortsFor('claude', 'gpt-5.6-sol')).toEqual([]);
    expect(modelLabel('claude', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });
});

describe('the catalogue itself', () => {
  it('covers every CLI the app can launch', () => {
    // A missing entry would be an undefined lookup rather than "not tunable".
    for (const provider of launchableAgentProviderSchema.options) {
      expect(Array.isArray(modelsFor(provider))).toBe(true);
    }
    expect(modelsFor('unknown')).toEqual([]);
  });

  it('only claims a CLI is tunable when it has models to offer', () => {
    expect(supportsTuning('copilot')).toBe(true);
    for (const provider of ['claude', 'codex', 'opencode', 'unknown'] as const) {
      expect(supportsTuning(provider)).toBe(false);
    }
  });

  it('ships only values the bridge will accept', () => {
    for (const provider of launchableAgentProviderSchema.options) {
      for (const model of modelsFor(provider)) {
        for (const effort of model.efforts) {
          expect(REASONING_EFFORTS).toContain(effort);
        }
        for (const context of model.contexts) {
          expect(CONTEXT_TIERS).toContain(context);
        }
        // Every model can run at the standard window.
        expect(model.contexts).toContain('default');
      }
    }
  });

  it('ships no duplicate model ids within a CLI', () => {
    for (const provider of launchableAgentProviderSchema.options) {
      const ids = modelsFor(provider).map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('changing model', () => {
  it('keeps settings the new model still offers', () => {
    expect(
      tuningForModel('copilot', 'gpt-5.6-sol', {
        model: 'gpt-5.5',
        effort: 'max',
        context: 'long_context',
      }),
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'max', context: 'long_context' });
  });

  it('drops settings the new model does not reach', () => {
    // Moving from a model that goes to max onto one that stops at high has to
    // let go of max, or the agent would refuse to start.
    expect(
      tuningForModel('copilot', 'gemini-3.8-flash', {
        model: 'gpt-5.6-sol',
        effort: 'max',
        context: 'long_context',
      }),
    ).toEqual({ model: 'gemini-3.8-flash', effort: null, context: 'long_context' });
  });

  it('drops the context too when the new model has only one window', () => {
    expect(
      tuningForModel('copilot', 'claude-haiku-4.5', {
        model: 'gpt-5.6-sol',
        effort: 'max',
        context: 'long_context',
      }),
    ).toEqual({ model: 'claude-haiku-4.5', effort: null, context: null });
  });

  it('drops everything when the model is cleared back to auto', () => {
    expect(
      tuningForModel('copilot', null, {
        model: 'gpt-5.6-sol',
        effort: 'high',
        context: 'long_context',
      }),
    ).toEqual({ model: null, effort: null, context: null });
  });
});

describe('naming a model', () => {
  it('shows the readable name for one we ship', () => {
    expect(modelLabel('copilot', 'gpt-5.6-sol')).toBe('GPT-5.6 Sol');
  });

  it('shows whatever the agent reported for one we do not', () => {
    // The agent is the authority on what it is running, even if this list is
    // out of date.
    expect(modelLabel('copilot', 'some-new-model')).toBe('some-new-model');
  });

  it('calls no model at all Auto, which is what the CLI does', () => {
    expect(modelLabel('copilot', null)).toBe('Auto');
  });
});
