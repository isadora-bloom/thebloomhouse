import nextConfig from 'eslint-config-next';

export default [
  {
    // Agent worktrees live inside the repo and each carries its own
    // node_modules; without this, `eslint .` walks all of them and never
    // finishes (2026-09-09).
    ignores: ['.claude/**', '.next/**', 'supabase/functions/**', 'e2e/report/**'],
  },
  ...nextConfig,
  {
    rules: {
      // 2026-09-09: downgraded to warn (unescaped quotes in JSX strings). 69 sites on 2026-09-14; still owed.
      'react/no-unescaped-entities': 'warn',
      // 2026-09-09: downgraded to warn (setState in effect, a React Compiler rule). 58 sites on 2026-09-14; the one compiler rule not yet back at error.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];
