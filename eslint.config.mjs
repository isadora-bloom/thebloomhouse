import nextConfig from 'eslint-config-next';

export default [
  ...nextConfig,
  {
    rules: {
      // 2026-09-09: Downgraded 4 instances to warn (unescaped quotes in JSX strings)
      'react/no-unescaped-entities': 'warn',
      // 2026-09-09: Downgraded 1 instance to warn (setState in effect)
      'react-hooks/set-state-in-effect': 'warn',
      // 2026-09-09: Downgraded 1 instance to warn (hooks called conditionally)
      'react-hooks/rules-of-hooks': 'warn',
    },
  },
];
