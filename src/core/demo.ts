export const demoScenario = {
  brief:
    'Register a new account, create a project named Moonbase, log out, start a fresh browser session, log back in, and verify that Moonbase still exists. LaunchDesk public routes are /register for registration, /projects for the authenticated project workspace, and /login for login. Interact through the browser UI.',
  expected:
    'The new project appears after creation at /projects. Logout reaches the login page at /login. After login in a fresh browser session, /projects displays the same project.',
};
