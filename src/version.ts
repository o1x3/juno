import pkg from '../package.json' with { type: 'json' };

declare const __JUNO_VERSION__: string | undefined;

export const VERSION: string =
  typeof __JUNO_VERSION__ === 'string' && __JUNO_VERSION__.length > 0
    ? __JUNO_VERSION__
    : (pkg as { version: string }).version;
