import type { Action, Observation } from '../core/contracts';

export function validateProgress(
  action: Action,
  observation: Observation,
  history: Action[],
  previousObservation: string,
) {
  const last = history.at(-1);
  if (
    last &&
    previousObservation === JSON.stringify(observation) &&
    ['navigate', 'fill', 'click', 'select'].includes(action.type) &&
    JSON.stringify(action, ['type', 'controlId', 'value', 'url']) ===
      JSON.stringify(last, ['type', 'controlId', 'value', 'url'])
  )
    throw new Error(
      'The previous identical action did not change the observed page. Choose a different action or complete the goal if its outcome is already established.',
    );
  if (action.type === 'fresh_context' && history.some((h) => h.type === 'fresh_context'))
    throw new Error(
      'This goal already started a fresh context. Continue in the current context or complete the goal.',
    );
  if (action.type === 'click') {
    const control = observation.controls.find((c) => c.id === action.controlId);
    if (
      control?.inputType === 'submit' &&
      control.formId &&
      observation.controls.some(
        (field) => field.formId === control.formId && field.required && !field.filled,
      )
    )
      throw new Error('Required fields in this form are empty. Fill them before submitting.');
  }
}
