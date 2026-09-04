import {
  contextsFor,
  effortsFor,
  keepContext,
  keepEffort,
  modelLabel,
  modelsFor,
  COPILOT_MODELS,
  REASONING_EFFORTS,
} from '@/domain/agent-tuning';

describe('what a model can be asked for', () => {
  it('offers the efforts that model has and no others', () => {
    // The ranges are not the same shape, so a single shared list would offer
    // settings the CLI refuses at startup.
    expect(effortsFor('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor('gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor('gemini-3.6-flash')).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('offers nothing for a model with no reasoning setting', () => {
    expect(effortsFor('claude-haiku-4.5')).toEqual([]);
  });

  it('offers nothing until a model is chosen', () => {
    // Which efforts exist depends on the model, so there is no honest list.
    expect(effortsFor(null)).toEqual([]);
    expect(effortsFor('something-we-do-not-ship')).toEqual([]);
  });

  it('offers a context choice only where there is more than one', () => {
    expect(contextsFor('gpt-5.6-sol')).toEqual(['default', 'long_context']);
    // A single tier is not a choice.
    expect(contextsFor('claude-haiku-4.5')).toEqual([]);
    expect(contextsFor('gpt-5.4-mini')).toEqual([]);
  });

  it('every shipped effort is one the bridge will accept', () => {
    for (const model of COPILOT_MODELS) {
      for (const effort of model.efforts) {
        expect(REASONING_EFFORTS).toContain(effort);
      }
    }
  });

  it('every shipped model offers the standard context', () => {
    for (const model of COPILOT_MODELS) {
      expect(model.contexts).toContain('default');
    }
  });

  it('ships no duplicate model ids', () => {
    const ids = COPILOT_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('changing model', () => {
  it('keeps a setting the new model still offers', () => {
    expect(keepEffort('gpt-5.6-sol', 'max')).toBe('max');
    expect(keepContext('gpt-5.6-sol', 'long_context')).toBe('long_context');
  });

  it('drops a setting the new model does not reach', () => {
    // Moving from a model that goes to max onto one that stops at high has to
    // let go of max, or the agent would refuse to start.
    expect(keepEffort('gemini-3.8-flash', 'max')).toBeNull();
    expect(keepContext('claude-haiku-4.5', 'long_context')).toBeNull();
  });

  it('drops everything when the model is cleared back to auto', () => {
    expect(keepEffort(null, 'high')).toBeNull();
    expect(keepContext(null, 'long_context')).toBeNull();
  });
});

describe('naming a model', () => {
  it('shows the readable name for one we ship', () => {
    expect(modelLabel('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
  });

  it('shows whatever the agent reported for one we do not', () => {
    // The agent is the authority on what it is running, even if this list is
    // out of date.
    expect(modelLabel('some-new-model')).toBe('some-new-model');
  });

  it('calls no model at all Auto, which is what the CLI does', () => {
    expect(modelLabel(null)).toBe('Auto');
  });
});

describe('which providers can be tuned', () => {
  it('offers models for copilot only', () => {
    expect(modelsFor('copilot').length).toBeGreaterThan(0);
    expect(modelsFor('claude')).toEqual([]);
    expect(modelsFor('codex')).toEqual([]);
  });
});
