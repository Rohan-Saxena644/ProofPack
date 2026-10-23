import type { Plan, Action, Observation } from '../core/contracts';
export const fixturePlan: Plan = {
  name: 'Project persistence across a fresh login',
  variables: ['email', 'password', 'project'],
  goals: [
    { instruction: 'Register a new synthetic account.', assertions: [] },
    { instruction: 'Create a project using {{project}}.', assertions: ['created'] },
    { instruction: 'Log out of the account.', assertions: ['logged_out'] },
    {
      instruction: 'Start a fresh browser context with no cookies and navigate to /login.',
      assertions: [],
    },
    { instruction: 'Log in with the same synthetic credentials.', assertions: ['logged_in'] },
    {
      instruction: 'Verify the same project is visible after the fresh login.',
      assertions: ['persisted'],
    },
  ],
  successCriteria: [
    'The project is initially visible.',
    'Logout reaches the login page.',
    'A new browser context logs in successfully.',
    'The same project is still visible.',
  ],
  assertions: [
    {
      id: 'created',
      description: 'New project appears in the workspace',
      kind: 'text_visible',
      expected: '{{project}}',
    },
    {
      id: 'logged_out',
      description: 'Logout returns to the login page',
      kind: 'url_is',
      expected: '/login',
    },
    {
      id: 'logged_in',
      description: 'Fresh session reaches the project workspace',
      kind: 'url_is',
      expected: '/projects',
    },
    {
      id: 'persisted',
      description: 'Project remains visible after a fresh login',
      kind: 'text_visible',
      expected: '{{project}}',
    },
  ],
};
export interface DecisionInput {
  goalIndex: number;
  goal: Plan['goals'][number];
  observation: Observation;
  history: Action[];
  executedSteps?: { action: Action; urlBefore: string; urlAfter: string; locator?: string }[];
  completedAssertions: string[];
  plan: Plan;
}
export function fixtureDecision(input: DecisionInput): Action {
  const { goalIndex: g, observation: o, history: h, goal, completedAssertions } = input;
  const control = (name: string, role?: string) => {
    const c = o.controls.find((c) => c.name === name && (!role || c.role === role));
    if (!c) throw new Error(`Fixture could not resolve ${name} on the observed page`);
    return c.id;
  };
  const done = (): Action => ({
    type: 'complete_goal',
    description: 'Goal completed using recorded evidence',
  });
  if (g === 0 || g === 4) {
    if (new URL(o.url).pathname === '/projects') {
      const assertionId = goal.assertions.find((a) => !completedAssertions.includes(a));
      return assertionId
        ? { type: 'assert', assertionId, description: 'Check the authenticated workspace URL' }
        : done();
    }
    const register = g === 0;
    if (new URL(o.url).pathname !== (register ? '/register' : '/login'))
      return {
        type: 'navigate',
        url: register ? '/register' : '/login',
        description: 'Open the account form',
      };
    if (!h.some((a) => a.type === 'fill' && a.value === '{{email}}'))
      return {
        type: 'fill',
        controlId: control('Email'),
        value: '{{email}}',
        description: 'Enter unique synthetic email',
      };
    if (!h.some((a) => a.type === 'fill' && a.value === '{{password}}'))
      return {
        type: 'fill',
        controlId: control('Password'),
        value: '{{password}}',
        description: 'Enter the secret synthetic password',
      };
    return {
      type: 'click',
      controlId: control(register ? 'Create account' : 'Log in', 'button'),
      description: register ? 'Register the synthetic account' : 'Log in to the account',
    };
  }
  if (g === 1) {
    if (!h.some((a) => a.type === 'fill'))
      return {
        type: 'fill',
        controlId: control('Project name'),
        value: '{{project}}',
        description: 'Name the isolated test project',
      };
    if (!h.some((a) => a.type === 'click'))
      return {
        type: 'click',
        controlId: control('Create project', 'button'),
        description: 'Create the project',
      };
  }
  if (g === 2 && !h.some((a) => a.type === 'click'))
    return {
      type: 'click',
      controlId: control('Log out', 'button'),
      description: 'Log out of LaunchDesk',
    };
  if (g === 3)
    return h.some((a) => a.type === 'fresh_context')
      ? done()
      : {
          type: 'fresh_context',
          description: 'Discard all browser session state and reopen login',
        };
  const assertionId = goal.assertions.find((a) => !completedAssertions.includes(a));
  return assertionId
    ? {
        type: 'assert',
        assertionId,
        description: input.plan.assertions.find((a) => a.id === assertionId)!.description,
      }
    : done();
}
