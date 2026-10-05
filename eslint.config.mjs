import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // MotionProvider loads animation features lazily; the full `motion.*`
    // components bundle them eagerly and throw under LazyMotion's `strict`.
    // `motion/react` is the same library, but its entry reads `motion` off a
    // namespace import, which stops Turbopack tree-shaking the whole library.
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'framer-motion',
              importNames: ['motion'],
              message: 'Use `m` so animation features stay lazy-loaded.',
            },
            {
              name: 'motion/react',
              message: "Import from 'framer-motion' (see eslint.config.mjs).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
