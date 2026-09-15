import {
  answerBodyFor,
  answerOptions,
  multiQuestionAnswerBody,
} from '@/features/agents/human-request';
import type { HumanRequest } from '@/domain/herdr';

function request(overrides: Partial<HumanRequest>): HumanRequest {
  return {
    id: 'req-1',
    kind: 'choice',
    question: 'Which database?',
    options: [],
    allowCustomAnswer: true,
    multiSelect: false,
    ...overrides,
  };
}

describe('answers offered as buttons', () => {
  it('offers the options the agent sent', () => {
    const options = answerOptions(
      request({
        options: [
          { id: 'pg', label: 'PostgreSQL' },
          { id: 'sqlite', label: 'SQLite' },
        ],
      }),
    );
    expect(options.map((option) => option.label)).toEqual(['PostgreSQL', 'SQLite']);
  });

  it('supplies yes and no for a confirmation, which arrives with no options', () => {
    // The bridge turns a boolean field into a confirmation and sends nothing
    // to tap, so without this the agent would sit blocked behind an empty bar.
    const options = answerOptions(request({ kind: 'confirmation' }));
    expect(options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('supplies yes and no for a permission request too', () => {
    const options = answerOptions(request({ kind: 'permission' }));
    expect(options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('offers the native permission decisions when details are available', () => {
    const options = answerOptions(request({
      kind: 'permission',
      origin: 'api',
      permission: { permission: 'bash', patterns: ['git status'], always: [] },
    }));
    expect(options.map((option) => option.label)).toEqual([
      'Allow once',
      'Always allow',
      'Reject',
    ]);
  });

  it('offers nothing for a question that wants prose', () => {
    // The composer is already the answer box; a bar with no buttons in it
    // would only take room away from the transcript.
    expect(answerOptions(request({ kind: 'text' }))).toEqual([]);
  });

  it('offers nothing for a choice that arrived without any choices', () => {
    expect(answerOptions(request({ kind: 'choice' }))).toEqual([]);
  });

  it('prefers real options over the supplied pair', () => {
    const options = answerOptions(
      request({ kind: 'confirmation', options: [{ id: 'ok', label: 'Go ahead' }] }),
    );
    expect(options.map((option) => option.label)).toEqual(['Go ahead']);
  });
});

describe('the answer sent back', () => {
  it('sends the ids of real options so the bridge can resolve their labels', () => {
    const body = answerBodyFor(
      request({ options: [{ id: 'pg', label: 'PostgreSQL' }] }),
      ['pg'],
    );
    expect(body).toEqual({ selectedOptionIds: ['pg'] });
  });

  it('sends a supplied answer as text, since the bridge cannot resolve it', () => {
    // 'Yes' is not an option id the agent knows about. Sent as an id it would
    // resolve to nothing and be rejected as an empty answer.
    const body = answerBodyFor(request({ kind: 'confirmation' }), ['Yes']);
    expect(body).toEqual({ customText: 'Yes' });
  });

  it('joins several picks the way the bridge joins resolved labels', () => {
    const body = answerBodyFor(request({ kind: 'confirmation', multiSelect: true }), [
      'Yes',
      'No',
    ]);
    expect(body).toEqual({ customText: 'Yes, No' });
  });

  it('keeps the order the answers were picked in', () => {
    const body = answerBodyFor(
      request({
        multiSelect: true,
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      }),
      ['b', 'a'],
    );
    expect(body).toEqual({ selectedOptionIds: ['b', 'a'] });
  });

  it('pins API-origin answers to their request transport', () => {
    const body = answerBodyFor(
      request({
        origin: 'api',
        options: [{ id: 'pg', label: 'PostgreSQL' }],
      }),
      ['pg'],
    );
    expect(body).toEqual({ selectedOptionIds: ['pg'], requestOrigin: 'api' });
  });

  it('uses the native permission reply vocabulary', () => {
    const body = answerBodyFor(
      request({
        kind: 'permission',
        origin: 'api',
        permission: { permission: 'bash', patterns: ['git status'], always: [] },
      }),
      ['always'],
    );
    expect(body).toEqual({ permissionReply: 'always', requestOrigin: 'api' });
  });

  it('preserves the order of a native multi-question answer', () => {
    const body = multiQuestionAnswerBody(
      request({
        origin: 'api',
        questions: [
          {
            header: 'Database',
            question: 'Which database?',
            options: [{ id: 'pg', label: 'PostgreSQL' }],
            allowCustomAnswer: false,
            multiSelect: false,
          },
          {
            header: 'Region',
            question: 'Which regions?',
            options: [
              { id: 'eu', label: 'Europe' },
              { id: 'us', label: 'United States' },
            ],
            allowCustomAnswer: true,
            multiSelect: true,
          },
        ],
      }),
      [
        { selectedOptionIds: ['pg'] },
        { selectedOptionIds: ['eu'], customText: 'Asia Pacific' },
      ],
    );
    expect(body).toEqual({
      answers: [
        { selectedOptionIds: ['pg'] },
        { selectedOptionIds: ['eu'], customText: 'Asia Pacific' },
      ],
      requestOrigin: 'api',
    });
  });

  it('rejects incomplete native multi-question answers', () => {
    expect(() => multiQuestionAnswerBody(
      request({
        origin: 'api',
        questions: [
          {
            question: 'One?',
            options: [],
            allowCustomAnswer: true,
            multiSelect: false,
          },
          {
            question: 'Two?',
            options: [],
            allowCustomAnswer: true,
            multiSelect: false,
          },
        ],
      }),
      [{ customText: 'Only one' }],
    )).toThrow('Every question needs an answer.');
  });
});
