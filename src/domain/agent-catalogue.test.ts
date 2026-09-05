import {
  contextChoices,
  contextLabel,
  contextsFor,
  effortChoices,
  effortsFor,
  modelLabel,
  modelsFor,
  supportsTuning,
  supportsRetuning,
  tuningForModel,
  CONTEXT_TIERS,
  REASONING_EFFORTS,
} from '@/domain/agent-catalogue';
import { launchableAgentProviderSchema } from '@/domain/herdr';

jest.mock('@/domain/model-catalogues/copilot.json', () => require('./__fixtures__/copilot.json'));

describe('what a model can be asked for', () => {
  it('offers the efforts that model has and no others', () => {
    // Read off the CLI's own picker by stepping each model's range to both
    // ends. They are not the same shape: the GPTs start below low, the Geminis
    // stop at high, and only some reach max.
    expect(effortsFor('copilot', 'gpt-5.6-sol')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effortsFor('copilot', 'gpt-5.5')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(effortsFor('copilot', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor('copilot', 'gemini-3.6-flash')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(effortsFor('copilot', 'claude-opus-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
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
    expect(contextsFor('copilot', 'gpt-5.6-sol').map((o) => o.tier)).toEqual([
      'default',
      'long_context',
    ]);
    // A single window is not a choice.
    expect(contextsFor('copilot', 'claude-haiku-4.5')).toEqual([]);
    expect(contextsFor('copilot', 'gpt-5.4-mini')).toEqual([]);
  });

  it('carries the size each window actually buys', () => {
    // The tier name is what gets sent and means nothing to read; the size is
    // the thing being chosen. Both come from the CLI's own picker.
    expect(contextsFor('copilot', 'gpt-5.6-sol').map(contextLabel)).toEqual([
      '400K',
      '1.1M',
    ]);
    expect(contextsFor('copilot', 'gemini-3.8-flash').map(contextLabel)).toEqual([
      '266K',
      '1.0M',
    ]);
    // Two models on the same family can still differ.
    expect(contextsFor('copilot', 'gpt-5.6-luna').map(contextLabel)).toEqual([
      '328K',
      '1.1M',
    ]);
    expect(contextsFor('copilot', 'grok-4.6').map(contextLabel)).toEqual([
      '328K',
      '628K',
    ]);
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

  it('offers launch configuration for supported CLIs, including defaults before discovery', () => {
    for (const provider of launchableAgentProviderSchema.options) {
      expect(supportsTuning(provider)).toBe(true);
    }
    expect(supportsTuning('unknown')).toBe(false);
  });

  it('does not confuse launch configuration with live retuning support', () => {
    expect(supportsRetuning('copilot')).toBe(true);
    for (const provider of ['claude', 'codex', 'cursor', 'unknown'] as const) {
      expect(supportsRetuning(provider)).toBe(false);
    }
  });

  it('ships only values the bridge will accept', () => {
    for (const provider of launchableAgentProviderSchema.options) {
      for (const model of modelsFor(provider)) {
        for (const effort of model.efforts) {
          expect(REASONING_EFFORTS).toContain(effort);
        }
        for (const context of model.contexts) {
          expect(CONTEXT_TIERS).toContain(context.tier);
          expect(context.size).toMatch(/^\d+(\.\d+)?[KM]$/);
        }
        // A model either offers both windows or has nothing to choose from.
        expect([0, 2]).toContain(model.contexts.length);
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

describe('what is already in force', () => {
  it('shows a window the model does not list, so it is not hidden', () => {
    // A session can be on a long window with no model pinned at all — set
    // before the model was, or never pinned. Leaving it out would show the
    // agent running a default it is not.
    const choices = contextChoices('copilot', null, 'long_context');
    expect(choices.map((option) => option.tier)).toEqual(['long_context']);
    // No model means no size to name it by.
    expect(choices.map(contextLabel)).toEqual(['Long']);
  });

  it('shows an effort the model does not list', () => {
    expect(effortChoices('copilot', null, 'xhigh')).toEqual(['xhigh']);
  });

  it('does not repeat one the model already offers', () => {
    expect(effortChoices('copilot', 'gpt-5.6-sol', 'max')).toEqual(
      effortsFor('copilot', 'gpt-5.6-sol'),
    );
    expect(contextChoices('copilot', 'gpt-5.6-sol', 'long_context')).toEqual(
      contextsFor('copilot', 'gpt-5.6-sol'),
    );
  });

  it('offers only the model\u2019s own list when nothing is in force', () => {
    expect(effortChoices('copilot', 'gemini-3.8-flash', null)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(contextChoices('copilot', 'claude-haiku-4.5', null)).toEqual([]);
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
