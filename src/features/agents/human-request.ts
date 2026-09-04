import type { HumanOption, HumanRequest } from '@/domain/herdr';

/**
 * The bridge marks a yes/no question as a `confirmation` and sends no options
 * with it, so the two answers are supplied here.
 */
const CONFIRMATION_OPTIONS: HumanOption[] = [
  { id: 'Yes', label: 'Yes' },
  { id: 'No', label: 'No' },
];

/**
 * The answers to offer as buttons.
 *
 * Empty means there is nothing worth pinning above the composer: either the
 * agent wants prose, or it sent a choice with no choices in it.
 */
export function answerOptions(request: HumanRequest): HumanOption[] {
  if (request.options.length > 0) {
    return request.options;
  }
  if (request.kind === 'confirmation' || request.kind === 'permission') {
    return CONFIRMATION_OPTIONS;
  }
  return [];
}

export type AnswerBody = {
  selectedOptionIds?: string[];
  customText?: string;
};

/**
 * Turns the tapped answers into a body the bridge understands.
 *
 * The bridge resolves an option id back to its label and sends that as the
 * prompt, which only works for options it knows about. Synthesised yes/no
 * answers have no counterpart on the far side, so their labels go over as
 * text instead — the same thing the user could have typed.
 */
export function answerBodyFor(request: HumanRequest, optionIds: string[]): AnswerBody {
  if (request.options.length > 0) {
    return { selectedOptionIds: optionIds };
  }
  return { customText: optionIds.join(', ') };
}
